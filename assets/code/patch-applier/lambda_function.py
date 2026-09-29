"""
GEO Patch Applier Lambda Function
=================================
The PATCH leg of the automated GEO feedback loop (Blog 1).

Input  : a diagnosis produced by the citation tracker's diagnose_gap(), i.e.
         {"property_slug": "octank-suites-cherry-creek", "top_fix": "pet_policy", ...}
Action : deterministically maps top_fix -> a concrete edit of the property's
         embedded JSON-LD (LodgingBusiness schema), then writes the patched
         HTML to a STAGING key in S3. It NEVER writes to the live key.
Output : {"staged_key": "staging/properties/<slug>.html", "applied_fix": "...",
          "changed": true/false}

Design (Blog 1, 200-level):
  - DETERMINISTIC field-mapping. Each top_fix tag maps to a specific JSON-LD
    mutation via FIX_MAP below. No LLM call — reproducible: same gap -> same patch.
  - Writes to staging/ ONLY. A separate promoter Lambda decides whether the
    candidate is promoted to live, based on the measured citation-share delta.
  - Blog 2 upgrades this to an agent that reasons about the fix; here it's a table.

Environment variables:
  CONTENT_BUCKET   S3 bucket holding the site content (e.g. geo-demo-content)
  STAGING_PREFIX   Prefix for candidate objects (default "staging/")
  PROPERTIES_PREFIX  Live prefix for property pages (default "properties/")

IAM required:
  s3:GetObject  on  arn:aws:s3:::<bucket>/*         (read the live page to base the patch on)
  s3:PutObject  on  arn:aws:s3:::<bucket>/staging/* (write the candidate only)
"""
import json
import os
import re

import boto3

CONTENT_BUCKET = os.environ["CONTENT_BUCKET"]
STAGING_PREFIX = os.environ.get("STAGING_PREFIX", "staging/")
PROPERTIES_PREFIX = os.environ.get("PROPERTIES_PREFIX", "properties/")

s3 = boto3.client("s3")

# Deterministic map: diagnosis top_fix tag -> how to mutate the LodgingBusiness JSON-LD.
# Each handler takes the parsed JSON-LD dict and returns True if it changed something.
def _ensure_amenity(ld, amenity_name):
    feats = ld.setdefault("amenityFeature", [])
    if any(f.get("name", "").lower() == amenity_name.lower() for f in feats):
        return False
    feats.append({"@type": "LocationFeatureSpecification", "name": amenity_name, "value": True})
    return True

def _set_pets_allowed(ld, _):
    if ld.get("petsAllowed") is True:
        return False
    ld["petsAllowed"] = True
    return True

def _ensure_price_range(ld, _):
    if ld.get("priceRange"):
        return False
    ld["priceRange"] = "$120 - $260"  # demo default; real impl would pull from rates table
    return True

FIX_MAP = {
    # gap tag           -> (handler, argument)
    "pet_policy":        (_set_pets_allowed, None),
    "pets_allowed":      (_set_pets_allowed, None),
    "pool":              (_ensure_amenity, "Outdoor Pool"),
    "outdoor_pool":      (_ensure_amenity, "Outdoor Pool"),
    "free_breakfast":    (_ensure_amenity, "Free Breakfast"),
    "breakfast":         (_ensure_amenity, "Free Breakfast"),
    "coworking":         (_ensure_amenity, "Coworking Space"),
    "coworking_space":   (_ensure_amenity, "Coworking Space"),
    "kitchenette":       (_ensure_amenity, "Kitchenette"),
    "spa":               (_ensure_amenity, "Spa"),
    "fitness_center":    (_ensure_amenity, "Fitness Center"),
    "ev_charging":       (_ensure_amenity, "EV Charging"),
    "nightly_rate":      (_ensure_price_range, None),
    "price":             (_ensure_price_range, None),
    "price_range":       (_ensure_price_range, None),
}

LD_BLOCK_RE = re.compile(
    r'(<script type="application/ld\+json">\s*)(\{.*?\})(\s*</script>)',
    re.DOTALL,
)


def _load_live_html(slug):
    key = f"{PROPERTIES_PREFIX}{slug}.html"
    obj = s3.get_object(Bucket=CONTENT_BUCKET, Key=key)
    return key, obj["Body"].read().decode("utf-8")


def _patch_html(html, top_fix):
    """Apply the deterministic fix to the JSON-LD block inside the HTML. Returns (new_html, changed, note)."""
    m = LD_BLOCK_RE.search(html)
    if not m:
        return html, False, "no JSON-LD block found"

    ld = json.loads(m.group(2))
    handler_entry = FIX_MAP.get((top_fix or "").strip().lower())
    if not handler_entry:
        return html, False, f"no deterministic mapping for top_fix='{top_fix}'"

    handler, arg = handler_entry
    changed = handler(ld, arg)
    if not changed:
        return html, False, f"'{top_fix}' already satisfied — no change"

    new_ld = json.dumps(ld, indent=2)
    new_html = html[:m.start()] + m.group(1) + new_ld + m.group(3) + html[m.end():]
    return new_html, True, f"applied '{top_fix}'"


def lambda_handler(event, context):
    """
    event: {"property_slug": "...", "top_fix": "...", "diagnosis": {...}}
    Returns the staged object key + whether anything changed.
    """
    slug = event.get("property_slug")
    top_fix = event.get("top_fix") or (event.get("diagnosis") or {}).get("top_fix")

    if not slug:
        return {"changed": False, "error": "missing property_slug"}
    if not top_fix:
        return {"changed": False, "error": "missing top_fix"}

    try:
        live_key, html = _load_live_html(slug)
    except s3.exceptions.NoSuchKey:
        return {"changed": False, "error": f"live page not found: {slug}.html"}

    new_html, changed, note = _patch_html(html, top_fix)

    staged_key = f"{STAGING_PREFIX}{PROPERTIES_PREFIX}{slug}.html"
    if changed:
        s3.put_object(
            Bucket=CONTENT_BUCKET,
            Key=staged_key,
            Body=new_html.encode("utf-8"),
            ContentType="text/html",
        )

    return {
        "changed": changed,
        "note": note,
        "property_slug": slug,
        "top_fix": top_fix,
        "staged_key": staged_key if changed else None,
        "live_key": live_key,
    }
