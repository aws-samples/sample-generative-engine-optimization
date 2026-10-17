# Security

Security posture of the Octank Hospitality CDK app: network isolation, IAM
least-privilege, encryption, secrets handling, and the cdk-nag compliance
baseline (with every suppression and its justification).

## Network isolation

- **Three subnet tiers**: `public` (NAT only), `private-egress` (Lambdas),
  `private-isolated` (Aurora, no route to the internet).
- **Aurora is never public** — it lives in isolated subnets and accepts inbound
  only from the Lambda security group on the DB port.
- **Lambda egress stays on the AWS network** via VPC endpoints (S3 gateway;
  Secrets Manager, RDS Data API, Bedrock, CloudWatch Logs interface endpoints),
  so sensitive calls avoid the public internet / NAT.
- **Security groups**:
  - `lambda-sg`: no inbound; egress allowed.
  - `database-sg`: inbound DB port **only** from `lambda-sg` (SG reference, not a
    CIDR).
  - `endpoint-sg`: inbound 443 **only** from `lambda-sg`.

## IAM: least-privilege per function

Each Lambda has its **own** execution role with a narrowly-scoped inline policy.
No shared "god" role. Summary (exact from `lib/constructs/blog-api.ts`):

### `api-handler`
| Sid | Actions | Resource |
| --- | ------- | -------- |
| `RdsDataApiQuery` | `rds-data:ExecuteStatement`, `rds-data:BatchExecuteStatement` | the cluster ARN |
| `ReadDbSecret`    | `secretsmanager:GetSecretValue` | the DB secret ARN |

No S3, no Bedrock. It only reads the database (via the Data API) and the one
secret it needs.

### `citation-tracker`
| Sid | Actions | Resource |
| --- | ------- | -------- |
| `InvokeBedrockModel` | `bedrock:InvokeModel`, `bedrock:InvokeModelWithResponseStream` | Claude foundation-model + inference-profile ARNs |
| `PublishMetrics`     | `cloudwatch:PutMetricData` | `*`, **conditioned** on `cloudwatch:namespace = GEO/CitationTracker` |
| (grant)              | `s3:GetObject*` | `code/*` (reads prompts) |

### `patch-applier`
| Actions | Resource |
| ------- | -------- |
| read (`s3:GetObject*`) | `web_application/*` |
| read/write (`s3:GetObject*`, `s3:PutObject`) | `staging/*` |

Can read live content and write **only** to the staging area — it cannot alter
production content directly.

### `promoter`
| Sid | Actions | Resource |
| --- | ------- | -------- |
| (grant) | read/write | `web_application/*` |
| (grant) | read/write + `s3:DeleteObject*` | `staging/*` |
| `PublishMetrics` | `cloudwatch:PutMetricData` | `*`, conditioned on the namespace |
| `InvalidateDistribution` | `cloudfront:CreateInvalidation` | `*` (only added when a `distributionId` is configured) |

The promoter is the only function that writes production content, and only as
the final promote step.

### Shared execution-role managed policies

All functions also attach the AWS-managed `AWSLambdaBasicExecutionRole` (CloudWatch
Logs) and, because they're VPC-attached, `AWSLambdaVPCAccessExecutionRole` (ENI
management). These are the standard, minimal managed policies for VPC Lambdas.

## Encryption

- **S3**: SSE with S3-managed keys (`AES256`); all public access blocked;
  TLS-only bucket policy (`aws:SecureTransport=false` denied).
- **Aurora**: `storageEncrypted: true` (KMS at rest); **IAM database
  authentication** enabled; **RDS Data API** used over an HTTPS VPC endpoint.
- **In transit**: CloudFront viewer protocol is `redirect-to-https`; the API
  origin is HTTPS-only; VPC endpoint traffic is TLS.

## Secrets

- The Aurora master credentials are **generated into Secrets Manager** by CDK —
  no password appears in code, context, or CloudFormation state.
- `api-handler` reads the secret at runtime via the Secrets Manager VPC endpoint,
  scoped to that one secret ARN.
- **Rotation** is available but config-gated (`-c enableRotation=true`); off by
  default for the prototype.

## CloudFront ↔ S3 access

