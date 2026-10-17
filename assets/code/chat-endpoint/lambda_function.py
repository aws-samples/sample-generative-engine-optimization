# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""
GEO Demo - On-Site Concierge Chat WORKER (async request/poll)
=============================================================
Long-running worker that invokes the AgentCore MANAGED HARNESS (geo-concierge)
and writes the result back to the chat jobs DynamoDB table. It is invoked
ASYNCHRONOUSLY (lambda InvocationType='Event') by the submit endpoint — NOT
behind API Gateway — because the agent loop runs ~49s, well past the API
Gateway hard 29s integration timeout (and Lambda Function URLs are blocked by
an account guardrail). The browser polls `GET /chat/{jobId}` for the result.

Why this exists:
  The browser cannot call the harness directly (no public HTTP interface, and
  we must never expose AWS credentials client-side). The submit/worker/poll
  trio is the only public, unauthenticated route in the demo. It is DISTINCT
  from the IAM-secured data API (api-handler): that one is agent-to-agent
  (SigV4); this one is browser-to-server for the on-site widget.

IMPORTANT -- managed harness invoke contract (verified against the AgentCore
APIReference):
  * A managed harness is invoked with `invoke_harness` on the DATA-PLANE client
    `bedrock-agentcore` -- NOT `invoke_agent_runtime` (that is for custom
    code-defined runtimes, and raises ValidationException on a harness).
  * The resource is the HARNESS ARN (arn:...:harness/<name-suffix>). This is a
    DISTINCT, service-assigned ARN -- NOT the runtime ARN with `runtime/`
    textually swapped for `harness/` (they carry different ids). Get it from the
    AiStack `HarnessArn` output (or `bedrock-agentcore list-harnesses`).
  * Input is a `messages` array (Bedrock Converse-style), not a {"prompt": ...} blob.
  * The response is an EventStream in response["stream"]; the reply text arrives
    in `contentBlockDelta.delta.text` events.
  * IAM: the execution role needs BOTH bedrock-agentcore:InvokeHarness AND
    bedrock-agentcore:InvokeAgentRuntime on the harness ARN.

Worker contract:
  * Event (direct async invoke): {jobId, message, sessionId}.
  * On success: UpdateItem {status:'DONE', reply, stopReason, finishedAt}.
  * On failure: UpdateItem {status:'ERROR', error, finishedAt}.

Env vars:
  HARNESS_ARN       ARN of the geo-concierge harness (arn:...:harness/<name-suffix>).
                    This is a distinct service-assigned ARN; take it from the
                    AiStack `HarnessArn` output, not by editing the runtime ARN.
  JOBS_TABLE        DynamoDB table name for the chat jobs store.
  HARNESS_QUALIFIER Optional endpoint qualifier; omit for DEFAULT.
