# generative-engine-optimization-aws

AWS CDK (TypeScript) infrastructure for the **Octank Hospitality** platform — a
Generative Engine Optimization (GEO) demo for a hotel-booking system. External
AI engines (ChatGPT, Perplexity, etc.) and browsers reach a single-page app and
a public REST API; the API queries an Aurora database, and a set of worker
Lambdas run a content feedback loop. The app is organized as a set of small,
single-responsibility stacks so each component can be built out and deployed
independently.

> Status: **in progress**. `NetworkStack`, `DatabaseStack`, `StorageStack`,
> `ComputeStack`, `EdgeStack`, `WorkflowStack` (feedback-loop Step Function),
> and `MonitoringStack` (logging module) are implemented; only `AiStack`
> (Bedrock AgentCore harness) and `AnalyticsStack` remain as documented
> placeholders. Components are fleshed out incrementally.

📚 **Technical documentation** lives in [`docs/`](docs/README.md): architecture,
deployment, configuration, and security.

## Architecture

```
   AI engines / browsers
            │  HTTPS
            ▼
   ┌──────────────────┐
   │    CloudFront     │  (EdgeStack)
   └───┬──────────┬────┘
 default│          │ /api/*
 (S3 OAC)          │
       ▼           ▼
 ┌───────────┐  ┌──────────────────┐
 │ S3 content│  │ REST API (APIGW)  │  (ComputeStack)
 │  bucket   │  └────────┬─────────┘
 │(StorageStk)│          │ Lambda proxy
 └───────────┘  ┌────────▼─────────┐
                │  api-handler λ    │  (VPC)
                └────────┬─────────┘
                         │ RDS Data API (HTTP)
                         ▼
                ┌──────────────────┐
                │ Aurora PostgreSQL │  (DatabaseStack)
                │  Serverless v2    │
                └──────────────────┘

 Worker Lambdas (VPC, ComputeStack): citation-tracker -> Bedrock;
   patch-applier -> staging/;  promoter -> web_application/ + CloudFront invalidation

 NetworkStack   : VPC, subnets, 1 NAT, VPC endpoints (incl. RDS Data API), SGs
 MonitoringStack: VPC Flow Logs -> S3 logs/vpc_flow/ (logging module)
 AiStack        : Bedrock agent (todo)      AnalyticsStack: Athena (todo)
```

### Stacks (`lib/stacks`)

| Stack             | Component            | Status | Responsibility                                   |
| ----------------- | -------------------- | ------ | ------------------------------------------------ |
| `NetworkStack`    | VPC                  | ✅ done | Subnets, NAT, security groups, VPC endpoints, flow logs |
| `StorageStack`    | S3                   | ✅ done | Single bucket: web_application/, code/, logs/, staging/ + asset upload |
| `DatabaseStack`   | Aurora               | ✅ done | Serverless v2 cluster + Secrets Manager creds    |
| `ComputeStack`    | Lambda + API         | ✅ done | 4 VPC Lambdas + public REST API (Octank Hospitality) |
| `AiStack`         | Bedrock agent        | ⬜ todo | Generative AI features (agent, KB, action groups)|
| `AnalyticsStack`  | Athena               | ⬜ todo | Glue catalog + Athena workgroup over S3 data     |
| `EdgeStack`       | CloudFront           | ✅ done | SPA via S3 (OAC) + `/api/*` to API, logs to `logs/cf_logs/` |
| `WorkflowStack`   | Step Functions       | ✅ done | GEO feedback-loop state machine orchestrating the 3 worker Lambdas |
| `MonitoringStack` | CloudWatch / S3 logs | ✅ done | Logging module: VPC Flow Logs → S3 `logs/vpc_flow/` (alarms/dashboards later) |

