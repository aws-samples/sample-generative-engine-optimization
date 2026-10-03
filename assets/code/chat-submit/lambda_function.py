# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""
GEO Demo - On-Site Concierge Chat SUBMIT Endpoint (async request/poll)
======================================================================
Thin, PUBLIC HTTPS endpoint behind `POST /chat`. It accepts a chat message,
records a PENDING job in DynamoDB, kicks off the long-running agent worker
ASYNCHRONOUSLY, and returns 202 immediately with a `jobId`.

Why async (proven live):
  The chat worker invokes the AgentCore managed harness; the agent loop runs
  ~49s. API Gateway REST APIs have a HARD 29s integration timeout, so a
  synchronous POST always times out even though the Lambda succeeds. Lambda
  Function URLs are blocked by an account guardrail (403 at the edge). So this
  submit returns a jobId right away, a worker Lambda runs the agent in the
  background, and the browser polls `GET /chat/{jobId}` for the result.

Flow:
  1. Validate input (same contract as the original chat endpoint: JSON body,
     non-empty `message`, `MAX_MESSAGE_CHARS` cap, optional `sessionId`).
  2. Generate `jobId = uuid4().hex`, PutItem {jobId, status:'PENDING',
     createdAt, ttl ~1h} into JOBS_TABLE.
  3. Invoke the worker ASYNCHRONOUSLY (lambda InvocationType='Event') with
     {jobId, message, sessionId}.
  4. Return 202 {jobId, status:'PENDING'} with CORS headers.

Security posture (keep it tight -- this route is public):
  * CORS locked to the site origin (ALLOWED_ORIGIN env var).
  * Message length capped; basic input validation.
  * Stateless submit; the worker holds the harness grant.

Env vars:
  JOBS_TABLE           DynamoDB table name for the chat jobs store.
  WORKER_FUNCTION_NAME Name of the worker Lambda to invoke asynchronously.
  ALLOWED_ORIGIN       Exact browser origin allowed for CORS.
  MAX_MESSAGE_CHARS    Optional; default 500.
"""
import json
import os
import time
import uuid

import boto3

JOBS_TABLE = os.environ["JOBS_TABLE"]
WORKER_FUNCTION_NAME = os.environ["WORKER_FUNCTION_NAME"]
ALLOWED_ORIGIN = os.environ.get("ALLOWED_ORIGIN", "*")
MAX_MESSAGE_CHARS = int(os.environ.get("MAX_MESSAGE_CHARS", "500"))
JOB_TTL_SECONDS = 3600

_table = boto3.resource("dynamodb").Table(JOBS_TABLE)
_lambda = boto3.client("lambda")


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

    job_id = uuid.uuid4().hex
    now = int(time.time())

    # Record the PENDING job before kicking off the worker.
    _table.put_item(Item={
        "jobId": job_id,
        "status": "PENDING",
        "createdAt": now,
        "ttl": now + JOB_TTL_SECONDS,
    })

    # Fire the worker asynchronously (Event = no wait for the ~49s agent loop).
    try:
        _lambda.invoke(
            FunctionName=WORKER_FUNCTION_NAME,
            InvocationType="Event",
            Payload=json.dumps({
                "jobId": job_id,
                "message": message,
                "sessionId": session_id,
            }).encode("utf-8"),
        )
    except Exception as exc:  # surface a clean error to the widget
        return _resp(502, {"error": "worker_invoke_failed",
                           "message": "The concierge is unavailable right now.",
                           "detail": str(exc)[:300]})

    return _resp(202, {"jobId": job_id, "status": "PENDING"})
