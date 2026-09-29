# Architecture

The **Octank Hospitality** platform is a Generative Engine Optimization (GEO)
demo for a hotel-booking system. It serves a single-page web application and a
public REST API that external AI engines (ChatGPT, Perplexity, etc.) and
browsers consume, backed by an Aurora PostgreSQL database and a set of worker
Lambdas that run a content feedback loop.

Everything is deployed with AWS CDK (TypeScript) as a set of small,
single-responsibility stacks. Each stack owns one concern and composes a
matching reusable L3 construct from `lib/constructs`.

## System overview

```
   AI engines (ChatGPT/Perplexity) + browsers
                     │  HTTPS
                     ▼
             ┌────────────────┐
             │   CloudFront    │   EdgeStack
             │  (SPA + /api/*) │
             └──────┬─────┬────┘
       default(S3 OAC)    │ /api/*
                 │        ▼
                 │   ┌──────────────────────┐
                 │   │ REST API Gateway      │  ComputeStack
                 │   │ (Octank Hospitality)  │
                 │   └───────────┬───────────┘
                 │               │ Lambda proxy
                 ▼               ▼
          ┌────────────┐   ┌────────────────┐
          │ S3 content │   │  api-handler λ  │  (VPC, private-egress)
          │  bucket    │   └───────┬────────┘
          │(StorageStk)│           │ RDS Data API (HTTPS via VPC endpoint)
          └────────────┘           ▼
                          ┌────────────────────┐
                          │ Aurora PostgreSQL   │  DatabaseStack
                          │ Serverless v2       │
                          │ (private-isolated)  │
                          └────────────────────┘

   Worker Lambdas (VPC, ComputeStack):
     citation-tracker λ ── Bedrock InvokeModel ──► CloudWatch metrics
     patch-applier λ ───── read web_application/ ─► write staging/
     promoter λ ────────── staging/ ─► web_application/ + CloudFront invalidation

   Cross-cutting:
     NetworkStack    — VPC, subnets, 1 NAT, VPC endpoints (incl. RDS Data API), SGs
     MonitoringStack — VPC Flow Logs → S3 logs/vpc_flow/ (logging module)
     AiStack         — Bedrock agent (todo)
     AnalyticsStack  — Glue + Athena over logs/athena_logs/ (todo)
```

## Stacks

| Stack             | Construct            | Owns                                                   |
| ----------------- | -------------------- | ------------------------------------------------------ |
| `NetworkStack`    | `BlogNetwork`        | VPC, subnets, NAT, VPC endpoints, security groups      |
| `StorageStack`    | `ContentStorage`     | Single S3 bucket (prefixes) + asset upload             |
| `DatabaseStack`   | `BlogDatabase`       | Aurora PostgreSQL Serverless v2 + Secrets Manager      |
| `ComputeStack`    | `BlogApi`            | 4 Lambdas + public REST API Gateway                    |
| `EdgeStack`       | `BlogDistribution`   | CloudFront distribution (SPA + API)                    |
| `MonitoringStack` | `BlogObservability`  | Logging module (VPC Flow Logs → S3)                    |
| `AiStack`         | `BlogBedrockAgent`   | Bedrock agent (placeholder)                            |
| `AnalyticsStack`  | `BlogAnalytics`      | Glue catalog + Athena workgroup (placeholder)          |

> Naming note: the construct classes still carry the `Blog*` prefix from the
> original project name. This is deliberate — a broad rename was deferred to
> avoid churn. `APP_NAME` and all user-facing resource names use `geo-demo`.

### NetworkStack

- **VPC**: `10.0.0.0/16`, 2 AZs, DNS support + hostnames enabled.
- **Subnet tiers** (per AZ): `public` (hosts the NAT gateway), `private-egress`
  (hosts the Lambdas), `private-isolated` (hosts Aurora, no internet route).
- **1 regional NAT gateway** + Internet Gateway. Single NAT is a cost choice;
  egress is interrupted only if that AZ fails, and Aurora/VPC-endpoint traffic
  is unaffected.
- **VPC endpoints**: S3 **gateway** endpoint (free); **interface** endpoints for
  Secrets Manager, **RDS Data API**, Bedrock (+ runtime, + agent-runtime), and
  CloudWatch Logs. These keep Lambda egress on the AWS network instead of the
  NAT. The RDS Data API endpoint is what lets the VPC-attached Lambdas query
  Aurora over HTTPS without a socket connection.