Each stack composes a matching reusable construct from `lib/constructs`
(see that folder's README for the mapping).

### Network layer (implemented)

`NetworkStack` → `BlogNetwork` construct provisions:

- **VPC** across 2 AZs (`10.0.0.0/16`), DNS support + hostnames enabled.
- **Subnets** (per AZ): `public` (hosts NAT), `private-egress` (hosts Lambda),
  `private-isolated` (hosts Aurora, no internet route).
- **1 regional NAT gateway** + Internet Gateway (cost-efficient; egress is
  interrupted only if that AZ fails — Aurora and VPC-endpoint traffic are
  unaffected).
- **VPC endpoints**: S3 **gateway** endpoint (free); **interface** endpoints for
  Secrets Manager, **RDS Data API**, Bedrock (+ runtime, + agent-runtime), and
  CloudWatch Logs so that traffic avoids the NAT and stays on the AWS network.
  (The RDS Data API endpoint lets the VPC-attached Lambdas query Aurora over
  HTTP without a socket connection.)
- **Security groups**:
  - `lambda-sg` — attached to the API functions; no inbound, egress allowed.
  - `database-sg` — Aurora; inbound `5432` **only** from `lambda-sg`.
  - `endpoint-sg` — interface endpoints; inbound `443` from `lambda-sg`.

VPC Flow Logs are **not** defined here — the MonitoringStack owns them and
delivers to S3 (`logs/vpc_flow/`); see the logging section below.

Outputs `VpcId` and `LambdaSecurityGroupId` are exported for cross-stack use by
`DatabaseStack` and `ComputeStack`.

### Storage layer (implemented)

`StorageStack` → `ContentStorage` construct provisions **one** S3 bucket
(deterministic, collision-safe name `geo-demo-content-<account>-<region>`) with
these prefixes:

| Prefix              | Purpose                                              | Served? |
| ------------------- | ---------------------------------------------------- | ------- |
| `web_application/`  | Single-page app + served files (CloudFront OAC origin) | ✅ |
| `code/`             | Lambda code, OpenAPI import spec, DB DDL/seed (`code/db/`) | ❌ |
| `logs/cf_logs/`     | CloudFront standard access logs                       | ❌ |
| `logs/athena_logs/` | Athena query results                                  | ❌ |
| `logs/s3/`          | S3 server access logs (bucket logs to itself)         | ❌ |
| `staging/`          | Feedback-loop area (agent corrections awaiting review) | ❌ |

Secure defaults: all public access blocked, S3-managed encryption, TLS-only
bucket policy, versioning, and self server-access logging. Bucket **ACLs are
enabled** (`BucketOwnerPreferred`) so CloudFront native logging can write to
`logs/cf_logs/`. Per-prefix lifecycle rules expire logs/query-results and
transition `web_application/` to Infrequent Access. Removal + object auto-delete
are driven by `retainData`.

**Asset upload.** The repo's `assets/` tree is uploaded into the bucket at
deploy time via CDK `BucketDeployment`:

| Local path                | Bucket destination |
| ------------------------- | ------------------ |
| `assets/web_application/` | `web_application/` |
| `assets/code/`            | `code/`            |
| `assets/db/`              | `code/db/`         |

`assets/web_application/` holds the real SPA content; `assets/code/` holds the
four Python Lambda handlers + OpenAPI specs; `assets/db/geo_demo_full.sql` is the
full hotel-booking schema + sample data (applied to Aurora by the DatabaseStack
schema loader — see the Database layer below). Outputs `BucketName` and
`BucketArn` are exported for consumers. The CDK-managed BucketDeployment Lambda
carries documented cdk-nag suppressions (L1/IAM4/IAM5).

### Database layer (implemented)

`DatabaseStack` → `BlogDatabase` construct provisions:

- **Aurora PostgreSQL Serverless v2** cluster (writer + optional readers),
  engine version pinned via config (never "latest").
- Placed in the network's **private-isolated subnets**; **storage encrypted**;
  **IAM database authentication** enabled.
- Its **own security group** (owned by this stack, not the network layer, to
  keep cross-stack references acyclic) allowing ingress on the DB port **only
  from the Lambda tier's security group**.
- **Master credentials generated into Secrets Manager** (no passwords in code
  or state); fetched by Lambda via the Secrets Manager interface endpoint.
- **Config-gated extras** (off by default): an **RDS Proxy** for connection
  pooling and **Secrets Manager rotation**.
- **Teardown behavior driven by `retainData`**: dev (`false`) destroys the
  cluster with no deletion protection for clean `cdk destroy`; `true` switches
  to a `SNAPSHOT` removal policy with deletion protection enabled.

Outputs `ClusterEndpoint`, `SecretArn`, and `ClusterArn` are exported for
`ComputeStack`. The **RDS Data API is enabled** on the cluster so the Lambda
tier can query it over HTTP.

**Schema + data loading.** A custom resource (the `db-loader` Lambda) applies
`assets/db/geo_demo_full.sql` to the cluster on deploy: it reads the script from
S3 (`code/db/geo_demo_full.sql`, uploaded by the StorageStack), splits it into
statements, and runs them via the RDS Data API inside a single transaction. The
script is self-contained and re-runnable (DROP … CASCADE + CREATE + inserts +
sequence resets), so it is idempotent; the loader re-runs automatically whenever
the SQL content changes (tracked by a content hash). It runs after the cluster
is ready and needs no VPC attachment (Data API + S3 are public AWS endpoints).

The cross-stack VPC/SG references use CDK's "strong" reference strength
(`@aws-cdk/core:defaultCrossStackReferences` in `cdk.json`), so a producing
stack cannot be deleted while a consumer still references it — teardown must run
in reverse dependency order (which `bin/app.ts` already expresses).

### Compute layer (implemented)

`ComputeStack` → `BlogApi` construct provisions the four GEO Lambdas and the
public API, modeled on the functions discovered in the target account:

| Function             | Timeout | Access (least-privilege)                          |
| -------------------- | ------- | ------------------------------------------------- |
| `api-handler`        | 30s     | RDS **Data API** on the cluster + read DB secret  |
| `citation-tracker`   | 300s    | Bedrock `InvokeModel*` + `PutMetricData` (ns-scoped) + read `code/` |
| `patch-applier`      | 3s      | Read `web_application/*`, read/write `staging/*`  |
| `promoter`           | 3s      | Read/write `web_application/*` + `staging/*`, CloudFront invalidation, metrics |

- All functions are **python3.13**, handler `lambda_function.lambda_handler`,
  sourced from `assets/code/<name>/`, and **attached to the VPC**
  (private-egress subnets, network `lambdaSecurityGroup`).
- **Public regional REST API Gateway** ("Octank Hospitality API") fronts
  `api-handler` via Lambda proxy integration, with the route tree:
  `GET /properties`, `GET /properties/{propertyId}`,
  `GET /properties/{propertyId}/rates`,
  `GET /properties/{propertyId}/availability`, `POST /reservations`.
  The API is intentionally **public** so external AI engines can call it; the
  Lambdas' VPC attachment governs only their outbound access (Aurora Data API,
  Secrets Manager, Bedrock, S3 — all via VPC endpoints).