"""
import logging
import os
import time
import uuid
from datetime import datetime
from zoneinfo import ZoneInfo

import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Generic, non-sensitive message surfaced to the browser (via the poll endpoint)
# when the agent fails. Real exception detail is logged to CloudWatch only.
GENERIC_ERROR = "The concierge is unavailable right now. Please try again."

HARNESS_ARN = os.environ["HARNESS_ARN"]
JOBS_TABLE = os.environ["JOBS_TABLE"]
HARNESS_QUALIFIER = os.environ.get("HARNESS_QUALIFIER", "")

# AgentCore data-plane client (invokes the managed harness).
_agentcore = boto3.client("bedrock-agentcore")
_table = boto3.resource("dynamodb").Table(JOBS_TABLE)


class AgentError(Exception):
    """Raised when the harness invoke or stream read fails."""


def _normalize_session_id(session_id):
    """runtimeSessionId must be >= 33 chars (AgentCore requirement)."""
    session_id = session_id or f"onsite-{uuid.uuid4().hex}-{uuid.uuid4().hex}"
    if len(session_id) < 33:
        session_id = (session_id + "-" + uuid.uuid4().hex)[:64]
    return session_id


def run_agent(message, session_id):
    """Invoke the managed harness and accumulate the streamed reply.

    Returns ``(reply_text, stop_reason)``. Raises :class:`AgentError` on any
    harness/stream failure. This is the proven harness-invoke + stream-read
    logic, kept intact from the original synchronous endpoint.
    """
    session_id = _normalize_session_id(session_id)

    # Anchor relative dates ("this weekend", "tonight") to a known current date.
    # The harness has no reliable notion of "today", so without this it guesses
    # (it resolved "this weekend" to a wrong, past date in testing). Prepend the
    # current date in the demo's timezone so the model's date math is deterministic.
    today = datetime.now(ZoneInfo("America/Chicago")).strftime("%A, %B %d, %Y")
    dated_message = f"(For reference, today is {today}.)\n\n{message}"

    # Invoke the MANAGED HARNESS. messages is a Converse-style array.
    kwargs = {
        "harnessArn": HARNESS_ARN,
        "runtimeSessionId": session_id,
        "messages": [{"role": "user", "content": [{"text": dated_message}]}],
    }
    if HARNESS_QUALIFIER:
        kwargs["qualifier"] = HARNESS_QUALIFIER

    try:
        resp = _agentcore.invoke_harness(**kwargs)
    except Exception as exc:
        raise AgentError(f"agent_invoke_failed: {str(exc)[:300]}") from exc

    # Response is an EventStream in resp["stream"]. Accumulate the streamed text
    # from contentBlockDelta events; capture stopReason/errors.
    reply_parts = []
    stop_reason = None
    try:
        for ev in resp["stream"]:
            if "contentBlockDelta" in ev:
                delta = ev["contentBlockDelta"].get("delta", {})
                if "text" in delta:
                    reply_parts.append(delta["text"])
            elif "messageStop" in ev:
                stop_reason = ev["messageStop"].get("stopReason")
            elif "validationException" in ev:
                raise AgentError(f"validation_exception: {str(ev['validationException'])[:300]}")
            elif "runtimeClientError" in ev:
                raise AgentError(f"runtime_client_error: {str(ev['runtimeClientError'])[:300]}")
            elif "internalServerException" in ev:
                raise AgentError("internal_server_exception: transient error")
    except AgentError:
        raise
    except Exception as exc:
        raise AgentError(f"stream_read_failed: {str(exc)[:300]}") from exc

    reply_text = "".join(reply_parts).strip() or "I couldn't find an answer for that just now."
    return reply_text, stop_reason


def _mark_error(job_id, now=None):
    """Best-effort: set the job to ERROR with the generic message.

    Conditional on the job NOT already being DONE, so a late failure signal can
    never clobber a reply that already landed. Best-effort and non-fatal.
    """
    if not job_id:
        return
    try:
        _table.update_item(
            Key={"jobId": job_id},
            UpdateExpression="SET #s = :s, #e = :e, finishedAt = :f",
            ConditionExpression="attribute_not_exists(#s) OR #s <> :done",
            ExpressionAttributeNames={"#s": "status", "#e": "error"},
            ExpressionAttributeValues={
                ":s": "ERROR",
                ":e": GENERIC_ERROR,
                ":f": now if now is not None else int(time.time()),
                ":done": "DONE",
            },
        )
    except Exception:
        # Includes ConditionalCheckFailedException (job already DONE) and any
        # transient write error. Log and move on; must not propagate.
        logger.warning("Could not mark job %s ERROR (may already be DONE)", job_id)


def handler(event, context):
    """Async worker entry point. Event: {jobId, message, sessionId}.

    Records in-invocation failures itself (try/except -> job ERROR). DEMO
    LIMITATION: a failure that kills the invocation outright (crash/timeout/OOM)
    leaves the job PENDING until its TTL — a production build would add an
    on-failure destination to mark it ERROR (see ConciergeChatStack / docs).
    """
    job_id = event["jobId"]
    message = (event.get("message") or "").strip()
    session_id = event.get("sessionId")
    now = int(time.time())

    try:
        reply_text, stop_reason = run_agent(message, session_id)
    except Exception:
        # Log the real detail to CloudWatch; never surface str(exc) to the
        # browser (this is a public, unauthenticated endpoint).
        logger.exception("Agent run failed for job %s", job_id)
        _mark_error(job_id, now)
        return {"jobId": job_id, "status": "ERROR"}

    _table.update_item(
        Key={"jobId": job_id},
        UpdateExpression="SET #s = :s, reply = :r, stopReason = :sr, finishedAt = :f",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={
            ":s": "DONE",
            ":r": reply_text,
            ":sr": stop_reason,
            ":f": now,
        },
    )
    return {"jobId": job_id, "status": "DONE"}