The content bucket blocks all public access. CloudFront reads it via **Origin
Access Control (OAC)**. Because the bucket and distribution live in separate
stacks, the OAC `s3:GetObject` grant is added explicitly in the StorageStack
(scoped to `web_application/*`) with an `AWS:SourceAccount` condition and an
`AWS:SourceArn` condition. Once the distribution id is supplied
(`-c distributionId=...`, from the second deploy on), the `SourceArn` is pinned
to **that** distribution's ARN; on the very first deploy (before the
distribution exists) it falls back to an account-scoped
`arn:aws:cloudfront::<account>:distribution/*` wildcard, still bounded by
`SourceAccount`. The id is a plain context string, so this scoping does not
reintroduce a Storage↔Edge stack dependency cycle.

## cdk-nag baseline

`bin/app.ts` applies cdk-nag `AwsSolutionsChecks` at synth. `npm run synth` runs
in `--strict` mode, so any **unsuppressed** finding fails the build. Every
suppression below is scoped and carries a documented reason in code.

| Rule | Stack | Why suppressed |
| ---- | ----- | -------------- |
| `CdkNagValidationFailure` (EC23) | Network | The rule can't evaluate the CDK-managed interface-endpoint ingress rule (VPC-CIDR intrinsic). The rule allows HTTPS only from within the VPC, not `0.0.0.0/0`. |
| `AwsSolutions-VPC7` | Network | The VPC *does* have a Flow Log — it's defined in the MonitoringStack (logging module). cdk-nag only sees one stack at a time. |
| `AwsSolutions-SMG4` | Database | Secret rotation is intentionally config-gated (off for dev). Enable with `-c enableRotation=true`. |
| `AwsSolutions-RDS10` | Database | Deletion protection is intentionally tied to `retainData` so dev tears down cleanly; it's on when `retainData=true`. |
| `AwsSolutions-L1` | Compute | Runtime is intentionally pinned to `python3.13` (the current latest) to match the deployed functions; pinning is deliberate. |
| `AwsSolutions-IAM4` | Compute, Storage | The AWS-managed `AWSLambdaBasicExecutionRole` / `AWSLambdaVPCAccessExecutionRole` are used for logging and ENI management. |
| `AwsSolutions-IAM5` | Compute, Storage | Scoped wildcards only: the Bedrock grant is scoped to the **configured model** (`anthropic.claude-sonnet-4-6*`, one trailing wildcard for region/version variants — not the whole `claude-*` family), namespace-conditioned `PutMetricData` (no resource-level ARN exists for this action), CloudFront `CreateInvalidation`, prefix-scoped S3 grants, and the CDK BucketDeployment helper. |
| `AwsSolutions-APIG2` | Compute | Request validation is handled in `api-handler`; the API is a proxy for AI agents. |
| `AwsSolutions-APIG3` | Compute | WAF is planned at the CloudFront edge, not per-API, for the demo. |
| `AwsSolutions-APIG4` / `COG4` | Compute | The API is **intentionally public and unauthenticated** so external AI engines (ChatGPT, Perplexity) can call it — a core design requirement. |
| `AwsSolutions-L1` (BucketDeployment) | Storage | The CDK-managed BucketDeployment helper Lambda's runtime is controlled by CDK. |
| `AwsSolutions-CFR1` / `CFR2` / `CFR4` | Edge | Demo distribution: no geo-restrictions, no WAF, and the default CloudFront certificate (fixed at TLSv1). A custom domain + cert is planned before production. |

## Known trade-offs (prototype)

These are conscious prototype decisions, not oversights. Revisit before
production:

1. **Public unauthenticated API.** Required for external AI-engine access.
   Consider an API key, usage plan, WAF, or a lightweight auth layer if the API
   should not be fully open.
2. **CloudFront OAC wildcard on the FIRST deploy only.** Before the distribution
   exists, the S3 OAC `SourceArn` condition falls back to an account-scoped
   `distribution/*` wildcard (still bounded by `SourceAccount`). It tightens to
   the exact distribution ARN automatically once you redeploy with
   `-c distributionId=...`.
3. **`cloudfront:CreateInvalidation` on `*`.** CloudFront invalidation does not
   support resource-level ARNs well; scope via a permissions boundary if needed.
4. **CloudFront default certificate (TLSv1).** Add a custom domain + ACM cert
   (TLS 1.2_2021) for production.
