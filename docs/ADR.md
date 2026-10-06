# Architecture Decision Records

A single log of the significant architecture decisions for the **Octank
Hospitality** GEO platform. Each record is lightweight (context → decision →
consequences → alternatives). Newest decisions are appended at the end.

Status legend: **Accepted** (in effect), **Superseded** (replaced by a later
ADR), **Proposed** (under consideration).

---

## ADR-0001 — Stack-per-concern with reusable L3 constructs

**Status:** Accepted

**Context.** The platform spans networking, storage, a database, compute, an
edge CDN, a feedback-loop workflow, analytics, logging, and (synth-only) an
agentic layer. A single monolithic stack would couple unrelated resources,
slow deploys, and make blast radius large.

**Decision.** Model one CDK stack per concern (`lib/stacks/`), each composing a
matching reusable L3 construct (`lib/constructs/`). Wire dependencies by passing
references in `bin/app.ts`.

**Consequences.** Each component deploys and tears down independently; unit
tests target one stack each. Teardown must follow reverse dependency order
(enforced by strong cross-stack references — see ADR-0005). Construct classes
keep a legacy `Blog*` prefix; a rename was deferred to avoid churn.

**Alternatives considered.** Single stack (rejected: blast radius, slow
iteration); nested stacks (rejected: harder to reason about and test in
isolation).

---

## ADR-0002 — Lambda → Aurora over the RDS Data API, not socket connections

**Status:** Accepted

**Context.** VPC-attached Lambdas need to query Aurora PostgreSQL. Traditional
socket pooling from Lambda is awkward (connection storms, idle-connection
limits) and the functions discovered in the target account already used the
Data API.

**Decision.** Enable the **RDS Data API** on the Aurora Serverless v2 cluster and
have Lambdas call it over HTTPS via an `rds-data` VPC interface endpoint, using
the cluster ARN + a Secrets Manager secret ARN.

**Consequences.** No connection pooling to manage; traffic stays on the AWS
network via the endpoint; credentials never leave Secrets Manager. Path params
arrive as strings and must be cast server-side (e.g. `:pid::int`). An optional
RDS Proxy remains available behind a config flag for future socket workloads.

**Alternatives considered.** Direct `psql` sockets + RDS Proxy (rejected for the
200-level demo: more moving parts); data access Lambda layer (unnecessary).

---

## ADR-0003 — Single regional NAT gateway

**Status:** Accepted

**Context.** Private-egress Lambdas occasionally need internet egress, but most
AWS-service traffic already goes through VPC interface/gateway endpoints. One NAT
per AZ (full HA) roughly doubles the always-on NAT cost.

**Decision.** Provision **1 regional NAT gateway** by default
(`natGateways=1`), tunable via context.

**Consequences.** Lower always-on cost. If the NAT's AZ fails, internet egress
is interrupted — but Aurora and VPC-endpoint traffic are unaffected because they
do not traverse the NAT. HA deployments bump `-c natGateways=2`.

**Alternatives considered.** One NAT per AZ (rejected by default: cost); NAT
instances (rejected: operational burden).

---

## ADR-0004 — Stage-only GEO feedback loop (never auto-write live content)

**Status:** Accepted

**Context.** The feedback loop diagnoses why content was not cited and patches
structured data. Letting automation write directly to production content is
risky for a published reference architecture.

**Decision.** The Step Functions loop is **stage-only**: `patch-applier` writes
candidates to a `staging/` S3 prefix, `citation-tracker` re-tests the candidate,
and the `promoter`/validator decides but **leaves improved candidates in
`staging/`**. A human promotes to live with a documented one-line `aws s3 cp` +
CloudFront invalidation. The promoter's IAM role is scoped so it **cannot**
write to live keys or invalidate CloudFront.

**Consequences.** A human stays in control of what goes live; the automation is
safe to run unattended. The safety guarantee is testable at the IAM-policy
level. The last-inch autonomous promote is explicitly out of scope (a "Blog 2"
concern).

