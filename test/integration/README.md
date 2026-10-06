# Integration Tests

These tests run against **real, deployed AWS resources** — unlike the unit tests
(which only synthesize templates). They are organized around the blog's business
scenario: a traveler asks an AI, *"Find a pet-friendly hotel in Denver this
weekend under $200 and book it"*, and each test file exercises one of the three
GEO discoverability layers against the live Octank Hospitality deployment.

## Quick start

```bash
# 1. Deploy the stacks (see root README)
npm run deploy -- --all

# 2. Point the tests at the deployment
export BLOG_URL="https://dxxxxxxxxxxxxx.cloudfront.net"

# 3. Run the integration suite
npm run test:integ
```

Grab the CloudFront URL from the EdgeStack output:

```bash
export BLOG_URL="https://$(aws cloudformation describe-stacks \
  --stack-name geo-demo-dev-edge \
  --query "Stacks[0].Outputs[?OutputKey=='DistributionDomainName'].OutputValue" \
  --output text)"
```

## Test files

| File | Blog layer | What it covers |
|------|-----------|----------------|
| `smoke.integ.test.ts` | — | Minimal edge check (CloudFront 2xx) |
| `foundation.integ.test.ts` | Be cited | `llms.txt`, `robots.txt` AI crawlers, `sitemap.xml`, LodgingBusiness JSON-LD, security headers |
| `agentic.integ.test.ts` | Be called | Traveler journey: `searchProperties` → `getAvailability` → `getRates` → `createReservation` idempotency, typed inputs, structured errors |
| `measurement.integ.test.ts` | Measure & improve | Athena crawler-detection query, Step Functions feedback loop exists + stage-only guarantee, (Bedrock citation-tracker — gated) |

## Environment variables

Every `describe` block is guarded by `describeIfDeployed([...])`, which
**self-skips** when any required env var is missing — so the suite stays green
in CI without a live deployment. Set only the vars for the layers you want to
exercise.

### Minimum (foundation + agentic layers)

| Variable | Required by | Example |
|----------|------------|---------|
| `BLOG_URL` | foundation, smoke, agentic (fallback) | `https://dxxxxxxx.cloudfront.net` |

The agentic tests derive the API base from `BLOG_URL/api`. If you want to hit
the API Gateway directly (bypassing CloudFront), set `API_URL` instead:

| Variable | Required by | Example |
|----------|------------|---------|
| `API_URL` | agentic (direct, optional) | `https://xxxx.execute-api.us-east-1.amazonaws.com/prod` |

### Measurement layer

| Variable | Required by | Example |
|----------|------------|---------|
| `ATHENA_WORKGROUP` | Athena tests | `geo-demo-dev-analytics` |
| `ATHENA_DATABASE` | Athena tests | `geo_demo_dev_logs` |
| `STATE_MACHINE_ARN` | Step Functions tests | `arn:aws:states:us-east-1:...:stateMachine:geo-demo-dev-feedback-loop` |
| `CONTENT_BUCKET` | stage-only safety tests | `geo-demo-dev-content-<acct>-<region>` |

### Optional / gated

| Variable | Required by | Notes |
|----------|------------|-------|
| `PROMOTER_FN` | IAM stage-only test | Defaults to `geo-demo-dev-promoter` if unset |
| `CITATION_TRACKER_FN` | Bedrock invocation test | Lambda function name |
| `RUN_BEDROCK_TESTS` | Bedrock invocation test | Set to `1` to enable — invokes Bedrock (costs money, needs model access) |

### All-at-once (copy-paste for the full live deploy)

```bash
export BLOG_URL="https://d244uo85mcbvmh.cloudfront.net"
export API_URL="https://mz186qnor8.execute-api.us-east-1.amazonaws.com/prod"
export ATHENA_WORKGROUP="geo-demo-dev-analytics"
export ATHENA_DATABASE="geo_demo_dev_logs"
export STATE_MACHINE_ARN="arn:aws:states:us-east-1:230925740158:stateMachine:geo-demo-dev-feedback-loop"
export CONTENT_BUCKET="geo-demo-dev-content-230925740158-us-east-1"
export CITATION_TRACKER_FN="geo-demo-dev-citation-tracker"
# export RUN_BEDROCK_TESTS=1  # uncomment to test Bedrock (costs ~$0.50)

npm run test:integ
```

## How it works

- Tests read endpoints from env vars and call the live deployment (HTTPS, AWS
  CLI). Each block is guarded by `describeIfDeployed([...])` which skips the
  block when any required var is missing.
- **Foundation + agentic** tests use Node's built-in `fetch` — no extra
  dependencies.
- **Measurement** tests use the AWS CLI via `child_process.execFileSync` — same
  credentials, no SDK packages added to the project.
- The Jest timeout is 300s (via `jest.setup.ts`) for Athena/Lambda calls.

## Blog-vs-code findings

As you run the tests, note any mismatches between the blog's description and the
deployed code's actual behavior. Known examples:

- **`llms.txt` advertises `/api/v1/...`** but the deployed API path through
  CloudFront is `/api/<resource>` (no `/v1`). The `ApiPathRewrite` function
  strips `/api` and forwards to the stage.
- **`createReservation` is a stub** — the blog describes DB-level idempotency
  via upsert, but the sample handler returns a hashed confirmation number
  without writing to Aurora. The externally observable contract (same in → same
  out) is the same, but the mechanism differs.
- **`getAvailability` returns HTTP 200 on empty results** — with a structured
  `{error: "no_availability", ...}` body, not a 4xx.
