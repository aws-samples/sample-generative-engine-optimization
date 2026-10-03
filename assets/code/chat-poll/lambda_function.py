"""
GEO Demo - On-Site Concierge Chat POLL Endpoint (async request/poll)
====================================================================
Thin, PUBLIC HTTPS endpoint behind `GET /chat/{jobId}`. The browser polls this
after a `POST /chat` submit until the job reaches a terminal state. It reads
the job from DynamoDB and reports status + result.

Why async (proven live):
  The chat worker invokes the AgentCore managed harness; the agent loop runs
  ~49s, past the API Gateway hard 29s integration timeout. So the submit
  endpoint returns a jobId immediately and the browser polls here for the
  result (status PENDING -> DONE/ERROR).

Responses (all with CORS headers):
  200 {status:'PENDING'}                       while the worker is running
  200 {status:'DONE', reply, stopReason}       when the worker finished OK
  200 {status:'ERROR', error}                  when the worker failed
  404 {error:'not_found'}                       unknown jobId

Env vars:
  JOBS_TABLE     DynamoDB table name for the chat jobs store.
  ALLOWED_ORIGIN Exact browser origin allowed for CORS.
"""
import json
import os

import boto3

JOBS_TABLE = os.environ["JOBS_TABLE"]
ALLOWED_ORIGIN = os.environ.get("ALLOWED_ORIGIN", "*")

_table = boto3.resource("dynamodb").Table(JOBS_TABLE)


def _cors_headers():
    return {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "GET,OPTIONS",
    }


def _resp(status, body):
    return {"statusCode": status, "headers": _cors_headers(), "body": json.dumps(body)}


def handler(event, context):
    # CORS preflight
    method = (event.get("requestContext", {})
              .get("http", {}).get("method")) or event.get("httpMethod")
    if method == "OPTIONS":
        return _resp(200, {"ok": True})

    job_id = (event.get("pathParameters") or {}).get("jobId")
    if not job_id:
        return _resp(400, {"error": "missing_job_id",
                           "message": "Provide a jobId in the path."})

    item = _table.get_item(Key={"jobId": job_id}).get("Item")
    if not item:
        return _resp(404, {"error": "not_found",
                           "message": "No job with that id."})

    status = item.get("status", "PENDING")
    if status == "DONE":
        return _resp(200, {"status": "DONE",
                           "reply": item.get("reply"),
                           "stopReason": item.get("stopReason")})
    if status == "ERROR":
        return _resp(200, {"status": "ERROR", "error": item.get("error")})

    return _resp(200, {"status": "PENDING"})
