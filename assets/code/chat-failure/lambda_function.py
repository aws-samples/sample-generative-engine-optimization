# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""
GEO Demo - On-Site Concierge Chat ON-FAILURE handler (async request/poll)
=========================================================================
Lambda on-failure destination for the chat WORKER (geo-onsite-chat). When an
async invocation of the worker ultimately fails — a handler crash, a timeout, an
OOM, or any error the worker's own try/except could not record — Lambda routes
the async failure event here. We pull the original jobId out of the failure
envelope and mark the DynamoDB job ERROR, so a failed turn is never left stuck
as PENDING (the browser polls GET /chat/{jobId} and would otherwise wait out its
client-side timeout against a row that never resolves).

Why a SEPARATE function (not the worker itself): AWS Lambda forbids a function
from being its own on-failure destination ("You can't specify the function as a
destination for itself"), so the destination must be a distinct function.

Async failure event shape (full invocation record):
  {
    "version": "1.0",
    "timestamp": "...",
    "requestContext": {"functionArn": "...", "condition": "...", "requestId": "..."},
    "requestPayload": {"jobId": "...", "message": "...", "sessionId": "..."},
    "responseContext": {...},
    "responsePayload": {...error...}
  }

Env vars:
  JOBS_TABLE  DynamoDB table name for the chat jobs store.
"""
import logging
import os
import time

import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Generic, non-sensitive message surfaced to the browser via the poll endpoint.
GENERIC_ERROR = "The concierge is unavailable right now. Please try again."

JOBS_TABLE = os.environ["JOBS_TABLE"]
_table = boto3.resource("dynamodb").Table(JOBS_TABLE)


def handler(event, context):
    """On-failure destination entry point. Receives the async failure envelope."""
    original = (event or {}).get("requestPayload") or {}
    job_id = original.get("jobId") if isinstance(original, dict) else None
    condition = ((event or {}).get("requestContext") or {}).get("condition")
    logger.warning("Worker async invoke failed (condition=%s); marking job %s ERROR",
                   condition, job_id)

    if not job_id:
        # Nothing we can mark; just acknowledge so this invocation succeeds.
        return {"status": "NO_JOB_ID"}

    try:
        # Conditional: only set ERROR if the job isn't already DONE, so a late
        # failure signal can't clobber a reply that already landed.
        _table.update_item(
            Key={"jobId": job_id},
            UpdateExpression="SET #s = :s, #e = :e, finishedAt = :f",
            ConditionExpression="attribute_not_exists(#s) OR #s <> :done",
            ExpressionAttributeNames={"#s": "status", "#e": "error"},
            ExpressionAttributeValues={
                ":s": "ERROR",
                ":e": GENERIC_ERROR,
                ":f": int(time.time()),
                ":done": "DONE",
            },
        )
    except Exception:
        # ConditionalCheckFailedException (already DONE) or a transient write
        # error. Log and return normally; must not re-raise.
        logger.warning("Could not mark job %s ERROR (may already be DONE)", job_id)

    return {"jobId": job_id, "status": "ERROR", "handledAs": "onFailure"}
