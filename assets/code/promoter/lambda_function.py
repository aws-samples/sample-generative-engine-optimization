# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""
GEO Validator Lambda Function (formerly "promoter")
===================================================
The VALIDATE gate of the automated GEO feedback loop (Blog 1).

Blog 1 model = STAGE-ONLY + MANUAL PROMOTE:
  The automated loop runs end to end THROUGH validation, but it NEVER writes to
  the live content. If the staged candidate measurably improves citation share,
  it is LEFT IN staging/ and flagged as ready; a human promotes it to live
  manually (a documented one-line `aws s3 cp` + CloudFront invalidation).
  If the candidate does not improve, it is discarded automatically.

  This keeps the automation from ever touching production content — the safest,
  cleanest 200-level story. Blog 2's autonomous agents close the last inch
  (promote to live themselves, with AgentCore Memory judging the change).

Input (from the Step Functions state machine):
  {
    "staged_key": "staging/properties/<slug>.html",
    "live_key":   "properties/<slug>.html",
    "baseline_citation_rate": 42.9,   # live score from the first Measure
    "candidate_citation_rate": 57.1,  # score from the staging Re-test
    "property_slug": "<slug>"
  }

Action:
  - if candidate > baseline: LEAVE the candidate in staging/, emit CandidateReady=1
    and return the manual promote command for the operator.
  - else: delete the staged candidate, emit PromotionSkipped=1.

This Lambda does NOT copy to live and does NOT invalidate CloudFront — those are
the manual promote step. It only needs read + delete (for discards) + metrics.

Environment variables:
  CONTENT_BUCKET    S3 bucket (e.g. geo-demo-content)
  DISTRIBUTION_ID   CloudFront distribution id (used only to print the manual
                    invalidation command for the operator; no API call is made)
  CW_NAMESPACE      CloudWatch namespace (default GEO/CitationTracker)

IAM required:
  s3:DeleteObject   on arn:aws:s3:::<bucket>/staging/*   (discard non-improving candidates)
  cloudwatch:PutMetricData  (namespace-scoped)
  (NOTE: no s3:PutObject to live keys, no cloudfront:CreateInvalidation — that's
   the whole point of stage-only: this role cannot modify production content.)
"""
import os

import boto3

CONTENT_BUCKET = os.environ["CONTENT_BUCKET"]
DISTRIBUTION_ID = os.environ.get("DISTRIBUTION_ID", "")
# CloudFront origin path prefix — stripped from the S3 key to form the PUBLIC invalidation path.
ORIGIN_PATH_PREFIX = os.environ.get("ORIGIN_PATH_PREFIX", "web-application/")
CW_NAMESPACE = os.environ.get("CW_NAMESPACE", "GEO/CitationTracker")

s3 = boto3.client("s3")
cloudwatch = boto3.client("cloudwatch")


def _emit(metric, value, slug):
    cloudwatch.put_metric_data(
        Namespace=CW_NAMESPACE,
        MetricData=[{
            "MetricName": metric,
            "Value": value,
            "Unit": "Count",
            "Dimensions": [{"Name": "PropertySlug", "Value": slug or "unknown"}],
        }],
    )


def lambda_handler(event, context):
    staged_key = event.get("staged_key")
    live_key = event.get("live_key")
    slug = event.get("property_slug", "unknown")
    baseline = float(event.get("baseline_citation_rate", 0) or 0)
    candidate = float(event.get("candidate_citation_rate", 0) or 0)

    # Nothing was staged (patch made no change) -> nothing to validate.
    if not staged_key:
        _emit("PromotionSkipped", 1, slug)
        return {"ready": False, "reason": "no_candidate", "baseline": baseline, "candidate": candidate}

    improved = candidate > baseline
    if not improved:
        # Discard the non-improving candidate from staging.
        s3.delete_object(Bucket=CONTENT_BUCKET, Key=staged_key)
        _emit("PromotionSkipped", 1, slug)
        return {
            "ready": False,
            "reason": "no_improvement",
            "baseline": baseline,
            "candidate": candidate,
            "delta": round(candidate - baseline, 2),
        }

    # Improved: LEAVE it in staging and flag it ready for manual promotion.
    _emit("CandidateReady", 1, slug)
    manual_promote = (
        f"aws s3 cp s3://{CONTENT_BUCKET}/{staged_key} s3://{CONTENT_BUCKET}/{live_key} "
        f"--content-type text/html"
    )
    # The public CloudFront path strips the origin-path prefix (e.g. web-application/).
    public_path = live_key[len(ORIGIN_PATH_PREFIX):] if live_key.startswith(ORIGIN_PATH_PREFIX) else live_key
    manual_invalidate = (
        f"aws cloudfront create-invalidation --distribution-id {DISTRIBUTION_ID or '<DIST_ID>'} "
        f"--paths /{public_path}"
    )
    return {
        "ready": True,
        "reason": "citation_share_improved",
        "baseline": baseline,
        "candidate": candidate,
        "delta": round(candidate - baseline, 2),
        "staged_key": staged_key,
        "live_key": live_key,
        "manual_promote_command": manual_promote,
        "manual_invalidate_command": manual_invalidate,
        "note": "Candidate left in staging. Review, then run the manual promote + invalidate commands to go live.",
    }
