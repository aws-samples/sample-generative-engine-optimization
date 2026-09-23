"""geo-promoter Lambda (placeholder).

Promotes reviewed content from staging/ to the web_application/ origin prefix,
invalidates the CloudFront distribution (DISTRIBUTION_ID), and publishes
metrics. Discards rejected candidates from staging/. Replace with the real
logic.
"""
import json
import os

CONTENT_BUCKET = os.environ.get("CONTENT_BUCKET", "")
DISTRIBUTION_ID = os.environ.get("DISTRIBUTION_ID", "")
ORIGIN_PATH_PREFIX = os.environ.get("ORIGIN_PATH_PREFIX", "web_application/")
CW_NAMESPACE = os.environ.get("CW_NAMESPACE", "GEO/CitationTracker")


def lambda_handler(event, context):
    return {
        "statusCode": 200,
        "body": json.dumps({"message": "geo-promoter placeholder"}),
    }
