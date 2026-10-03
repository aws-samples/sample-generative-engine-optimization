# Integration Tests

These tests run against **real, deployed AWS resources** — unlike the unit tests
(which only synthesize templates). Run them after `cdk deploy` against a
non-production environment.

```powershell
# 1. Deploy the stacks you want to test
npm run deploy -- --all

# 2. Point the tests at the deployment (the CloudFront distribution domain).
#    The suite self-skips any block whose required env vars are unset.
$env:BLOG_URL = "https://dxxxxxxxxxxxxx.cloudfront.net"

# 3. Run the integration suite
npm run test:integ
```

Grab the CloudFront URL from the EdgeStack output:

```powershell
$env:BLOG_URL = "https://" + (aws cloudformation describe-stacks `
  --stack-name geo-demo-dev-edge `
  --query "Stacks[0].Outputs[?OutputKey=='DistributionDomainName'].OutputValue" `
  --output text)
```

## How it works

Tests read endpoints from env vars, call the live endpoints (CloudFront URL,
API, Athena, Bedrock agent), and assert on real responses. Each block is guarded
by `describeIfDeployed([...])` (see `helpers.ts`), which **skips** the block when
any required env var is missing — so `npm run test:integ` is safe to run in CI
without a deployment. The current smoke test requires `BLOG_URL`.

As components are implemented, add:

- CloudFront: GET the distribution URL, assert 200 + security headers
- API/Lambda: exercise the REST endpoints end-to-end
- Aurora: query via the api-handler / RDS Data API and assert rows
- Bedrock agent: invoke the agent / concierge harness and assert a response
- Athena: run a named query and assert results
- CloudWatch: assert log groups receive events