- **Security groups**: `lambda-sg` (no inbound, egress allowed), `endpoint-sg`
  (inbound 443 from `lambda-sg`). The Aurora SG is owned by the DatabaseStack.

### StorageStack

A **single** S3 bucket, deterministically named
`geo-demo-content-<account>-<region>`, with these prefixes:

| Prefix              | Purpose                                             | Served |
| ------------------- | --------------------------------------------------- | ------ |
| `web_application/`  | SPA + served files (CloudFront OAC origin path)     | yes    |
| `code/`             | Lambda code, OpenAPI import spec, DB DDL/seed (`code/db/`) | no |
| `logs/cf_logs/`     | CloudFront standard access logs                     | no     |
| `logs/athena_logs/` | Athena query results                                | no     |
| `logs/s3/`          | S3 server access logs (bucket logs to itself)       | no     |
| `logs/vpc_flow/`    | VPC Flow Logs                                       | no     |
| `staging/`          | Feedback-loop area (agent corrections under review) | no     |

Secure defaults: block-all public access, S3-managed encryption, TLS-only bucket
policy, versioning, and self server-access logging. Bucket **ACLs are enabled**
(`BucketOwnerPreferred`) so CloudFront native logging can write to
`logs/cf_logs/`. Per-prefix lifecycle rules expire logs/query results and
transition `web_application/` to Infrequent Access.

The repo's `assets/` tree is uploaded at deploy time via `BucketDeployment`:
`assets/web_application → web_application/`, `assets/code → code/`,
`assets/db → code/db/`.

### DatabaseStack

- **Aurora PostgreSQL Serverless v2** (writer + optional readers), engine
  version pinned via config, in the **private-isolated** subnets.
- **Storage encrypted**, **IAM database authentication** enabled, and the
  **RDS Data API enabled** so the Lambda tier queries it over HTTP.
- **Master credentials generated into Secrets Manager** — no passwords in code
  or CloudFormation state.
- Its **own security group**, allowing ingress on the DB port only from the
  Lambda tier's SG. (Owned here, not in NetworkStack, to keep cross-stack
  references acyclic — see "Cross-stack references" below.)
- Config-gated extras (off by default): **RDS Proxy** and **secret rotation**.
- Teardown driven by `retainData`: dev destroys cleanly; retained mode uses a
  `SNAPSHOT` removal policy with deletion protection.
- **Schema + data loader**: a custom resource (the `db-loader` Lambda) applies
  `assets/db/geo_demo_full.sql` to the cluster on deploy — it reads the script
  from S3 (`code/db/geo_demo_full.sql`), splits it into statements
  (quote-aware), and executes them via the RDS Data API inside one transaction.
  The script is re-runnable (DROP … CASCADE), so it is idempotent, and the
  loader re-runs when the SQL content hash changes. It depends on the cluster
  and is not VPC-attached (Data API + S3 are public AWS endpoints).

### ComputeStack

Four Python 3.13 Lambdas (handler `lambda_function.lambda_handler`, sourced from
`assets/code/<name>/`), all **VPC-attached** to the private-egress subnets with
the network `lambda-sg`:

| Function           | Timeout | Purpose                                   |
| ------------------ | ------- | ----------------------------------------- |
| `api-handler`      | 30s     | REST API backend; queries Aurora via Data API |
| `citation-tracker` | 300s    | Bedrock citation analysis; publishes metrics |
| `patch-applier`    | 3s      | Reads live content, writes candidates to `staging/` |
| `promoter`         | 3s      | Promotes `staging/` → `web_application/`; invalidates CloudFront |

A **public regional REST API Gateway** ("Octank Hospitality API") fronts
`api-handler` via Lambda proxy integration. The API is intentionally public so
external AI engines can call it. Routes:

```
GET  /properties
GET  /properties/{propertyId}
GET  /properties/{propertyId}/rates
GET  /properties/{propertyId}/availability
POST /reservations
```

Each Lambda has a dedicated least-privilege role (see [SECURITY.md](SECURITY.md)).

### EdgeStack

- **CloudFront distribution**: default behavior serves the SPA from the S3
  content bucket via **Origin Access Control (OAC)** (origin path
  `/web_application`, `index.html` root, managed CachingOptimized policy,
  HTTPS-only, security-headers response policy).
