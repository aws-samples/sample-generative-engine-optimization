# Technical Layers

Deep-dive reference for each implemented layer of the **Octank Hospitality** GEO
platform. Each layer maps to one CDK stack (`lib/stacks/`) and its matching L3
construct (`lib/constructs/`). For the high-level overview and the stack table,
see the [project README](../README.md); for request/feedback-loop flows and
cross-stack cycle avoidance, see [ARCHITECTURE.md](ARCHITECTURE.md).

The layers mirror the GEO blog's three bands — **be cited** (Edge + Storage
foundation), **be called** (Compute + Database agentic API), and **measure &
improve** (Workflow + Analytics + Monitoring) — plus the Network layer that
underpins them.

> Naming note: construct classes carry a `Blog*` prefix from the original
> project name; this is deliberate (a broad rename was deferred). All
> user-facing resource names use `geo-demo`.

## Network layer

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
delivers to S3 (`logs/vpc_flow/`); see the logging layer below.

Outputs `VpcId` and `LambdaSecurityGroupId` are exported for cross-stack use by
`DatabaseStack` and `ComputeStack`.

## Storage layer

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

## Database layer

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

## Compute layer

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

## Edge layer

`EdgeStack` → `BlogDistribution` construct provisions the CloudFront distribution:

- **Default behavior** → the S3 content bucket via **Origin Access Control
  (OAC)**, origin path `/web_application`, `index.html` root, managed
  CachingOptimized policy, HTTPS-only, security-headers response policy.
- **`/api/*` behavior** → the ComputeStack REST API origin (CachingDisabled,
  AllViewerExceptHostHeader), so external agents reach the API on the same
  domain.
- **Standard access logging** to the content bucket under `logs/cf_logs/`
  (this is why the StorageStack enables bucket ACLs).
- The SPA content is the **real** site uploaded by the StorageStack
  (index.html, llms.txt, openapi.json, robots.txt, sitemap.xml, 25 property
  pages).
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

## Workflow layer

`WorkflowStack` → `BlogWorkflow` construct provisions the **GEO feedback-loop**
as a Standard Step Functions state machine (`geo-demo-dev-feedback-loop`). It
orchestrates the three worker Lambdas and is **stage-only** (never writes to
live content):

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
(`-c workflowLogging=false` to disable). The `StateMachineArn` is exported. By
default it is triggered **weekly** by an EventBridge Scheduler schedule
(`${prefix}-feedback-loop-weekly`, `rate(7 days)`, `America/Chicago`); you can
still start it on demand. Disable the schedule with `-c workflowSchedule=false`,
or retune it with `-c workflowScheduleExpression=…` and
`-c workflowScheduleTimezone=…`. The `staging/` prefix it depends on is seeded
with a `.keep` marker by the StorageStack so it always exists.

## Logging / observability layer

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
| Athena query results  | S3 `logs/athena_logs/`          | AnalyticsStack   |
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

## Analytics layer

`AnalyticsStack` provides SQL-over-S3 analytics on the CloudFront access logs
via the Glue Data Catalog + Athena (built from L1 `Cfn*` resources):

- **Glue database** `geo_demo_dev_logs` and a **Glue EXTERNAL table**
  `cloudfront_logs` over the content bucket's `logs/cf_logs/` prefix, modeling
  the 33-field CloudFront standard access-log schema (LazySimpleSerDe,
  tab-delimited, `skip.header.line.count=2`). The table `DependsOn` the database.
- **Athena workgroup** `geo-demo-dev-analytics` (enforced config, CloudWatch
  metrics on, engine `AUTO`), with query results written to `logs/athena_logs/`.
- Data comes from **30 sample CloudFront log files** seeded into `logs/cf_logs/`
  by the StorageStack, plus the real access logs the live distribution delivers
  there. A `SELECT count(*)` against the sample set returns ~4959 rows.

**Cross-stack cycle avoidance.** The stack takes the content bucket **name only**
(`contentBucketName`), so it just builds S3 location strings and grants nothing
on the bucket — no Storage↔Analytics cycle. See
[ARCHITECTURE.md](ARCHITECTURE.md) for the trailing-slash detail (the Glue
`Location` drops the trailing slash; the Athena `OutputLocation` keeps it) and
[DEPLOYMENT.md](DEPLOYMENT.md) for a sample verification query.

## AI layer (synth-only)

`AiStack` builds the "be called" concierge from L1 Amazon Bedrock AgentCore
resources: a **Gateway** + **GatewayTarget** that expose the ComputeStack REST
API as MCP tools, and a **managed Harness** (+ HarnessEndpoint) that runs the
agent loop. It reads the REST API id/stage from the ComputeStack (making the
dependency implicit) and exports the **harness ARN** consumed by the
ConciergeChatStack. The stack builds and `cdk synth`s clean but its AgentCore
resources are **not yet verified against a live deploy**.

## Concierge chat layer (synth-only)

`ConciergeChatStack` is the public on-site chat, exposed as an **async
submit/poll API Gateway REST API** backed by Lambdas and a DynamoDB job store:

- `POST /chat` → records a PENDING job, invokes the worker asynchronously,
  returns **202** `{jobId}`.
- **worker** Lambda runs the ~49s AgentCore harness loop and writes the result
  to DynamoDB.
- `GET /chat/{jobId}` → reports `PENDING` / `DONE` / `ERROR`.

Why async: the agent loop runs ~49s but API Gateway REST APIs have a hard **29s**
integration timeout, and Lambda Function URLs are blocked by an account
guardrail. CORS is locked to the CloudFront origin. It returns real answers only
once the AiStack harness is deployed and healthy.
