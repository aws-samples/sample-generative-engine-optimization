"""api-handler Lambda (placeholder).

Entry point behind API Gateway. Routes hotel queries to Aurora (and optionally
the Bedrock agent for complex requests). Replace with the real implementation.
"""
import json


def handler(event, context):
    path = event.get("rawPath") or event.get("path", "/")
    return {
        "statusCode": 200,
        "headers": {"content-type": "application/json"},
        "body": json.dumps({"message": "api-handler placeholder", "path": path}),
    }
