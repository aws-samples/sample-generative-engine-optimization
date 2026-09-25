# Deployment & Operations

How to build, deploy, operate, and tear down the Octank Hospitality CDK app.

## Prerequisites

- **Node.js 20+** (developed on 24).
- **AWS credentials** for the target account. Verify:
  ```bash
  aws sts get-caller-identity
  ```
  If you use a named profile (e.g. the demo account uses `GEO_BLOG`):
  ```bash
  aws sts get-caller-identity --profile GEO_BLOG
  export AWS_PROFILE=GEO_BLOG   # or pass --profile per command
  ```
- **CDK bootstrap** in the target account/region (one-time):
  ```bash
  npx cdk bootstrap aws://<account>/<region>
  ```
- Install dependencies:
  ```bash
  npm install
  ```

## Everyday commands

```bash
npm run build       # type-check (tsc --noEmit)
npm run test        # unit tests (synthesis assertions, no AWS calls)
npm run lint        # eslint
npm run synth       # cdk synth --strict (all stacks, runs cdk-nag)
npm run diff        # cdk diff against deployed state
```

Always run `npm run build && npm run test && npm run synth` before deploying.

## Stacks

The app defines eight stacks (IDs prefixed `geo-demo-dev-`):

```
geo-demo-dev-network      geo-demo-dev-compute
geo-demo-dev-storage      geo-demo-dev-edge
geo-demo-dev-database     geo-demo-dev-monitoring
geo-demo-dev-ai (todo)    geo-demo-dev-analytics (todo)
```

`ai` and `analytics` are placeholders (empty templates) and can be skipped.

## Deploy

Deploy everything (CDK resolves dependency order automatically):

```bash
npm run deploy -- --all
```

Or deploy a single stack (and its dependencies):

```bash
npx cdk deploy geo-demo-dev-network
npx cdk deploy geo-demo-dev-storage
npx cdk deploy geo-demo-dev-database
npx cdk deploy geo-demo-dev-compute
npx cdk deploy geo-demo-dev-edge
npx cdk deploy geo-demo-dev-monitoring
```

Recommended first-deploy order (matches dependencies):

```
network → storage → database → compute → edge → monitoring
```

### Two-phase step: CloudFront distribution id for the promoter

The `promoter` Lambda invalidates the CloudFront distribution, but the
distribution id isn't known until the EdgeStack is first deployed (and passing
it back into Compute directly would create a dependency cycle). So:

1. Deploy normally. On the first pass the promoter has no `DISTRIBUTION_ID` and
   simply skips invalidation.
2. Read the EdgeStack output `DistributionId` (e.g. `E2HKAT79V522DO`).
3. Re-deploy Compute with the id via context:
   ```bash
   npx cdk deploy geo-demo-dev-compute -c distributionId=E2HKAT79V522DO
   ```

## Overriding configuration at deploy time

All tunables have defaults and can be overridden with `-c key=value` — no code
change needed. Overrides are validated at synth (a bad value fails fast).

```bash
# Bring your own CIDR + full-HA NAT
npm run deploy -- --all -c cidr=10.42.0.0/16 -c maxAzs=2 -c natGateways=2

# Larger Lambdas, custom Bedrock model, cheaper CloudFront tier
npm run deploy -- --all -c lambdaMemoryMb=256 -c priceClass=100
```

See [CONFIGURATION.md](CONFIGURATION.md) for the complete key reference.

## Verifying a deployment

- **API**: use the `geo-demo-dev-compute` output `ApiEndpoint`:
  ```bash
  curl "$API_ENDPOINT/properties"
  ```
- **Site**: open the `geo-demo-dev-edge` output `DistributionDomainName` in a
  browser (serves `web_application/index.html`).
- **Integration tests** (against the live deployment; self-skip without env):
  ```bash
  $env:BLOG_URL = "https://<distribution-domain>"   # PowerShell
  npm run test:integ
  ```

## Logging: where to find what

| Source                | Location                                    |
| --------------------- | ------------------------------------------- |
| CloudFront access     | S3 `logs/cf_logs/`                          |
| VPC Flow Logs         | S3 `logs/vpc_flow/`                          |
| S3 server access      | S3 `logs/s3/`                               |
| Athena query results  | S3 `logs/athena_logs/` (once Analytics ships) |
| Lambda functions      | CloudWatch Logs (`/aws/lambda/geo-demo-dev-*`) |
| API Gateway access    | CloudWatch Logs (`/geo-demo-dev/apigw/access`) |

> API Gateway and Lambda logs can only go to CloudWatch (S3 is not a valid
> direct destination). Archiving them to S3 would need a
> CloudWatch → Firehose → S3 pipeline, deferred beyond the prototype.

## Teardown

Because cross-stack references use **strong** strength, destroy in reverse
dependency order (or use `--all`, which handles ordering):

```bash
npm run destroy -- --all
```

Teardown behavior is governed by `retainData` (default `false` for dev):

- **`retainData=false`** (default): S3 objects auto-delete, the bucket is
  destroyed, and Aurora is destroyed with **no** deletion protection and no
  final snapshot — a clean, complete teardown.
- **`retainData=true`**: the bucket is retained, and Aurora uses a `SNAPSHOT`
  removal policy with deletion protection enabled. `cdk destroy` will leave
  those stateful resources behind by design.

```bash
# Destroy but keep data (prod-like)
npm run destroy -- --all -c retainData=true
```

If a destroy fails because a bucket is non-empty, confirm `retainData` is
`false` (which sets `autoDeleteObjects`) and retry.

## Troubleshooting

| Symptom | Likely cause / fix |
| ------- | ------------------ |
| `synth` fails in `--strict` with an `AwsSolutions-*` ERROR | A new cdk-nag finding. Fix the resource or add a documented `NagSuppressions` entry. See [SECURITY.md](SECURITY.md). |
| `DependencyCycle` at synth | A cross-stack reference points both ways. See the "Cross-stack references" section in [ARCHITECTURE.md](ARCHITECTURE.md); pass a name/id instead of a live construct. |
| Promoter isn't invalidating CloudFront | `distributionId` not supplied. Re-deploy Compute with `-c distributionId=...` (two-phase step above). |
| `api-handler` can't reach Aurora | Confirm the `rds-data` VPC interface endpoint exists (NetworkStack) and the cluster has the Data API enabled (DatabaseStack). |
| Bucket delete blocked on destroy | `retainData=true` retains it by design, or objects remain; set `retainData=false`. |
| `git push` fails `Permission denied (publickey)` | The GitLab SSH certificate expired; refresh it and retry. |

## CI notes

`npm run test` runs only the unit suite (fast, no AWS). `npm run test:integ`
self-skips when its required env vars are absent, so it's safe to run in CI
without a live deployment.