- Stage access logging + throttling enabled. `ApiEndpoint` is exported.
- The `promoter`'s CloudFront `distributionId` is supplied via context until the
  EdgeStack is built: `-c distributionId=E2HKAT79V522DO`.

Documented cdk-nag suppressions cover the intentional public API (APIG4/COG4),
the pinned python3.13 runtime (L1), managed exec/VPC roles (IAM4), and
scoped-wildcard grants (IAM5).

### Edge layer (implemented)

`EdgeStack` → `BlogDistribution` construct provisions the CloudFront distribution:

- **Default behavior** → the S3 content bucket via **Origin Access Control
  (OAC)**, origin path `/web_application`, `index.html` root, managed
  CachingOptimized policy, HTTPS-only, security-headers response policy.
- **`/api/*` behavior** → the ComputeStack REST API origin (CachingDisabled,
  AllViewerExceptHostHeader), so external agents reach the API on the same
  domain.
- **Standard access logging** to the content bucket under `logs/cf_logs/`
  (this is why the StorageStack enables bucket ACLs).
- The SPA content is the **real** site synced from
  `s3://geo-demo-content-a2z4/web-application/` into `assets/web_application/`
  (index.html, llms.txt, openapi.json, robots.txt, sitemap.xml, 25 property
  pages) and uploaded by the StorageStack.
- Outputs `DistributionId` and `DistributionDomainName`.

**Cross-stack cycle avoidance.** EdgeStack imports the content bucket
**read-only by name** (`Bucket.fromBucketName`) rather than consuming the live
construct. This prevents `withOriginAccessControl` from writing a back-reference
bucket policy into the StorageStack (which would create a Storage↔Edge cycle);
instead the OAC `s3:GetObject` statement is added explicitly in the StorageStack
with a `distribution/*` SourceArn condition. Likewise, the promoter's
`distributionId` is passed via context, not a live Edge→Compute reference, to
avoid a Compute↔Edge cycle.

Documented cdk-nag suppressions cover the demo distribution's default
certificate and absence of WAF/geo-restrictions (CFR1/CFR2/CFR4).

### Workflow layer (implemented)

`WorkflowStack` → `BlogWorkflow` construct provisions the **GEO feedback-loop**
as a Standard Step Functions state machine (`geo-demo-dev-feedback-loop`),
mirroring the one discovered in the account. It orchestrates the three worker
Lambdas and is **stage-only** (never writes to live content):

