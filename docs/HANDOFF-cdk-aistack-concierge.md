# GEO Blog — Handoff to CDK Owner (AiStack + Concierge)

**From:** Sasha (console build) · **To:** Pavan (CDK owner)
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

> **STATUS (updated 2026-10-02): `ai-stack.ts` is now SCAFFOLDED, not empty.** I replaced the
> placeholder with a working first pass that provisions the Gateway + GatewayTarget + Harness +
> HarnessEndpoint and the two service roles (see §4 and §5). I also added a `restApiId` getter to
> `compute-stack.ts`. **One wiring edit in `bin/app.ts` is still needed from you** (see §5) — and a
> `cdk synth` pass to settle any AgentCore L1 prop-name drift against the installed CDK version.

`lib/stacks/ai-stack.ts` was originally an **empty placeholder** with TODOs describing the *old* plan (classic Bedrock Agent + action groups + KB) — which predates the pivot to AgentCore. It is now scaffolded (§4/§5).

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


---

## 4. How the harness is built in CDK — what's in the scaffold

**This is now implemented in `lib/stacks/ai-stack.ts`** (I replaced the placeholder).
The code below is what the scaffold contains, for reference/review — you don't need
to write it, but you DO need to `cdk synth` it and settle any prop-name drift (see the
⚠️ note below) and make the `bin/app.ts` wiring edit in §5.
TypeScript L1 constructs live in
`aws-cdk-lib/aws-bedrockagentcore` (requires a recent CDK v2 — verify the module
is present with `npm ls aws-cdk-lib` and that `CfnHarness` is exported; if the
installed CDK predates it, `npm i aws-cdk-lib@latest`).

### Step 1 — Harness execution role
The role the harness assumes at runtime. It must be able to invoke the Bedrock
model (via the inference profile) and reach the Gateway.

```ts
import * as iam from 'aws-cdk-lib/aws-iam';

const harnessRole = new iam.Role(this, 'HarnessExecRole', {
  assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
});

// Model access MUST include the inference-profile ARN (not just foundation-model) —
// Sonnet 4.6 invokes via the global inference profile, else AccessDenied.
harnessRole.addToPolicy(new iam.PolicyStatement({
  actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
  resources: [
    `arn:aws:bedrock:*::foundation-model/anthropic.claude-*`,
    `arn:aws:bedrock:*:${this.account}:inference-profile/global.anthropic.claude-*`,
  ],
}));
```

### Step 2 — Gateway + target (reproduces `geo-hotel-gateway`)
MCP gateway fronting the existing API Gateway REST API (IAM-secured). Inbound
auth = IAM/SigV4; outbound to the API = IAM role.

```ts
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';

const gateway = new agentcore.CfnGateway(this, 'GeoHotelGateway', {
  name: 'geo-hotel-gateway',
  protocolType: 'MCP',
  authorizerType: 'AWS_IAM',               // inbound SigV4
  roleArn: gatewayRole.roleArn,            // outbound role with execute-api:Invoke
});

// API Gateway target: auto-translates the REST API schema into MCP tools.
new agentcore.CfnGatewayTarget(this, 'GeoApiTarget', {
  gatewayIdentifier: gateway.attrGatewayId,
  name: 'geo-api',
  targetConfiguration: {
    mcp: {
      apiGateway: {                        // API_GATEWAY target type
        // The existing REST API id + stage (from ComputeStack output):
        apiGatewayArn: `arn:aws:apigateway:${this.region}::/restapis/${restApiId}/stages/v1`,
      },
    },
  },
  credentialProviderConfigurations: [{ credentialProviderType: 'GATEWAY_IAM_ROLE' }],
});
```

> The exact nested property names (e.g. `mcp.apiGateway`) can vary slightly by
> CDK version — check the `CfnGatewayTarget` prop types in your installed
> `aws-cdk-lib`. The shape above matches the GA CloudFormation reference.