**Alternatives considered.** Fully autonomous promote (rejected for a 200-level
demo: production-write risk); no automation (rejected: loses the compounding
value of the loop).

---

## ADR-0005 — One-direction cross-stack references to avoid dependency cycles

**Status:** Accepted

**Context.** CDK uses strong cross-stack reference strength
(`@aws-cdk/core:defaultCrossStackReferences`). Several natural wirings create
CloudFormation dependency cycles: CloudFront OAC writing a bucket policy back
into the Storage stack; the promoter needing the distribution id while Edge
depends on Compute; an Aurora SG created in Network but attached in Database.

**Decision.** Make every cross-stack reference flow **one direction only**:
(1) the Aurora security group is owned by the DatabaseStack; (2) Edge and
Monitoring import the content bucket **read-only by name**
(`Bucket.fromBucketName`), and the OAC `s3:GetObject` statement is added
explicitly in the StorageStack with a `distribution/*` SourceArn condition;
(3) the CloudFront `distributionId` is passed to Compute via **context**
(`-c distributionId=…`) after the first deploy, not as a live reference.

**Consequences.** No synth-time cycles. The trade-off is a **two-phase first
deploy**: deploy once, read the EdgeStack `DistributionId`, then redeploy
Storage + Compute with `-c distributionId=…` to wire SPA cache invalidation and
the promoter. Teardown runs in reverse dependency order.

**Alternatives considered.** Weak references (rejected: lose deletion ordering
safety); merging the cyclic stacks (rejected: violates ADR-0001).

---

## ADR-0006 — Async submit/poll for the AgentCore concierge chat

**Status:** Accepted (synth-only; not yet live-verified)

**Context.** The browser-facing concierge runs an AgentCore harness loop that
takes ~49s. API Gateway REST APIs enforce a hard **29s** integration timeout,
and Lambda Function URLs are blocked by an account guardrail — so neither a
synchronous POST nor a Function URL can expose the harness.

**Decision.** Split the chat into an **async submit/poll** API: `POST /chat`
records a PENDING job in DynamoDB, invokes a worker Lambda asynchronously, and
returns **202 `{jobId}`; `GET /chat/{jobId}`** reports `PENDING`/`DONE`/`ERROR`.
CORS is locked to the CloudFront origin.

**Consequences.** Works within the 29s gateway limit and the Function URL
guardrail. Clients must poll. The stack synthesizes cleanly but its AgentCore
resources are not yet verified against a live deploy.

**Alternatives considered.** Synchronous POST (rejected: 29s timeout); Lambda
Function URL (rejected: account guardrail); WebSocket API (rejected: more
infrastructure than a 200-level demo needs).

---

## ADR-0007 — Two-tier tests; integration tests shell out to the AWS CLI

**Status:** Accepted

**Context.** The project needs fast, free, offline verification of the
infrastructure definition *and* confidence that the deployed system behaves. The
integration tests inspect Athena, Step Functions, and S3, which would normally
pull in AWS SDK packages — adding dependencies to a published CDK sample.

**Decision.** Keep two test tiers: **unit** (`test/unit/`, CDK synthesis
assertions, no AWS calls) and **integration** (`test/integration/`, against
deployed resources, self-skipping via `describeIfDeployed` when env vars are
absent). Integration tests use Node's built-in `fetch` for HTTP and shell out to
the **AWS CLI** via `child_process` for AWS APIs — **no SDK packages added**.
Bedrock-invoking tests are gated behind `RUN_BEDROCK_TESTS=1`.

**Consequences.** CI stays green without a deployment; `package.json` and the
CDK dependency tree stay untouched; the AWS CLI (already present for deploys)
provides credentials. The trade-off is slightly more verbose CLI plumbing than
typed SDK calls, and the CLI must be installed to run the measurement-layer
tests.

**Alternatives considered.** AWS SDK v3 clients as devDependencies (rejected:
adds packages to a sample repo); LocalStack/moto mocks (rejected: integration
tests should hit the real deployment).
