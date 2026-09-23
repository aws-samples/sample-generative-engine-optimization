"""geo-api-handler Lambda (placeholder).

Entry point behind API Gateway for the Octank Hospitality API. Queries Aurora
via the RDS Data API (DB_CLUSTER_ARN + DB_SECRET_ARN) and may invoke the
Bedrock agent for complex requests. Replace with the real implementation.

Routes (REST API):
  GET  /properties
  GET  /properties/{propertyId}
  GET  /properties/{propertyId}/rates
  GET  /properties/{propertyId}/availability
  POST /reservations
"""
import json
import os

DB_CLUSTER_ARN = os.environ.get("DB_CLUSTER_ARN", "")
DB_SECRET_ARN = os.environ.get("DB_SECRET_ARN", "")
DB_NAME = os.environ.get("DB_NAME", "geo_db")


def lambda_handler(event, context):
    path = event.get("resource") or event.get("path", "/")
    method = event.get("httpMethod", "GET")
    return {
        "statusCode": 200,
        "headers": {"content-type": "application/json"},
        "body": json.dumps({"message": "geo-api-handler placeholder", "method": method, "path": path}),
    }
