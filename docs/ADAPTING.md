# Adapting this to your environment

This reference implementation runs end to end on a fictional hotel brand
(**Octank Hospitality**) so you can deploy it and watch every layer work before
adapting it to your own business.

The architecture and measurement layers are reusable almost as-is. The parts you
change are the parts that *should* be yours — your **content model** and your
**domain**. No GEO solution can ship unchanged for a hotel chain, a SaaS vendor,
and a hospital, because the content being made discoverable is inherently
domain-specific. What transfers is the pattern, the wiring, and the AWS plumbing.

## What you keep vs. what you adapt

| Layer | What it is | Keep as-is? | What you adapt |
|-------|-----------|-------------|----------------|
| **Foundation (Be Cited)** | S3 + CloudFront + OAC, embedded JSON-LD, `llms.txt`, crawler-friendly `robots.txt` | ✅ Keep — copy-paste infra | Your pages and your schema.org type (Hotel → your entity) |
| **Crawler measurement** | Athena table + AI-crawler detection queries over CloudFront logs | ✅ Keep — runs unchanged on any CloudFront log | Nothing structural; just point it at your log prefix |
| **Citation tracking** | Lambda queries an LLM, checks if you're cited, publishes a CloudWatch metric | ✅ Keep the loop | Your prompts and brand match-terms (config) |
| **Be Called (API)** | AgentCore Gateway + API Gateway (IAM) + Lambda + data store | ✅ Keep the pattern | Your endpoints and your data layer |
| **Feedback-loop mechanics** | Step Functions: measure → diagnose → patch to staging → re-test → validate (stage-only) | ✅ Keep the state machine + safety model | — |
| **Gap → fix mapping** | `FIX_MAP` tags + property resolution | ⚙️ **Adapt** — this is your content model | Your attributes, your fields, how a gap maps to a page |
| **Prompts / brand terms** | The queries the tracker scores against | ⚙️ **Adapt** | Your real queries and brand names |

Roughly: the foundation, measurement, API pattern, and loop skeleton transfer
directly. The content-mapping layer is where you plug in your domain.

## The exact code slots to change

Each is marked `CUSTOMIZE FOR YOUR ENVIRONMENT` in the source.

| Extension point | File | What to change |
|-----------------|------|----------------|
| **Gap keyword inference** | `assets/code/citation-tracker/lambda_function.py` → `_FIX_KEYWORDS` | The keywords that map a query to a fix tag — replace hotel amenities with your attributes |
| **Property / page resolution** | `assets/code/citation-tracker/lambda_function.py` → the `top_gap` block (`default_patch_slug`) | How a diagnosed gap resolves to a specific page in your catalog |
| **Fix catalog** | `assets/code/patch-applier/lambda_function.py` → `FIX_MAP` | The structured-data mutations for YOUR entity type (keep tags in sync with `_FIX_KEYWORDS`) |
| **Prompts & brand terms** | `assets/code/citation-tracker/prompts.json` | Your real queries and brand match-terms (config — no code change) |

### Config-only knobs (no code change)

- **`promoter`** — `ORIGIN_PATH_PREFIX` env var must match your CloudFront origin
  path so the manual-invalidation command emits the public URL path, not the S3 key.
- **`citation-tracker`** — `BEDROCK_MODEL_ID` selects the model; set it to the
  inference-profile ID for the model you use, and make sure the execution role is
  scoped to that profile ARN.
- Infra tunables (VPC CIDR, NAT, sizing) live in `lib/config/` — see
  [CONFIGURATION.md](CONFIGURATION.md).

## Why the demo uses deterministic shortcuts

The `FIX_MAP` and the hardcoded page resolution are intentional 200-level
simplifications: a deterministic lookup table (no LLM) keeps the loop reproducible
— the same gap always produces the same patch. The companion "agentic" design
replaces them with an agent that resolves the page and reasons about the missing
content, rather than looking it up in a table.

## Note on sample data

- The synthetic CloudFront logs (`E2EXAMPLE.*` in `logs/cf-logs/`) simulate
  AI-crawler traffic and a deliberate discoverability gap so the Athena queries
  and dashboard return meaningful results **before** real AI crawlers discover
  your site. Real logs accumulate in the same prefix; the detection queries run
  identically over both. Remove the synthetic files once you have real traffic.
- Octank is a fictional brand, so a live citation run scores ~0% — that is the
  expected "before" state the loop exists to improve, not a failure.
