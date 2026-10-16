# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""
Citation Tracker Lambda Function
================================
Measures how discoverable the brand is to an AI engine, and (in the feedback
loop) whether a staged content fix measurably improves that.

TWO SCORING MODES (SCORE_MODE env var / per-event `score_mode`):

  * brand_mention  (default) -- the "cold awareness" baseline. Ask the model
    each curated prompt with NO context and check whether the brand appears in
    the free-form answer. Measures what the model already knows unprompted
    (training-data recall). A content patch cannot move this in one cycle, and
    for a brand the model has never seen (e.g. a fictional demo brand) it is
    always 0 -- which is honest, but means a staged candidate can never "win".

  * grounded       -- the "retrieval readiness" score. For each prompt, LOAD the
    property's JSON-LD from S3 (the LIVE key for the baseline pass, the STAGED
    key for the candidate pass), hand it to the model as context, and check
    whether the model can now answer the prompt citing the property. Thin
    JSON-LD cannot answer a pet/pool/price prompt -> low; enriched candidate can
    -> higher. This makes the candidate-vs-baseline delta REAL, and it mirrors
    how retrieval/browsing AI engines actually cite you at answer time (RAG).

    Grounded scoring proves your content is RETRIEVABLE and ANSWERABLE -- not
    that any given engine will rank or cite you (that still depends on the
    engine's own retrieval). Report both scores; don't overclaim.

DETERMINISTIC PROPERTY RESOLUTION:
  When a prompt is not cited, we must decide WHICH property to patch. Instead of
  a hard-coded slug, resolve_property() parses the failed prompt for a CITY and
  the diagnosed ATTRIBUTE (top_fix), then picks the property in that city whose
  JSON-LD actually LACKS that attribute -- the genuinely under-tagged one. If
  none lack it, we honestly report no gap. This is rule-based (no LLM) and so
  stays on the Blog 1 (deterministic) side of the line; Blog 2 replaces it with
  an agent that resolves ambiguous entities.

Schedule: run weekly via EventBridge.
IAM required:
  - bedrock:InvokeModel / InvokeModelWithResponseStream  (Claude FM + inference profile)
  - cloudwatch:PutMetricData  (namespace-scoped)
  - s3:GetObject on the content bucket  (read prompts.json AND, for grounded
    scoring + property resolution, the property JSON-LD under web_application/)
"""

import json
import os
import re
from datetime import datetime, timezone

import boto3

# ---------------------------------------------------------------------------
# Configuration (env-var driven; safe defaults for local runs)
# ---------------------------------------------------------------------------
PROMPTS_FILE = os.environ.get("PROMPTS_FILE", "prompts.json")
# Default to the current cross-region inference-profile model. The old
# claude-3-haiku default is three generations behind and is NOT an
# inference-profile id; grounded scoring in particular wants a current model.
BEDROCK_MODEL_ID = os.environ.get(
    "BEDROCK_MODEL_ID", "global.anthropic.claude-sonnet-4-6"
)
CLOUDWATCH_NAMESPACE = os.environ.get("CW_NAMESPACE", "GEO/CitationTracker")
AWS_REGION = os.environ.get("AWS_REGION", "us-east-1")

# Where the property pages live, so grounded scoring + resolution can read them.
CONTENT_BUCKET = os.environ.get("CONTENT_BUCKET", "")
# Live property-page prefix, e.g. "web_application/properties/".
PROPERTIES_PREFIX = os.environ.get("PROPERTIES_PREFIX", "web_application/properties/")
STAGING_PREFIX = os.environ.get("STAGING_PREFIX", "staging/")
# brand_mention | grounded  (per-event score_mode overrides this)
DEFAULT_SCORE_MODE = os.environ.get("SCORE_MODE", "brand_mention")

bedrock_runtime = boto3.client("bedrock-runtime", region_name=AWS_REGION)
cloudwatch = boto3.client("cloudwatch", region_name=AWS_REGION)
s3 = boto3.client("s3", region_name=AWS_REGION)

_LD_RE = re.compile(
    r'<script type="application/ld\+json">\s*(\{.*?\})\s*</script>', re.DOTALL
)


# ---------------------------------------------------------------------------
# Prompt / config loading
# ---------------------------------------------------------------------------
def load_prompts():
    """Load the brand, match_terms, and curated prompts bundled next to this file."""
    with open(PROMPTS_FILE, "r") as f:
        return json.load(f)


# ---------------------------------------------------------------------------
# Bedrock
# ---------------------------------------------------------------------------
def query_bedrock(prompt: str) -> str:
    """Invoke the model with a single user prompt and return the response text."""
    body = json.dumps({
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": 1024,
        "messages": [{"role": "user", "content": prompt}],
    })
    response = bedrock_runtime.invoke_model(
        modelId=BEDROCK_MODEL_ID,
        body=body,
        contentType="application/json",
        accept="application/json",
    )
    result = json.loads(response["body"].read())
    return result["content"][0]["text"]


def check_citation(response_text: str, match_terms: list) -> dict:
    """Check whether any brand term appears in the model's answer."""
    response_lower = (response_text or "").lower()
    matches = [t for t in match_terms if t.lower() in response_lower]
    return {"cited": len(matches) > 0, "matched_terms": matches, "match_count": len(matches)}


# ---------------------------------------------------------------------------
# S3 helpers for grounded scoring + property resolution
# ---------------------------------------------------------------------------
def _read_property_ld(key: str) -> dict:
    """Fetch an HTML page from S3 and return its parsed JSON-LD dict ({} if none/missing)."""
    if not CONTENT_BUCKET:
        return {}
    try:
        obj = s3.get_object(Bucket=CONTENT_BUCKET, Key=key)
    except s3.exceptions.NoSuchKey:
        return {}
    except Exception:  # noqa: BLE001  (missing/unreadable page -> treat as empty)
        return {}
    html = obj["Body"].read().decode("utf-8", errors="replace")
    m = _LD_RE.search(html)
    if not m:
        return {}
    try:
        return json.loads(m.group(1))
    except json.JSONDecodeError:
        return {}


def _live_key(slug: str) -> str:
    return f"{PROPERTIES_PREFIX}{slug}.html"


def _staged_key(slug: str) -> str:
    # Mirrors the patch-applier: staging/ + the live prefix + <slug>.html
    return f"{STAGING_PREFIX}{PROPERTIES_PREFIX}{slug}.html"


# ---------------------------------------------------------------------------
# Grounded scoring: can the model answer the prompt FROM the property's data?
# ---------------------------------------------------------------------------
def score_grounded(prompt_text: str, property_ld: dict, match_terms: list,
                   required_tag: str = "") -> dict:
    """Hand the property's structured data to the model as the ONLY context and
    ask it to answer the prompt. Cited = the brand appears in the grounded answer
    AND, when a required_tag is given, the property's data actually satisfies that
    attribute. The attribute gate stops a bare brand mention from counting when
    the asked-for amenity/price isn't present (e.g. a 'pool' query grounded on a
    pool-less property). Measures retrieval-readiness, not training recall.
    """
    if not property_ld:
        # No content to ground on -> cannot answer from it.
        return {"cited": False, "matched_terms": [], "match_count": 0}
    # Attribute gate: if the prompt targets a known attribute the property lacks,
    # it cannot honestly satisfy the prompt -> not cited, without a model call.
    if required_tag and not _property_has_attribute(property_ld, required_tag):
        return {"cited": False, "matched_terms": [], "match_count": 0}
    ctx = json.dumps(property_ld, separators=(",", ":"))
    grounded_prompt = (
        "You are answering a traveler using ONLY the structured hotel data "
        "provided. If (and only if) the data supports it, recommend the property "
        "by name and cite the matching amenities or price. If the data does not "
        "support the request, say you don't have a match.\n\n"
        f"STRUCTURED DATA:\n{ctx}\n\n"
        f"TRAVELER QUESTION: {prompt_text}"
    )
    answer = query_bedrock(grounded_prompt)
    return check_citation(answer, match_terms)


# ---------------------------------------------------------------------------
# Gap diagnosis (unchanged in spirit): what attribute is missing?
# ---------------------------------------------------------------------------
# Keyword -> FIX_MAP tag inference. Keys are substrings to look for in the prompt;
# values are tags the patch-applier's FIX_MAP knows how to apply. Guarantees a
# not-cited prompt yields an actionable, appliable fix even if the model's JSON is empty.
# CUSTOMIZE FOR YOUR ENVIRONMENT (gap keyword inference): the keywords below are
# hotel amenities (pool/pet/breakfast...). Replace them -- and FIX_MAP in
# patch-applier -- with the content attributes that matter for YOUR entity type.
# The Blog 2 agentic version replaces this table with an agent that infers the gap.
_FIX_KEYWORDS = [
    ("pet", "pet_policy"),
    ("dog", "pet_policy"),
    ("pool", "pool"),
    ("breakfast", "free_breakfast"),
    ("coworking", "coworking"),
    ("co-working", "coworking"),
    ("work space", "coworking"),
    ("workspace", "coworking"),
    ("kitchenette", "kitchenette"),
    ("kitchen", "kitchenette"),
    ("spa", "spa"),
    ("fitness", "fitness_center"),
    ("gym", "fitness_center"),
    ("ev charg", "ev_charging"),
    ("charging", "ev_charging"),
    ("rate", "nightly_rate"),
    ("price", "price_range"),
    ("budget", "price_range"),
    ("cost", "price_range"),
]

# Which JSON-LD field each FIX_MAP tag targets, so property resolution can test
# whether a given property actually LACKS that attribute. Keep in sync with the
# patch-applier FIX_MAP.
#   kind "pets"     -> ld["petsAllowed"] is truthy
#   kind "price"    -> ld["priceRange"] is non-empty
#   kind "amenity"  -> an amenityFeature entry named <value> is present
_TAG_ATTRIBUTE = {
    "pet_policy":     ("pets", None),
    "pets_allowed":   ("pets", None),
    "pool":           ("amenity", "Outdoor Pool"),
    "outdoor_pool":   ("amenity", "Outdoor Pool"),
    "free_breakfast": ("amenity", "Free Breakfast"),
    "breakfast":      ("amenity", "Free Breakfast"),
    "coworking":      ("amenity", "Coworking Space"),
    "coworking_space":("amenity", "Coworking Space"),
    "kitchenette":    ("amenity", "Kitchenette"),
    "spa":            ("amenity", "Spa"),
    "fitness_center": ("amenity", "Fitness Center"),
    "ev_charging":    ("amenity", "EV Charging"),
    "nightly_rate":   ("price", None),
    "price":          ("price", None),
    "price_range":    ("price", None),
}


def _infer_fix_from_text(text: str) -> str:
    """Map free text to a known FIX_MAP tag by keyword. Returns '' if none match."""
    low = (text or "").lower()
    for kw, tag in _FIX_KEYWORDS:
        if kw in low:
            return tag
    return ""


def diagnose_gap(prompt: str, brand: str, property_terms: list) -> dict:
    """Ask the model WHY the brand wasn't cited and what attribute is missing.
    The answer is a directional hypothesis (a rationalization, not a ranking
    log) -- the real signal is whether citation share improves after acting on it.
    """
    focus = property_terms[0] if property_terms else brand
    diag_prompt = (
        f'A user asked: "{prompt}"\n\n'
        f'Consider the business "{focus}". If you did NOT mention it in your answer, '
        f"explain concretely why. Specifically:\n"
        f"1. What information about {focus} would you need to confidently recommend it "
        f"for this query (e.g., amenities, price, location details, pet policy, availability)?\n"
        f"2. Which of those details appear to be missing or unclear?\n"
        f"3. List the single most important attribute to add, as a short tag "
        f"(e.g., 'pet_policy', 'nightly_rate', 'pool', 'distance_to_landmark').\n\n"
        f'Answer in JSON: {{"needed": [...], "missing": [...], "top_fix": "..."}}'
    )
    try:
        raw = query_bedrock(diag_prompt)
        cleaned = raw.replace("```json", "").replace("```", "")
        start = cleaned.find("{")
        end = cleaned.rfind("}")
        parsed = {}
        if start != -1 and end != -1:
            try:
                parsed = json.loads(cleaned[start:end + 1])
            except json.JSONDecodeError:
                parsed = {}
        top_fix = (parsed.get("top_fix") or "").strip().lower().replace(" ", "_")
        if not top_fix:
            top_fix = _infer_fix_from_text(
                prompt + " " + " ".join(str(m) for m in parsed.get("missing", []))
            )
        return {
            "needed": parsed.get("needed", []),
            "missing": parsed.get("missing", []),
            "top_fix": top_fix,
            "raw": raw[:500],
        }
    except Exception as e:  # noqa: BLE001
        return {"needed": [], "missing": [], "top_fix": "", "error": str(e)}


# ---------------------------------------------------------------------------
# Deterministic property resolution
# ---------------------------------------------------------------------------
def _property_has_attribute(ld: dict, tag: str) -> bool:
    """True if the property's JSON-LD already satisfies the attribute for `tag`."""
    kind, val = _TAG_ATTRIBUTE.get(tag, (None, None))
    if kind == "pets":
        return bool(ld.get("petsAllowed"))
    if kind == "price":
        return bool(ld.get("priceRange"))
    if kind == "amenity":
        feats = ld.get("amenityFeature", []) or []
        names = {str(f.get("name", "")).lower() for f in feats}
        want = (val or "").lower()
        if want in names:
            return True
        if "pool" in want and any("pool" in n for n in names):
            return True
        return False
    # Unknown tag -> can't prove it's missing; treat as satisfied so we don't
    # patch the wrong thing.
    return True


def resolve_property(prompt_text: str, top_fix: str, catalog: list) -> str:
    """Pick the property genuinely under-tagged for this prompt.

    catalog: list of {"slug","city","ld"} for every live property.
    Rule-based (no LLM): match the prompt's CITY, then pick the property in that
    city that LACKS `top_fix`'s attribute. Deterministic tie-break (first by
    slug). Returns '' if nothing in the city lacks it (honest "no gap").
    """
    low = (prompt_text or "").lower()
    cities = sorted({c["city"] for c in catalog if c.get("city")}, key=len, reverse=True)
    prompt_city = next((c for c in cities if c.lower() in low), None)
    pool = [c for c in catalog if (prompt_city is None or c.get("city") == prompt_city)]
    for cand in sorted(pool, key=lambda c: c["slug"]):
        if not _property_has_attribute(cand.get("ld", {}), top_fix):
            return cand["slug"]
    return ""


def _resolve_satisfying_property(prompt_text: str, top_fix: str, catalog: list) -> str:
    """Pick a property in the prompt's city that HAS the attribute -- the one that
    could legitimately answer the prompt. The mirror of resolve_property (which
    finds the property that LACKS it). Used for the grounded BASELINE: score the
    content that should answer, so a city with no satisfying property scores
    uncited (a real gap) instead of being rescued by a bare brand mention.
    Returns '' if no in-city property satisfies it.
    """
    low = (prompt_text or "").lower()
    cities = sorted({c["city"] for c in catalog if c.get("city")}, key=len, reverse=True)
    prompt_city = next((c for c in cities if c.lower() in low), None)
    pool = [c for c in catalog if (prompt_city is None or c.get("city") == prompt_city)]
    if not top_fix:
        # No specific patchable attribute (e.g. a 'boutique' prompt) -> any
        # in-city property can answer; fall back to the first by slug.
        return sorted(pool, key=lambda c: c["slug"])[0]["slug"] if pool else ""
    for cand in sorted(pool, key=lambda c: c["slug"]):
        if _property_has_attribute(cand.get("ld", {}), top_fix):
            return cand["slug"]
    return ""


def _load_catalog() -> list:
    """List every live property page and parse its slug/city/JSON-LD once."""
    catalog = []
    if not CONTENT_BUCKET:
        return catalog
    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=CONTENT_BUCKET, Prefix=PROPERTIES_PREFIX):
        for obj in page.get("Contents", []):
            key = obj["Key"]
            if not key.endswith(".html"):
                continue
            slug = key[len(PROPERTIES_PREFIX):-len(".html")]
            ld = _read_property_ld(key)
            city = (ld.get("address", {}) or {}).get("addressLocality")
            catalog.append({"slug": slug, "city": city, "ld": ld})
    return catalog


# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------
def publish_metrics(results: list, brand: str, stage: str = "live"):
    total = len(results)
    cited_count = sum(1 for r in results if r["citation"]["cited"])
    citation_rate = (cited_count / total * 100) if total > 0 else 0
    timestamp = datetime.now(timezone.utc)

    metric_data = [
        {"MetricName": "CitationRate", "Value": citation_rate, "Unit": "Percent",
         "Timestamp": timestamp,
         "Dimensions": [{"Name": "Brand", "Value": brand}, {"Name": "Stage", "Value": stage}]},
        {"MetricName": "TotalPrompts", "Value": total, "Unit": "Count",
         "Timestamp": timestamp, "Dimensions": [{"Name": "Brand", "Value": brand}]},
        {"MetricName": "CitedCount", "Value": cited_count, "Unit": "Count",
         "Timestamp": timestamp, "Dimensions": [{"Name": "Brand", "Value": brand}]},
    ]

    categories = {}
    for r in results:
        cat = r.get("category", "uncategorized")
        categories.setdefault(cat, {"total": 0, "cited": 0})
        categories[cat]["total"] += 1
        if r["citation"]["cited"]:
            categories[cat]["cited"] += 1
    for cat, counts in categories.items():
        cat_rate = (counts["cited"] / counts["total"] * 100) if counts["total"] > 0 else 0
        metric_data.append(
            {"MetricName": "CitationRate", "Value": cat_rate, "Unit": "Percent",
             "Timestamp": timestamp,
             "Dimensions": [{"Name": "Brand", "Value": brand}, {"Name": "Category", "Value": cat}]}
        )

    cloudwatch.put_metric_data(Namespace=CLOUDWATCH_NAMESPACE, MetricData=metric_data)
    return citation_rate


