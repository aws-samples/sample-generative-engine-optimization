"""

Citation Tracker Lambda Function

================================

Queries LLMs via Amazon Bedrock with curated prompts and checks whether

your brand appears in the generated responses. Records citation-share

metrics to CloudWatch.



Schedule: Run weekly via EventBridge (e.g., every Monday 8:00 AM UTC)

IAM permissions required:

  - bedrock:InvokeModel

  - cloudwatch:PutMetricData

  - s3:GetObject (for prompts.json if stored in S3)

"""



import json

import os

import re

from datetime import datetime



import boto3



# Configuration

PROMPTS_FILE = os.environ.get("PROMPTS_FILE", "prompts.json")

BEDROCK_MODEL_ID = os.environ.get("BEDROCK_MODEL_ID", "anthropic.claude-3-haiku-20240307-v1:0")

CLOUDWATCH_NAMESPACE = os.environ.get("CW_NAMESPACE", "GEO/CitationTracker")

AWS_REGION = os.environ.get("AWS_REGION", "us-east-1")



bedrock_runtime = boto3.client("bedrock-runtime", region_name=AWS_REGION)

cloudwatch = boto3.client("cloudwatch", region_name=AWS_REGION)





def load_prompts():

    """Load target prompts from local file or S3."""

    # For Lambda deployment, bundle prompts.json alongside this file

    # or load from S3: s3.get_object(Bucket=..., Key=...)

    with open(PROMPTS_FILE, "r") as f:

        return json.load(f)





def query_bedrock(prompt: str) -> str:

    """Invoke Bedrock model with a user prompt and return the response text."""

    body = json.dumps({

        "anthropic_version": "bedrock-2023-05-31",

        "max_tokens": 1024,

        "messages": [

            {

                "role": "user",

                "content": prompt

            }

        ]

    })



    response = bedrock_runtime.invoke_model(

        modelId=BEDROCK_MODEL_ID,

        body=body,

        contentType="application/json",

        accept="application/json"

    )



    result = json.loads(response["body"].read())

    return result["content"][0]["text"]





def check_citation(response_text: str, match_terms: list) -> dict:

    """Check if any brand terms appear in the LLM response."""

    response_lower = response_text.lower()

    matches = []

    for term in match_terms:

        if term.lower() in response_lower:

            matches.append(term)

    return {

        "cited": len(matches) > 0,

        "matched_terms": matches,

        "match_count": len(matches)

    }





# Keyword -> FIX_MAP tag inference. Keys are substrings to look for in the prompt;

# values are tags the patch-applier's FIX_MAP knows how to apply. This guarantees a

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





def _infer_fix_from_text(text: str) -> str:

    """Map free text to a known FIX_MAP tag by keyword. Returns '' if none match."""

    low = (text or "").lower()

    for kw, tag in _FIX_KEYWORDS:

        if kw in low:

            return tag

    return ""





def diagnose_gap(prompt: str, brand: str, property_terms: list) -> dict:

    """Ask the model WHY the brand wasn't cited, and what information is missing.



    This is the diagnostic half of the feedback loop. When a target prompt does

    NOT cite the brand, we ask the model a follow-up: which sources it would need,

    and what specific attributes are missing for our property. The model's answer

    is an APPROXIMATION (a rationalization, not an authoritative ranking log), so

    treat the output as a directional hypothesis to test — not ground truth.

    The real signal is whether citation share improves after acting on it.

    """

    focus = property_terms[0] if property_terms else brand

    diag_prompt = (

        f"A user asked: \"{prompt}\"\n\n"

        f"Consider the business \"{focus}\". If you did NOT mention it in your answer, "

        f"explain concretely why. Specifically:\n"

        f"1. What information about {focus} would you need to confidently recommend it "

        f"for this query (e.g., amenities, price, location details, pet policy, availability)?\n"

        f"2. Which of those details appear to be missing or unclear?\n"

        f"3. List the single most important attribute to add, as a short tag "

        f"(e.g., 'pet_policy', 'nightly_rate', 'pool', 'distance_to_landmark').\n\n"

        f"Answer in JSON: {{\"needed\": [...], \"missing\": [...], \"top_fix\": \"...\"}}"

    )

    try:

        raw = query_bedrock(diag_prompt)

        # Extract the JSON object from the response, tolerating code fences/prose.

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

        # Fallback: if the model didn't emit a usable tag, infer one from the

        # prompt text using keywords that map to real patch-applier FIX_MAP tags.

        if not top_fix:

            top_fix = _infer_fix_from_text(prompt + " " + " ".join(str(m) for m in parsed.get("missing", [])))

        return {

            "needed": parsed.get("needed", []),

            "missing": parsed.get("missing", []),

            "top_fix": top_fix,

            "raw": raw[:500],

        }

    except Exception as e:  # noqa: BLE001

        return {"needed": [], "missing": [], "top_fix": "", "error": str(e)}