- **`/api/*` behavior** routes to the REST API origin (CachingDisabled,
  AllViewerExceptHostHeader) so external agents reach the API on the same
  domain.
- **Standard access logging** to `logs/cf_logs/`.

### MonitoringStack (logging module)

Routes S3-capable log sources into the shared bucket; leaves CloudWatch-only
sources on CloudWatch. Currently configures **VPC Flow Logs → S3
`logs/vpc_flow/`**. Dashboards and alarms are a later addition. Full log
inventory is in the main README and [DEPLOYMENT.md](DEPLOYMENT.md).

## Request flow: an AI engine querying hotel availability

1. The AI engine fetches the SPA / manifest (`llms.txt`, `openapi.json`) from
   CloudFront (served from S3 `web_application/`).
2. It calls `GET /properties/{id}/availability` on the CloudFront domain.
3. CloudFront matches the `/api/*` behavior and forwards to the REST API origin.
4. API Gateway invokes `api-handler` (Lambda proxy).
5. `api-handler`, running in the VPC, calls the **RDS Data API** over the
   `rds-data` VPC interface endpoint, using the cluster ARN + the Secrets
   Manager secret ARN (fetched via the Secrets Manager endpoint).
6. Aurora returns rows; the Lambda shapes the JSON response back through API
   Gateway and CloudFront to the caller.

## Content feedback loop (GEO)

1. `citation-tracker` analyzes how AI engines used the content (via Bedrock) and
   publishes metrics to CloudWatch (`GEO/CitationTracker`).
2. `patch-applier` reads the live page under `web_application/`, produces a
   corrected candidate, and writes it under `staging/` — never overwriting
   production directly.
3. A human (or later, automation) reviews the staged candidate.
4. `promoter` copies the approved candidate from `staging/` to
   `web_application/` and issues a CloudFront invalidation so the edge picks up
   the new content.

## Cross-stack references and dependency-cycle avoidance

Stacks pass references to each other in `bin/app.ts`. CDK uses **strong**
cross-stack reference strength (`@aws-cdk/core:defaultCrossStackReferences` in
`cdk.json`), so a producing stack cannot be deleted while a consumer references
it — teardown must run in reverse dependency order (which `bin/app.ts`
expresses).

Three places required care to avoid CloudFormation dependency cycles. The
consistent principle: **make the reference flow one direction only.**

1. **Database security group.** The Aurora SG is created in the DatabaseStack
   (which owns the cluster), not the NetworkStack. Creating an SG in one stack
   and attaching it to a resource in another produces a bidirectional
   reference.

2. **CloudFront ↔ S3 (OAC + logging).** `withOriginAccessControl` normally
   writes a bucket policy referencing the distribution ARN into the bucket's
   stack, while the distribution references the bucket — a cycle. The EdgeStack
   therefore imports the bucket **read-only by name** (`Bucket.fromBucketName`),
   so no back-reference policy is written; the OAC `s3:GetObject` statement is
   added explicitly in the StorageStack with a `distribution/*` SourceArn
   condition.

3. **Promoter ↔ CloudFront.** The promoter needs the distribution id, but Edge
   depends on Compute (for the API origin). Passing the id back into Compute
   would cycle. Instead the id is supplied via **context**
   (`-c distributionId=...`) after the first deploy.

The MonitoringStack similarly imports the log bucket read-only to avoid a
Monitoring↔Storage cycle when the Flow Log adds its delivery policy.

## Deploy dependency order

```
NetworkStack  StorageStack
     │             │
     ├──────┬──────┤
     ▼      ▼      ▼
 DatabaseStack   (Storage feeds Compute/Edge/Monitoring)
     │
     ▼
 ComputeStack ──► EdgeStack
     │                │
     └──► MonitoringStack (Network + Storage)

 AiStack, AnalyticsStack: independent placeholders (depend on Storage)
```

## Technology choices

- **CDK v2 (aws-cdk-lib 2.269.0), TypeScript, NodeNext modules.** Relative
  imports carry `.js` extensions.
- **cdk-nag `AwsSolutionsChecks`** runs at synth; findings are resolved or
  carry documented `NagSuppressions`. See [SECURITY.md](SECURITY.md).
- **RDS Data API** (not socket connections) for Lambda→Aurora, matching the
  functions discovered in the target account.
- **Single environment (`dev`)** with centralized, context-overridable config.
  See [CONFIGURATION.md](CONFIGURATION.md).
