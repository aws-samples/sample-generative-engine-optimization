# Integration Tests

These tests run against **real, deployed AWS resources** — unlike the unit tests
(which only synthesize templates). Run them after `cdk deploy` against a
non-production environment.

```bash
# 1. Deploy the stacks you want to test
npm run deploy -- --all -c env=dev

# 2. Point the tests at the deployment
$env:APP_ENV = "dev"
$env:AWS_REGION = "us-east-1"

# 3. Run the integration suite
npm run test:integ
```

## How it works

Tests read stack outputs / resource names (via env vars or the CloudFormation
SDK), call the live endpoints (CloudFront URL, API, Athena, Bedrock agent), and
assert on real responses. They are skipped automatically when the required
environment variables are absent, so `npm run test:integ` is safe to run in CI
without a deployment.

As components are implemented, add:
- CloudFront: GET the distribution URL, assert 200 + security headers
- API/Lambda: exercise CRUD endpoints end-to-end
- Aurora: connect (via a test Lambda or RDS Data API) and run a query
- Bedrock agent: invoke the agent alias and assert a response
- Athena: run a named query and assert results
- CloudWatch: assert alarms exist and log groups receive events
```