5. **No secret rotation by default.** Enable with `-c enableRotation=true`.
6. **Lambda / API Gateway logs stay in CloudWatch.** S3 isn't a valid direct
   destination; an export pipeline is deferred (see [DEPLOYMENT.md](DEPLOYMENT.md)).

## Productionization: concierge chat

The async submit/poll chat (`ConciergeChatStack`) is a **reference sample**, not
a production service. It ships the correctness/safety basics — public-endpoint
hygiene (generic errors, server-side session ids, request validation + length
cap), stage access/exec logging, stage **throttling** (a cost guard against a
runaway client driving the ~49s Bedrock worker), and `retryAttempts: 0` so a
failure never reruns the expensive loop. The following are **intentionally left
out** and are the steps you'd add for production.

> For the full LLM- and public-endpoint-specific checklist (prompt injection,
> denial-of-wallet, excessive agency, hallucination, and what the sample already
> handles), see the
> [LLM-specific Production Hardening Guide](GEO%20Blog%20-%20LLM%20specific%20Production%20Hardening%20Guide.md).
> The summary below is the short version.

1. **Worker on-failure resilience.** The worker records in-invocation failures
   itself, but a failure that kills the invocation outright (crash / timeout /
   OOM) leaves the job `PENDING` until its ~1h TTL (the browser poll just times
   out). Add a Lambda **on-failure destination** — a *separate* function; AWS
   rejects a function as its own destination — that marks such jobs `ERROR`.
2. **Alarms.** No CloudWatch alarms are defined. Add alarms for worker `Errors`
   and `Duration`, `AsyncEventsDropped`, `Throttles`, and API Gateway `5XXError`,
   wired to an SNS topic, so operators learn of failures the demo surfaces only
   via a timed-out poll.
3. **WAF.** The chat API is a regional API Gateway endpoint **not** behind
   CloudFront, so the edge is not WAF-protected. Add an API-level `WebACL`
   (or route `/chat` through CloudFront) for rate/abuse protection beyond the
   stage throttling.
4. **Auth.** The endpoint is intentionally public/unauthenticated for the demo
   widget; add an authorizer / API key / usage plan if it should not be open.

## Guardrail: data teardown

`retainData` controls whether stateful resources survive `cdk destroy`. For any
non-throwaway environment, deploy with `-c retainData=true` so the S3 bucket is
retained and Aurora takes a final snapshot with deletion protection.

## Dependency vulnerabilities (dev toolchain)

All runtime code that executes in deployed infrastructure is **Python** (the
Lambdas). The npm packages here are **build / test / synth tooling only**
(`aws-cdk-lib`, `jest`, `ts-jest`, eslint) — none ship to a Lambda or run in
the deployed app.

Fixed via `overrides` in `package.json`:

| Package | Was | Pinned to | CVE(s) resolved |
| ------- | --- | --------- | --------------- |
| `handlebars` (via ts-jest) | 4.7.9 | **4.7.10** | CVE-2026-106445, -106446 (critical JS injection), -106444 |
| `sprintf-js` (via argparse) | 1.0.3 | **1.1.3** | CVE-2026-97058 (DoS) |
| `brace-expansion` | 5.0.9 | **5.0.12** / 2.1.7 / 1.1.21 | CVE-2026-102276/-102277/-102278 |
| `aws-cdk-lib` (bundled brace-expansion) | 2.269.0 | **2.273.0** | pulls a patched bundled `minimatch`/`brace-expansion` |

### Accepted finding: `braces` stack-exhaustion DoS (`GHSA-vfj7-8cjw-p6xm`)

`braces@3.0.3` (pulled by `micromatch`, pulled by `jest`) is flagged, but
**3.0.3 is the latest published version** — there is no patched `braces` release
to upgrade to. npm's only offered remediation is a **major** bump of `jest`
(29 → 30), which is a breaking change to the test framework. We accept this:

- The package is **dev/test tooling**, never deployed and never fed
  attacker-controlled input (jest globs trusted local test paths).
- The vuln is a crafted-input DoS, not reachable in a trusted local test run.
- It will clear on its own when `jest`/`micromatch` publish a release off the
  patched `braces` line; revisit on the next routine `jest` major upgrade.