# ---------------------------------------------------------------------------
# Handler
# ---------------------------------------------------------------------------
def lambda_handler(event, context):
    """Feedback-loop entry point.

    event:
      target        "live" | "staging"           (metric Stage dimension)
      score_mode    "brand_mention" | "grounded" (overrides SCORE_MODE env)
      staged_key    optional; the candidate key to score in grounded+staging mode
    """
    event = event or {}
    stage = event.get("target", "live")
    score_mode = (event.get("score_mode") or DEFAULT_SCORE_MODE).lower()

    config = load_prompts()
    brand = config["brand"]
    match_terms = config["match_terms"]
    prompts = config["prompts"]

    catalog = _load_catalog() if score_mode == "grounded" else []
    catalog_by_slug = {c["slug"]: c for c in catalog}

    staged_key = event.get("staged_key")
    staged_slug = None
    if staged_key and staged_key.endswith(".html"):
        staged_slug = staged_key.rsplit("/", 1)[-1][:-len(".html")]

    results = []
    for prompt_config in prompts:
        prompt_id = prompt_config["id"]
        prompt_text = prompt_config["prompt"]
        category = prompt_config.get("category", "general")

        try:
            if score_mode == "grounded":
                probe_fix = _infer_fix_from_text(prompt_text)
                # Resolve the property that should answer THIS prompt (same in
                # both the live and staging passes). For the gap prompt no live
                # property satisfies it, so resolution returns "".
                sat_slug = _resolve_satisfying_property(prompt_text, probe_fix, catalog)
                if stage == "staging" and staged_slug and not sat_slug:
                    # The gap prompt: no LIVE property answers it, but the staged
                    # candidate (the patched property) now does. Score the staged
                    # page. Every OTHER prompt grounds on its own satisfying
                    # property below -- identical to the baseline pass -- so
                    # unrelated prompts can't flip the candidate-vs-baseline
                    # comparison due to model non-determinism.
                    ld = _read_property_ld(_staged_key(staged_slug))
                else:
                    ld = catalog_by_slug.get(sat_slug, {}).get("ld", {}) if sat_slug else {}
                citation = score_grounded(prompt_text, ld, match_terms, required_tag=probe_fix)
            else:
                response_text = query_bedrock(prompt_text)
                citation = check_citation(response_text, match_terms)

            result = {
                "prompt_id": prompt_id,
                "category": category,
                "prompt": prompt_text,
                "citation": citation,
                "score_mode": score_mode,
            }

            if not citation["cited"]:
                diagnosis = diagnose_gap(prompt_text, brand, match_terms)
                result["diagnosis"] = diagnosis

            results.append(result)

        except Exception as e:  # noqa: BLE001
            results.append({
                "prompt_id": prompt_id, "category": category, "prompt": prompt_text,
                "citation": {"cited": False, "matched_terms": [], "match_count": 0},
                "error": str(e),
            })

    citation_rate = publish_metrics(results, brand, stage=stage)

    # Pick the weakest ACTIONABLE gap: a not-cited prompt whose fix maps to a
    # real FIX_MAP/_TAG_ATTRIBUTE tag AND resolves to a property (in the prompt's
    # city) that genuinely lacks it. We deliberately IGNORE the model's free-text
    # top_fix (e.g. "mountain_view_confirmed") when it is not a patchable tag --
    # the model invents un-patchable tags for prompts no JSON-LD field can satisfy
    # (boutique, mountain views, distance-to-landmark). Preferring the keyword-
    # inferred tag keeps the choice deterministic and always patchable, so the
    # loop stages a candidate it can actually improve instead of a dead gap.
    loop_catalog = catalog if (score_mode == "grounded" and catalog) else _load_catalog()
    top_gap = None
    for r in results:
        if r["citation"]["cited"]:
            continue
        diag = r.get("diagnosis") or {}
        model_fix = (diag.get("top_fix") or "").strip().lower()
        # Normalize to a patchable tag: prefer a known tag the model emitted,
        # else infer one from the prompt text (always a FIX_MAP key or "").
        if model_fix in _TAG_ATTRIBUTE:
            top_fix = model_fix
        else:
            top_fix = _infer_fix_from_text(r["prompt"])
        if top_fix not in _TAG_ATTRIBUTE:
            continue  # no patchable fix for this prompt -> skip (not a dead gap)
        slug = resolve_property(r["prompt"], top_fix, loop_catalog)
        if not slug:
            continue  # nothing in the prompt's city lacks it -> not an actionable gap
        top_gap = {
            "prompt_id": r["prompt_id"],
            "category": r.get("category"),
            "top_fix": top_fix,
            "property_slug": slug,
        }
        break

    summary = {
        "brand": brand,
        "stage": stage,
        "score_mode": score_mode,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "total_prompts": len(results),
        "cited_count": sum(1 for r in results if r["citation"]["cited"]),
        "citation_rate_pct": round(citation_rate, 1),
        # Per-prompt signal for the validator: did the gap prompt (the one the
        # loop is patching) end up cited in THIS pass? Immune to unrelated
        # borderline prompts flipping between two independently-sampled runs.
        "gap_prompt_cited": next(
            (r["citation"]["cited"] for r in results
             if top_gap and r["prompt_id"] == top_gap["prompt_id"]),
            None,
        ),
        "top_gap": top_gap,
        "results": results,
    }
    print(f"[{score_mode}/{stage}] CitationRate {summary['citation_rate_pct']}% "
          f"({summary['cited_count']}/{summary['total_prompts']})  top_gap={top_gap}")
    return summary