### Step 3 — Harness + endpoint (reproduces `geo-concierge`)
```ts
const harness = new agentcore.CfnHarness(this, 'GeoConcierge', {
  harnessName: 'geo_concierge',            // [a-zA-Z][a-zA-Z0-9_]{0,39}; immutable (change = replace)
  executionRoleArn: harnessRole.roleArn,
  model: {
    bedrockModelConfig: { modelId: 'global.anthropic.claude-sonnet-4-6' },
  },
  systemPrompt: [{
    text: 'You are the Octank Hospitality concierge. Help travelers find rooms, ' +
          'check availability, and compare rates using the available tools. ' +
          'Only answer from tool results; never invent properties or prices.',
  }],
  tools: [{
    type: 'agentcore_gateway',
    name: 'geo-hotel-gateway',
    config: { agentcoreGatewayConfig: { gatewayArn: gateway.attrGatewayArn } },
  }],
  maxIterations: 10,
  timeoutSeconds: 120,
});

// Stable DEFAULT endpoint callers invoke against.
new agentcore.CfnHarnessEndpoint(this, 'GeoConciergeEndpoint', {
  harnessId: harness.attrHarnessId,
  name: 'DEFAULT',
});
```

### Step 4 — Expose the harness ARN for the concierge Lambda
Instead of hardcoding `HARNESS_ARN`, wire it from the harness via GetAtt so the
`geo-onsite-chat` Lambda always points at the CDK-created harness:

```ts
this.harnessArn = harness.attrArn;  // export as a stack prop

// In ComputeStack (or wherever geo-onsite-chat is defined):
onsiteChat.addEnvironment('HARNESS_ARN', aiStack.harnessArn);
onsiteChat.addToRolePolicy(new iam.PolicyStatement({
  actions: [
    'bedrock-agentcore:InvokeHarness',
    'bedrock-agentcore:InvokeAgentRuntime',   // BOTH required on the harness ARN
  ],
  resources: [aiStack.harnessArn],
}));
```

### Step 5 — Deploy order / wiring
**⚠️ THE ONE EDIT YOU STILL NEED TO MAKE** — `bin/app.ts` currently builds `AiStack`
with only `baseProps`, BEFORE `ComputeStack`, with `ai.addStackDependency(storage)`.
The scaffold now needs `restApiId` + `apiStageName` from ComputeStack, so AiStack must
move to AFTER `const compute = new ComputeStack(...)`. Replace the old pre-compute block:

```ts
// REMOVE this (it's before ComputeStack):
const ai = new AiStack(app, `${prefix}-ai`, baseProps);
ai.addStackDependency(storage);
```

```ts
// ADD this AFTER `const compute = new ComputeStack(...)`:
const ai = new AiStack(app, `${prefix}-ai`, {
  ...baseProps,
  restApiId: compute.restApiId,       // getter I added to compute-stack.ts
  apiStageName: compute.apiStageName,
});
// (dependency on compute is implicit via the two references passed above)
```

Then, when you add the `geo-onsite-chat` Lambda to ComputeStack, wire it from AiStack's
`harnessArn` getter (see Step 4) — set `HARNESS_ARN = ai.harnessArn` and grant BOTH
`InvokeHarness` + `InvokeAgentRuntime` on it.

**Then:**
- `cdk synth` first to confirm the AgentCore props resolve against your installed
  CDK version; fix any prop-name drift the synth flags (the `CfnGatewayTarget` nested
  `targetConfiguration.mcp.apiGateway` shape is the most likely to need adjusting).
- `cdk deploy <prefix>-ai` — then confirm with:
  `aws bedrock-agentcore-control list-harnesses --region us-east-1`
  and a probe invoke (`invoke_harness` with the new harness ARN).

### Mapping to the console-built resources (so behavior matches)
| Console resource | CDK construct |
|------------------|---------------|
| `geo-hotel-gateway` (MCP, IAM inbound, API Gateway target) | `CfnGateway` + `CfnGatewayTarget` |
| `geo-concierge` harness (Sonnet, gateway tool) | `CfnHarness` |
| harness DEFAULT endpoint | `CfnHarnessEndpoint` |
| `geo-harness-exec-role` / `geo-gateway-role` | `iam.Role`s above (inference-profile ARN in model policy) |

### Validation checklist after deploy
- [ ] `list-harnesses` shows the new harness `READY`
- [ ] A probe `invoke_harness` returns live Aurora data (search → rates tool loop)
- [ ] The `geo-onsite-chat` Lambda's `HARNESS_ARN` resolves to the CDK harness ARN
- [ ] Lambda role has BOTH `InvokeHarness` + `InvokeAgentRuntime` on that ARN
- [ ] Model policy includes the inference-profile ARN (not just foundation-model)

> Note: the harness built from scratch here will have a DIFFERENT id/suffix than
> the console one (`geo_concierge-rl1hZrpjvI`). That's expected — never hardcode
> the console ARN in CDK; use the `CfnHarness` GetAtt so everything references the
> stack-created resource.
