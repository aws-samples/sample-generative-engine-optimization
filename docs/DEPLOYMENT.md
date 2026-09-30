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
- **Target account + region.** The config resolves the region from
  `CDK_DEPLOY_REGION` / `CDK_DEFAULT_REGION` (falling back to `us-east-1`) and
  the account from `CDK_DEPLOY_ACCOUNT` / `CDK_DEFAULT_ACCOUNT`. To deploy to a
  specific account/region, set these before any CDK command. Example
  (PowerShell, deploying to `501683248676` / `ca-central-1` via the `GEO_BLOG`
  profile):
  ```powershell
  $env:AWS_PROFILE        = "GEO_BLOG"
  $env:CDK_DEPLOY_ACCOUNT = "501683248676"
  $env:CDK_DEPLOY_REGION  = "ca-central-1"
  $env:AWS_REGION         = "ca-central-1"
  aws sts get-caller-identity --profile GEO_BLOG   # confirm the right account
  ```
- **CDK bootstrap** in the target account/region (one-time):
  ```bash
  npx cdk bootstrap aws://501683248676/ca-central-1 --profile GEO_BLOG
  ```
- Install dependencies:
  ```bash
  npm install
  ```

> **PowerShell note.** CDK writes progress/warnings to stderr, which PowerShell
> renders as red `NativeCommandError` text even on success. Append `2>&1` to CDK
> commands (e.g. `npx cdk deploy ... 2>&1`) so they render as normal output, and
> judge success by the actual result, not the red text.

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
geo-demo-dev-network      geo-demo-dev-edge
geo-demo-dev-storage      geo-demo-dev-workflow
geo-demo-dev-database     geo-demo-dev-monitoring
geo-demo-dev-compute      geo-demo-dev-ai (todo)
                          geo-demo-dev-analytics (todo)
```

`ai` and `analytics` are placeholders (empty templates) and can be skipped.

## Deploy

Deploy everything (CDK resolves dependency order automatically):

```bash
npm run deploy -- --all
```

Or deploy a single stack at a time (recommended for the first deploy so you can
watch each one). `--require-approval never` skips the IAM/security-group prompts:

```powershell
npx cdk deploy geo-demo-dev-network    --profile GEO_BLOG --require-approval never 2>&1
npx cdk deploy geo-demo-dev-storage    --profile GEO_BLOG --require-approval never 2>&1
npx cdk deploy geo-demo-dev-database   --profile GEO_BLOG --require-approval never 2>&1
npx cdk deploy geo-demo-dev-compute    --profile GEO_BLOG --require-approval never 2>&1
npx cdk deploy geo-demo-dev-edge       --profile GEO_BLOG --require-approval never 2>&1
npx cdk deploy geo-demo-dev-workflow   --profile GEO_BLOG --require-approval never 2>&1
npx cdk deploy geo-demo-dev-monitoring --profile GEO_BLOG --require-approval never 2>&1
```

Recommended first-deploy order (matches dependencies):

```
network → storage → database → compute → edge → workflow → monitoring
```

> **API Gateway CloudWatch role (account-level, one-time per region).** The API
> stage enables access logging, which requires an account-level CloudWatch Logs
> role for API Gateway. The ComputeStack creates it automatically
> (`cloudWatchRole: true` + the `disableCloudWatchRole` feature flag set to
> `false` in `cdk.json`) as an `AWS::ApiGateway::Account` resource. This setting
> is region-global — it applies to all API Gateways in the region. Without it
> the stage fails: *"CloudWatch Logs role ARN must be set in account settings"*.

> **Schema + data load.** Deploying `geo-demo-dev-database` runs the `db-loader`
> custom resource, which applies `assets/db/geo_demo_full.sql` (uploaded to
> `code/db/`) to the new cluster via the RDS Data API. It runs automatically
> after the cluster is ready and re-runs whenever the SQL content changes.
> Because it applies ~8k statements sequentially over the Data API, the database
> stack can take a few minutes on first deploy. The script is re-runnable, so a
> failed/interrupted load can be retried by re-deploying. `storage` must be
> deployed before `database` (the loader reads the SQL from the bucket).

### Two-phase step: CloudFront distribution id for the promoter

The `promoter` Lambda invalidates the CloudFront distribution, but the
distribution id isn't known until the EdgeStack is first deployed (and passing
it back into Compute directly would create a dependency cycle). So:

1. Deploy normally. On the first pass the promoter has no `DISTRIBUTION_ID` and
   simply skips invalidation.
2. Read the EdgeStack output `DistributionId`:
   ```powershell
   $distId = aws cloudformation describe-stacks --stack-name geo-demo-dev-edge `
     --query "Stacks[0].Outputs[?OutputKey=='DistributionId'].OutputValue" `
     --output text --profile GEO_BLOG --region ca-central-1
   ```
3. Re-deploy Compute with the id via context:
   ```powershell
   npx cdk deploy geo-demo-dev-compute --profile GEO_BLOG --require-approval never -c distributionId=$distId 2>&1
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

