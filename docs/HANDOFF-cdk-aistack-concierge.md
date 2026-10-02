# GEO Blog — Handoff to CDK Owner (AiStack + Concierge)

**From:** Sasha (console build) · **To:** Sangeetha (CDK)
**Repo:** `generative-engine-optimization-aws`
**Date:** 2026-10-02

This note covers two things: (1) new files I added to the repo and how they're meant to deploy, and (2) a now-unblocked CDK task — `AiStack` can provision the AgentCore harness natively, it no longer has to be a manual console step.

---

## 1. What I added to the repo (on a feature branch → MR)

All changes are on `feature/onsite-concierge-and-adaptation-docs` (not pushed straight to `main`).

### A. On-site concierge (the chatbot on index.html)
A visitor-facing chat widget that calls the `geo-concierge` harness and returns live answers from Aurora. **Verified working end to end** against the real harness (returned 6 Denver pet-friendly properties with rates).

| File | What it is |
|------|-----------|
| `assets/code/chat-endpoint/lambda_function.py` | `geo-onsite-chat` Lambda — thin PUBLIC endpoint. Calls `invoke_harness` on the data-plane client, parses the EventStream, returns `{reply, sessionId}`. |
| `assets/code/chat-endpoint/openapi-chat-apigw-import.json` | Public `/chat` route spec (AWS_PROXY, **no IAM auth** — browser-facing). |
| `assets/web_application/index.html` | Concierge widget (style + launcher + panel + fetch) injected before `</body>`. Set `CHAT_ENDPOINT` to the deployed `/chat` URL. |

**NOT yet wired into CDK** — these are source files; there's no construct deploying `geo-onsite-chat` or the `/chat` route yet. See §2.

**Verified invoke contract (important — differs from a code runtime):**
- A **managed harness** is invoked with `invoke_harness` on client `bedrock-agentcore` — NOT `invoke_agent_runtime` (that raises ValidationException on a harness).
- Resource is the **harness ARN**, which is NOT the runtime ARN with `runtime/`→`harness/`. They have different IDs. The real one (discovered via `list_harnesses`):
  `arn:aws:bedrock-agentcore:us-east-1:501683248676:harness/geo_concierge-rl1hZrpjvI`
- Input: `messages=[{"role":"user","content":[{"text": ...}]}]` (Converse-style), not `{"prompt": ...}`.
- Response: EventStream in `resp["stream"]`; reply text is in `contentBlockDelta.delta.text` events.
- **IAM: the Lambda role needs BOTH** `bedrock-agentcore:InvokeHarness` AND `bedrock-agentcore:InvokeAgentRuntime` on the harness ARN (documented requirement — missing the second = AccessDenied).

**Lambda deploy config:**
```
Handler: lambda_function.handler   Runtime: Python 3.13   Timeout: 30s
Env:
  HARNESS_ARN       = arn:aws:bedrock-agentcore:us-east-1:501683248676:harness/geo_concierge-rl1hZrpjvI
  ALLOWED_ORIGIN    = https://d33b4fqje003hr.cloudfront.net   (the live CloudFront origin)
  MAX_MESSAGE_CHARS = 500
  HARNESS_QUALIFIER = (omit — DEFAULT endpoint)
```
Then: add a public `/chat` route (import the OpenAPI spec), grant API Gateway `lambda:InvokeFunction`, throttle it (~5 req/s), point the widget's `CHAT_ENDPOINT` at it, re-upload index.html, invalidate `/`.

### B. Customer adaptation markers (comment/doc only — zero runtime impact)
Makes the domain-specific slots obvious so adopters know what to change.

| File | Change |
|------|--------|
| `assets/code/citation-tracker/lambda_function.py` | `CUSTOMIZE FOR YOUR ENVIRONMENT` comments above `_FIX_KEYWORDS` and the `property_slug` resolution |
| `assets/code/patch-applier/lambda_function.py` | `CUSTOMIZE FOR YOUR ENVIRONMENT` comment above `FIX_MAP` |
| `docs/ADAPTING.md` | NEW — keep-vs-adapt table, the 4 code slots to change, config-only knobs, sample-data notes |
| `docs/README.md` | Links `ADAPTING.md` in the docs index |

---

## 2. AiStack CAN provision the harness natively (now-unblocked task)

`lib/stacks/ai-stack.ts` is currently an **empty placeholder** with TODOs describing the *old* plan (classic Bedrock Agent + action groups + KB) — which predates the pivot to AgentCore. It provisions nothing.

**The good news (verified against the AWS CloudFormation template reference, updated 2026-10-02):** the whole AgentCore layer is GA in CloudFormation / CDK — no Lambda-backed custom resource needed:

| CFN resource type | Reproduces (console-built) |
|-------------------|----------------------------|
| `AWS::BedrockAgentCore::Gateway` + `GatewayTarget` | `geo-hotel-gateway` → API Gateway target |
| `AWS::BedrockAgentCore::Harness` | `geo-concierge` harness |
| `AWS::BedrockAgentCore::HarnessEndpoint` | the DEFAULT endpoint |

CDK L1 constructs are in **`aws-cdk-lib/aws-bedrockagentcore`** (`CfnHarness`, `CfnGateway`, `CfnGatewayTarget`, `CfnHarnessEndpoint`) — this repo is TypeScript, so use those (requires a recent CDK v2).

**`CfnHarness` shape** (maps to the console harness):
- `harnessName` (required; `[a-zA-Z][a-zA-Z0-9_]{0,39}`, immutable — changing it forces replacement)
- `executionRoleArn` (required)
- `model.bedrockModelConfig.modelId` = `global.anthropic.claude-sonnet-4-6` (supply explicitly for determinism)
- `tools: [{ type: "agentcore_gateway", name: ..., config.agentcoreGatewayConfig.gatewayArn: <CfnGateway ARN> }]`
- optional: `systemPrompt`, `maxIterations`, `timeoutSeconds`

`Fn::GetAtt` exposes `Arn`, `HarnessId`, and the underlying `AgentRuntimeArn` — so a `CfnHarnessEndpoint` and the concierge Lambda's `HARNESS_ARN` can reference it directly instead of a hardcoded value.

Reference: AWS blog "Build AI agents with Amazon Bedrock AgentCore using AWS CloudFormation" (Jan 2026) walks through Harness + Gateway + Memory via CFN.

### Suggested AiStack scope
1. `CfnGateway` + `CfnGatewayTarget` (API Gateway target, IAM outbound) — reproduces `geo-hotel-gateway`
2. `CfnHarness` (gateway tool, Sonnet model, exec role) + `CfnHarnessEndpoint`
3. (optional, if you want the concierge in CDK too) the `geo-onsite-chat` Lambda from `assets/code/chat-endpoint/` + a public `/chat` route, with `HARNESS_ARN` wired from the `CfnHarness` GetAtt

Once AiStack provisions the harness, the "deploy it yourself" story is complete — no manual console prerequisite.

---

## 3. Two consistency nits to reconcile (console vs CDK)
- **Path prefix:** this repo uses `web_application` (underscore); my console build standardized on `web-application` (hyphen). Pick one before publish.
- **citation-tracker `BEDROCK_MODEL_ID` default** is still the old Haiku id in code — fine (env-overridden at deploy), but worth bumping the default to the Sonnet inference-profile id for a clean from-scratch deploy.