```
MeasureLive (citation-tracker, target=live)
  → HasGap?  (a top_fix was diagnosed?)
       yes → ApplyPatch (patch-applier → staging/)
               → PatchChanged?
                    yes → ReTestCandidate (citation-tracker, target=staging)
                            → ValidateAndStage (promoter, stage-only)
                            → Done
                    no  → NoGapDone
       no  → NoGapDone
```

The state machine's role only gets `lambda:InvokeFunction` on the three workers
(granted automatically by the `LambdaInvoke` tasks). Execution logging to a
DESTROY-policy CloudWatch log group + X-Ray tracing are on by default
(`-c workflowLogging=false` to disable). The `StateMachineArn` is exported. It
is **not scheduled** — invoke it on demand (the live one had no EventBridge
rule). The `staging/` prefix it depends on is seeded with a `.keep` marker by
the StorageStack so it always exists.

### Logging / observability (implemented)

`MonitoringStack` → `BlogObservability` construct is the platform's **logging
module**. As a prototype it routes every log source that natively supports S3
into the shared content bucket, and leaves CloudWatch-only sources (which
cannot write to S3) on CloudWatch with consistent retention.

Log inventory:

| Source                | Destination                     | Where configured |
| --------------------- | ------------------------------- | ---------------- |
| VPC Flow Logs         | S3 `logs/vpc_flow/`             | MonitoringStack  |
| CloudFront access     | S3 `logs/cf_logs/`              | EdgeStack        |
| S3 server access      | S3 `logs/s3/` (self-logging)    | StorageStack     |
| Athena query results  | S3 `logs/athena_logs/`          | AnalyticsStack (later) |
| Lambda functions      | CloudWatch Logs (native only)   | ComputeStack     |
| API Gateway access    | CloudWatch Logs (native only)   | ComputeStack     |

> Why some logs stay on CloudWatch: **API Gateway access logs and Lambda logs
> can only be delivered to CloudWatch Logs** — S3 is not a valid direct
> destination for them. Archiving those to S3 would require a
> CloudWatch → Firehose → S3 export pipeline, which is deferred beyond the
> prototype.

The flow log is created as a standalone `ec2.FlowLog` in the MonitoringStack
(not via `vpc.addFlowLog`, which would attach it to the NetworkStack). The
MonitoringStack imports the log bucket read-only by name to avoid a
Monitoring↔Storage policy cycle. cdk-nag `AwsSolutions-VPC7` is suppressed on
the NetworkStack because the flow log legitimately lives in another stack.

## Project layout

```
bin/app.ts            CDK app entry point — instantiates + wires all stacks
lib/config/           Central config: defaults + CDK-context overrides + validation
lib/stacks/           One stack per component (6 of 8 implemented; ai/analytics todo)
lib/constructs/       Reusable L3 constructs, one per component
assets/               Content uploaded to S3: web_application/, code/ (Lambdas), db/ (DDL+seed)
test/unit/            Jest synthesis tests (fast, no AWS calls)
test/integration/     Jest tests against deployed resources (self-skip w/o env)
docs/                 Technical documentation (architecture, deployment, config, security)
cdk.json              CDK app command + feature flags
```

## Prerequisites

- Node.js 20+ (developed on 24)
- AWS credentials configured (`aws sts get-caller-identity` should succeed)
- CDK bootstrapped in the target account/region:
  `npx cdk bootstrap aws://<account>/<region>`

## Common commands

```bash
npm install                 # install dependencies

npm run build               # type-check (tsc --noEmit)
npm run test                # unit tests (synthesis assertions)
npm run test:integ          # integration tests (needs a deployment; self-skips)
npm run lint                # eslint

npm run synth               # cdk synth --strict (all stacks)
npm run diff                # cdk diff
npm run deploy -- --all     # deploy every stack

# Override any default at deploy time via CDK context (see table below):
npm run synth -- -c cidr=10.42.0.0/16 -c natGateways=2
npm run deploy -- --all -c cidr=10.42.0.0/16
```

## Configuration

There is a single environment (`dev`). All configuration is **centralized** in
`lib/config/index.ts` — one source of truth, no values scattered across stacks.
Each tunable has a **default** (in the `*_DEFAULTS` objects) that a user can
**override at deploy time via CDK context** (`-c key=value`) without editing any
source. Overrides are validated, so a bad value fails fast at synth with a clear
message. A full reference is in [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md).

Account/region resolve from the CDK CLI environment or the
`CDK_DEPLOY_ACCOUNT` / `CDK_DEPLOY_REGION` vars.