## Teardown & clean reinstall

Because cross-stack references use **strong** strength, destroy in reverse
dependency order (or use `--all`, which handles ordering):

```powershell
npx cdk destroy --all --profile GEO_BLOG 2>&1
```

Teardown behavior is governed by `retainData` (default `false` for dev):

- **`retainData=false`** (default): S3 objects auto-delete, the bucket is
  destroyed, and Aurora is destroyed with **no** deletion protection and no
  final snapshot — a clean, complete teardown.
- **`retainData=true`**: the bucket is retained, and Aurora uses a `SNAPSHOT`
  removal policy with deletion protection enabled. `cdk destroy` will leave
  those stateful resources behind by design.

```powershell
# Destroy but keep data (prod-like)
npx cdk destroy --all --profile GEO_BLOG -c retainData=true 2>&1
```

### Does destroy fully clean up so I can reinstall?

**Yes, when `retainData=false`.** Every resource that would otherwise block a
fresh create is destroyed:

- **All Lambda log groups** (`/aws/lambda/geo-demo-dev-*`) and the API Gateway
  access log group (`/geo-demo-dev/apigw/access`) are declared explicitly with
  `removalPolicy: DESTROY`, so they are removed on teardown. This is deliberate:
  named log groups that survive teardown would cause a later deploy to fail with
  *"log group already exists"*.
- The **S3 bucket** empties and deletes (`autoDeleteObjects`), and **Aurora** is
  destroyed with no final snapshot.

So `cdk destroy --all` followed by a fresh `cdk deploy` is clean.

> **Note on interrupted / rolled-back deploys.** If a deploy *failed* on a
> version of the code that did not yet declare explicit log groups (or you
> Ctrl-C'd a rollback), some named log groups can be orphaned and block the next
> create. This is a one-time cleanup, not a normal-teardown issue:
> ```powershell
> foreach ($fn in "api-handler","citation-tracker","patch-applier","promoter","db-loader") {
>   aws logs delete-log-group --log-group-name "/aws/lambda/geo-demo-dev-$fn" --profile GEO_BLOG --region ca-central-1 2>$null
> }
> aws logs delete-log-group --log-group-name "/geo-demo-dev/apigw/access" --profile GEO_BLOG --region ca-central-1 2>$null
> ```
> A CloudFormation rollback runs **server-side** — cancelling the terminal
> command does not stop it. VPC-attached Lambda deletion waits on ENI cleanup and
> can take 15–20 minutes; that is normal, not a hang. If a stack lands in
> `ROLLBACK_COMPLETE` (a create that never succeeded), delete it before
> redeploying: `npx cdk destroy geo-demo-dev-compute --profile GEO_BLOG`.

If a destroy fails because a bucket is non-empty, confirm `retainData` is
`false` (which sets `autoDeleteObjects`) and retry.

## Troubleshooting

| Symptom | Likely cause / fix |
| ------- | ------------------ |
| `synth` fails in `--strict` with an `AwsSolutions-*` ERROR | A new cdk-nag finding. Fix the resource or add a documented `NagSuppressions` entry. See [SECURITY.md](SECURITY.md). |
| `DependencyCycle` at synth | A cross-stack reference points both ways. See the "Cross-stack references" section in [ARCHITECTURE.md](ARCHITECTURE.md); pass a name/id instead of a live construct. |
| Promoter isn't invalidating CloudFront | `distributionId` not supplied. Re-deploy Compute with `-c distributionId=...` (two-phase step above). |
| `api-handler` can't reach Aurora | Confirm the `rds-data` VPC interface endpoint exists (NetworkStack) and the cluster has the Data API enabled (DatabaseStack). |
| Stage fails: *"CloudWatch Logs role ARN must be set in account settings"* | The account-level API Gateway CloudWatch role is missing. The ComputeStack creates it (`cloudWatchRole: true`); ensure `@aws-cdk/aws-apigateway:disableCloudWatchRole` is `false` in `cdk.json`. |
| `Resource ... 'AWS::Logs::LogGroup' ... already exists` | A named log group orphaned by a prior failed deploy. Delete it (see the one-time cleanup under Teardown) and redeploy. Current code declares these with `removalPolicy: DESTROY`, so normal teardown avoids this. |
| Schema loader (`db-loader`) fails | Check its CloudWatch logs (`/aws/lambda/geo-demo-dev-db-loader`). The SQL is re-runnable; re-deploy `geo-demo-dev-database` to retry. Confirm `storage` deployed first (the SQL must exist at `code/db/geo_demo_full.sql`). |
| Bucket delete blocked on destroy | `retainData=true` retains it by design, or objects remain; set `retainData=false`. |
| `git push` fails `Permission denied (publickey)` | The GitLab SSH certificate expired; refresh it and retry. |

## CI notes

`npm run test` runs only the unit suite (fast, no AWS). `npm run test:integ`
self-skips when its required env vars are absent, so it's safe to run in CI
without a live deployment.