def publish_metrics(results: list, brand: str, stage: str = "live"):

    """Publish citation metrics to CloudWatch."""

    total = len(results)

    cited_count = sum(1 for r in results if r["citation"]["cited"])

    citation_rate = (cited_count / total * 100) if total > 0 else 0



    timestamp = datetime.utcnow()



    metric_data = [

        {

            "MetricName": "CitationRate",

            "Value": citation_rate,

            "Unit": "Percent",

            "Timestamp": timestamp,

            "Dimensions": [{"Name": "Brand", "Value": brand}, {"Name": "Stage", "Value": stage}]

        },

        {

            "MetricName": "TotalPrompts",

            "Value": total,

            "Unit": "Count",

            "Timestamp": timestamp,

            "Dimensions": [{"Name": "Brand", "Value": brand}]

        },

        {

            "MetricName": "CitedCount",

            "Value": cited_count,

            "Unit": "Count",

            "Timestamp": timestamp,

            "Dimensions": [{"Name": "Brand", "Value": brand}]

        }

    ]



    # Per-category metrics

    categories = {}

    for r in results:

        cat = r.get("category", "uncategorized")

        if cat not in categories:

            categories[cat] = {"total": 0, "cited": 0}

        categories[cat]["total"] += 1

        if r["citation"]["cited"]:

            categories[cat]["cited"] += 1



    for cat, counts in categories.items():

        cat_rate = (counts["cited"] / counts["total"] * 100) if counts["total"] > 0 else 0

        metric_data.append({

            "MetricName": "CitationRate",

            "Value": cat_rate,

            "Unit": "Percent",

            "Timestamp": timestamp,

            "Dimensions": [

                {"Name": "Brand", "Value": brand},

                {"Name": "Category", "Value": cat}

            ]

        })



    cloudwatch.put_metric_data(

        Namespace=CLOUDWATCH_NAMESPACE,

        MetricData=metric_data

    )



    return citation_rate





def lambda_handler(event, context):

    """Main Lambda handler."""

    # Feedback-loop mode: event may specify {"target": "live"|"staging", "staged_key": "..."}.

    # In "staging" mode the tracker scores the candidate content (the promoter compares

    # this candidate rate against the live baseline). Default is "live".

    event = event or {}

    stage = event.get("target", "live")

    config = load_prompts()

    brand = config["brand"]

    match_terms = config["match_terms"]

    prompts = config["prompts"]



    results = []

    for prompt_config in prompts:

        prompt_id = prompt_config["id"]

        prompt_text = prompt_config["prompt"]

        category = prompt_config.get("category", "general")



        print(f"Querying: {prompt_id} — {prompt_text[:60]}...")



        try:

            response_text = query_bedrock(prompt_text)

            citation = check_citation(response_text, match_terms)



            result = {

                "prompt_id": prompt_id,

                "category": category,

                "prompt": prompt_text,

                "citation": citation,

                "response_preview": response_text[:200]

            }



            # Feedback loop: if NOT cited, ask the model why and what's missing.

            if not citation["cited"]:

                diagnosis = diagnose_gap(prompt_text, brand, match_terms)

                result["diagnosis"] = diagnosis

                if diagnosis.get("top_fix"):

                    print(f"  → gap diagnosis — top fix to add: {diagnosis['top_fix']}")



            results.append(result)



            status = "✓ CITED" if citation["cited"] else "✗ NOT CITED"

            print(f"  {status} (matched: {citation['matched_terms']})")



        except Exception as e:

            print(f"  ERROR: {str(e)}")

            results.append({

                "prompt_id": prompt_id,

                "category": category,

                "prompt": prompt_text,

                "citation": {"cited": False, "matched_terms": [], "match_count": 0},

                "error": str(e)

            })



    # Publish metrics

    citation_rate = publish_metrics(results, brand, stage=stage)



    # Build a single "top_gap" the state machine can branch on: the first

    # not-cited prompt that produced a top_fix, mapped to a property slug to patch.

    top_gap = None

    for r in results:

        diag = r.get("diagnosis") or {}

        if not r["citation"]["cited"] and diag.get("top_fix"):

            top_gap = {

                "prompt_id": r["prompt_id"],

                "category": r.get("category"),

                "top_fix": diag["top_fix"],

                # CUSTOMIZE FOR YOUR ENVIRONMENT (property resolution): the demo maps
                # every diagnosed gap to ONE representative property (default_patch_slug),
                # which works only because the demo has a fixed set of known pages.
                # In production, resolve the SPECIFIC page the gap refers to -- parse the
                # prompt/answer for the entity and match your catalog, or let an agent
                # decide (the Blog 2 agentic version does this).
                # Demo: map the diagnosed gap to a representative property to patch.

                # A production version would resolve the specific property from the prompt.

                "property_slug": config.get("default_patch_slug", "octank-hotels-denver-downtown"),

            }

            break



    summary = {

        "brand": brand,

        "stage": stage,

        "timestamp": datetime.utcnow().isoformat(),

        "total_prompts": len(results),

        "cited_count": sum(1 for r in results if r["citation"]["cited"]),

        "citation_rate_pct": round(citation_rate, 1),

        "top_gap": top_gap,

        "results": results

    }



    print(f"\n{'='*60}")

    print(f"Citation Rate: {summary['citation_rate_pct']}% "

          f"({summary['cited_count']}/{summary['total_prompts']} prompts)")

    print(f"{'='*60}")



    return summary