| Context key      | Default        | Validation            | Meaning                                        |
| ---------------- | -------------- | --------------------- | ---------------------------------------------- |
| `cidr`           | `10.0.0.0/16`  | IPv4 CIDR, /16../28    | VPC IPv4 CIDR block                             |
| `maxAzs`         | `2`            | integer 1..6           | Availability Zones to span                      |
| `natGateways`    | `1`            | integer 0..maxAzs      | NAT gateways (1 = single regional; bump for HA) |
| `subnetCidrMask` | `24`           | integer 16..28         | Netmask for each subnet CIDR                     |
| `databasePort`   | `5432`         | integer 1..65535       | Database port (PostgreSQL)                       |
| `dbName`         | `geo_db`       | string                 | Initial database name                            |
| `engineVersion`  | `16.13`        | `major.minor`          | Aurora PostgreSQL version (pinned, not "latest") |
| `minAcu`         | `0.5`          | number 0.5..256        | Serverless v2 min capacity (ACU)                 |
| `maxAcu`         | `2`            | number >= minAcu       | Serverless v2 max capacity (ACU)                 |
| `readers`        | `0`            | integer 0..15          | Reader instances (0 = writer only)               |
| `enableProxy`    | `false`        | true/false             | Provision an RDS Proxy (connection pooling)      |
| `enableRotation` | `false`        | true/false             | Enable Secrets Manager credential rotation       |
| `logRetentionDays`              | `90` | integer 1..3650 | Expire objects under `logs/` after N days     |
| `queryResultRetentionDays`      | `30` | integer 1..3650 | Expire Athena results (`logs/athena_logs/`)   |
| `contentIaTransitionDays`       | `90` | integer 1..3650 | Transition `web_application/` to Infrequent Access |
| `noncurrentVersionRetentionDays`| `30` | integer 1..3650 | Expire noncurrent object versions             |
| `lambdaMemoryMb`        | `128`  | integer 128..10240 | Lambda memory (all functions)                 |
| `apiTimeoutSeconds`     | `30`   | integer 1..900     | api-handler timeout                            |
| `citationTimeoutSeconds`| `300`  | integer 1..900     | citation-tracker timeout                       |
| `workerTimeoutSeconds`  | `3`    | integer 1..900     | patch-applier / promoter timeout               |
| `apiStageName`          | `prod` | string             | API Gateway stage name                         |
| `apiThrottleRateLimit`  | `50`   | integer 1..10000   | API steady-state requests/sec                  |
| `apiThrottleBurstLimit` | `100`  | integer 1..10000   | API burst requests                             |
| `bedrockModelId`        | `global.anthropic.claude-sonnet-4-6` | string | Bedrock model for citation-tracker |
| `distributionId`        | (none) | string             | CloudFront dist id for promoter invalidation   |
| `priceClass`            | `all`  | all / 200 / 100    | CloudFront price class                          |
| `defaultRootObject`     | `index.html` | string       | SPA root object                                 |
| `apiPathPattern`        | `/api/*` | string           | Path routed to the API origin                   |
| `flowLogTrafficType`    | `ALL`  | ALL / ACCEPT / REJECT | VPC Flow Log traffic captured to S3          |
| `workflowLogging`       | `true` | true/false         | Enable Step Function execution logging + tracing |
| `retainData`     | `false`        | truthy                 | Retain stateful resources on stack deletion      |

Examples:

```bash
# Use defaults
npm run deploy -- --all

# Bring your own CIDR and full-HA NAT
npm run deploy -- --all -c cidr=10.42.0.0/16 -c maxAzs=2 -c natGateways=2
```

To change a **default** for everyone, edit `NETWORK_DEFAULTS`,
`DATABASE_DEFAULTS`, `STORAGE_DEFAULTS`, `COMPUTE_DEFAULTS`, `EDGE_DEFAULTS`,
`MONITORING_DEFAULTS`, or `WORKFLOW_DEFAULTS` in `lib/config/index.ts`. To change
a value for a **single deploy**, pass it as context — no code change needed.

## Compliance

`bin/app.ts` applies cdk-nag's `AwsSolutionsChecks` at synth time. As stacks are
implemented, resolve findings (or add scoped `NagSuppressions` with a reason)
before deploying.

## Next steps

Flesh out each remaining stack/construct pair in dependency order:
~~Network~~ → ~~Storage~~ → ~~Database~~ → ~~Compute~~ → Ai → Analytics → ~~Edge~~ → ~~Monitoring~~.
Add resource assertions to a dedicated unit test per stack (see
`test/unit/network-stack.test.ts` as the template) and live checks to the
integration suite as you go.
