"""
GEO Demo - On-Site Concierge Chat Endpoint
===========================================
Thin, PUBLIC HTTPS endpoint that a browser chat widget calls. It invokes the
AgentCore MANAGED HARNESS (geo-concierge) server-side and returns the reply.

Why this exists:
  The browser cannot call the harness directly (no public HTTP interface, and
  we must never expose AWS credentials client-side). This Lambda is the only
  public, unauthenticated route in the demo. It is DISTINCT from the IAM-secured
  data API (api-handler): that one is agent-to-agent (SigV4); this one is
  browser-to-server for the on-site widget.

IMPORTANT -- managed harness invoke contract (verified against the AgentCore
APIReference):
  * A managed harness is invoked with `invoke_harness` on the DATA-PLANE client
    `bedrock-agentcore` -- NOT `invoke_agent_runtime` (that is for custom
    code-defined runtimes, and raises ValidationException on a harness).
  * The resource is the HARNESS ARN (arn:...:harness/<name-suffix>), which is the
    runtime ARN with `runtime/` swapped for `harness/`.
  * Input is a `messages` array (Bedrock Converse-style), not a {"prompt": ...} blob.
  * The response is an EventStream in response["stream"]; the reply text arrives
    in `contentBlockDelta.delta.text` events.
  * IAM: the execution role needs BOTH bedrock-agentcore:InvokeHarness AND
    bedrock-agentcore:InvokeAgentRuntime on the harness ARN.

Security posture (keep it tight -- this route is public):
  * CORS locked to the site origin (ALLOWED_ORIGIN env var).
  * Message length capped; basic input validation.
  * Intended to sit behind an API Gateway usage plan / throttle.
  * Stateless single-turn Q&A (200-level). Memory/identity/guardrails are
    the agentic (Blog 2) layer.

Env vars:
  HARNESS_ARN       ARN of the geo-concierge harness (arn:...:harness/<name-suffix>).
                    If you only have the runtime ARN, swap `runtime/`->`harness/`.
  ALLOWED_ORIGIN    Exact browser origin allowed for CORS
                    (e.g. https://d33b4fqje003hr.cloudfront.net).
  MAX_MESSAGE_CHARS Optional; default 500.
  HARNESS_QUALIFIER Optional endpoint qualifier; omit for DEFAULT.
"""
import json
import os
import uuid

import boto3

HARNESS_ARN = os.environ["HARNESS_ARN"]
ALLOWED_ORIGIN = os.environ.get("ALLOWED_ORIGIN", "*")
MAX_MESSAGE_CHARS = int(os.environ.get("MAX_MESSAGE_CHARS", "500"))
HARNESS_QUALIFIER = os.environ.get("HARNESS_QUALIFIER", "")

# AgentCore data-plane client (invokes the managed harness).
_agentcore = boto3.client("bedrock-agentcore")


def _cors_headers():
    return {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST,OPTIONS",
    }


def _resp(status, body):
    return {"statusCode": status, "headers": _cors_headers(), "body": json.dumps(body)}


def handler(event, context):
    # CORS preflight
    method = (event.get("requestContext", {})
              .get("http", {}).get("method")) or event.get("httpMethod")
    if method == "OPTIONS":
        return _resp(200, {"ok": True})

    # Parse + validate the incoming message
    try:
        payload = json.loads(event.get("body") or "{}")
    except (ValueError, TypeError):
        return _resp(400, {"error": "invalid_json",
                           "message": "Request body must be valid JSON."})

    message = (payload.get("message") or "").strip()
    if not message:
        return _resp(400, {"error": "empty_message",
                           "message": "Provide a non-empty 'message'."})
    if len(message) > MAX_MESSAGE_CHARS:
        return _resp(400, {"error": "message_too_long",
                           "message": f"Message exceeds {MAX_MESSAGE_CHARS} characters."})

    # runtimeSessionId must be >= 33 chars (AgentCore requirement). Reuse the
    # same id across turns to continue a session; here each request is stateless.
    session_id = payload.get("sessionId") or f"onsite-{uuid.uuid4().hex}-{uuid.uuid4().hex}"
    if len(session_id) < 33:
        session_id = (session_id + "-" + uuid.uuid4().hex)[:64]

    # Invoke the MANAGED HARNESS. messages is a Converse-style array.
    kwargs = {
        "harnessArn": HARNESS_ARN,
        "runtimeSessionId": session_id,
        "messages": [{"role": "user", "content": [{"text": message}]}],
    }
    if HARNESS_QUALIFIER:
        kwargs["qualifier"] = HARNESS_QUALIFIER

    try:
        resp = _agentcore.invoke_harness(**kwargs)
    except Exception as exc:  # surface a clean error to the widget
        return _resp(502, {"error": "agent_invoke_failed",
                           "message": "The concierge is unavailable right now.",
                           "detail": str(exc)[:300]})

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
                return _resp(400, {"error": "validation_exception",
                                   "message": str(ev["validationException"])[:300]})
            elif "runtimeClientError" in ev:
                return _resp(502, {"error": "runtime_client_error",
                                   "message": str(ev["runtimeClientError"])[:300]})
            elif "internalServerException" in ev:
                return _resp(502, {"error": "internal_server_exception",
                                   "message": "The concierge hit a transient error. Please retry."})
    except Exception as exc:
        return _resp(502, {"error": "stream_read_failed",
                           "message": "Could not read the concierge response.",
                           "detail": str(exc)[:300]})

    reply_text = "".join(reply_parts).strip() or "I couldn't find an answer for that just now."
    return _resp(200, {"reply": reply_text, "sessionId": session_id, "stopReason": stop_reason})
