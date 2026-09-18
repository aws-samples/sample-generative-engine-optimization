# generative-engine-optimization-aws

AWS CDK (TypeScript) infrastructure for a blog platform. The app is organized
as a set of small, single-responsibility stacks so each component can be built
out and deployed independently.

> Status: **in progress**. `NetworkStack` is implemented; the remaining stacks
> are documented placeholders that synthesize cleanly. Components are fleshed
> out incrementally.

## Architecture

```
                          ┌──────────────┐
        internet ───────► │  CloudFront  │  (EdgeStack)
                          └──────┬───────┘
                     static │           │ /api/*
                 (S3 OAC)   ▼           ▼
              ┌───────────────┐   ┌──────────────┐
              │ Content bucket│   │  Lambda + API │  (ComputeStack)
              │  (StorageStack│   │              │
              └───────────────┘   └───┬───────┬──┘
                                       │       │
                            ┌──────────▼─┐   ┌─▼───────────────┐
                            │   Aurora   │   │  Bedrock agent  │  (AiStack)
                            │(DatabaseStk)│   └─────────────────┘
                            └────────────┘
   data-lake bucket ──► Glue + Athena (AnalyticsStack)
   everything ───────► CloudWatch logs, alarms, dashboard (MonitoringStack)
   VPC / subnets / SGs / endpoints (NetworkStack) underpins DB + compute
```

### Stacks (`lib/stacks`)

| Stack             | Component            | Status | Responsibility                                   |
| ----------------- | -------------------- | ------ | ------------------------------------------------ |
| `NetworkStack`    | VPC                  | ✅ done | Subnets, NAT, security groups, VPC endpoints, flow logs |
| `StorageStack`    | S3                   | ⬜ todo | Content, data-lake, and Athena query buckets     |
| `DatabaseStack`   | Aurora               | ⬜ todo | Serverless v2 cluster + Secrets Manager creds    |
| `ComputeStack`    | Lambda + API         | ⬜ todo | Blog backend functions and API surface           |
| `AiStack`         | Bedrock agent        | ⬜ todo | Generative AI features (agent, KB, action groups)|
| `AnalyticsStack`  | Athena               | ⬜ todo | Glue catalog + Athena workgroup over S3 data     |
| `EdgeStack`       | CloudFront           | ⬜ todo | Public CDN, S3 (OAC) + API routing               |
| `MonitoringStack` | CloudWatch           | ⬜ todo | Log groups, alarms, dashboard, SNS alerting      |

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
  Secrets Manager, Bedrock (+ runtime, + agent-runtime), and CloudWatch Logs so
  that traffic avoids the NAT and stays on the AWS network.
- **Security groups**:
  - `lambda-sg` — attached to the API functions; no inbound, egress allowed.
  - `database-sg` — Aurora; inbound `5432` **only** from `lambda-sg`.
  - `endpoint-sg` — interface endpoints; inbound `443` from `lambda-sg`.
- **VPC flow logs** to CloudWatch (retention + removal driven by `retainData`).

Outputs `VpcId`, `LambdaSecurityGroupId`, and `DatabaseSecurityGroupId` are
exported for cross-stack use by `DatabaseStack` and `ComputeStack`.

## Project layout

```
bin/app.ts            CDK app entry point — instantiates + wires all stacks
lib/config/           Central config: defaults + CDK-context overrides (network, tags, naming)
lib/stacks/           One stack per component (NetworkStack done; others skeletons)
lib/constructs/       Reusable L3 constructs, one per component
test/unit/            Jest synthesis tests (fast, no AWS calls)
test/integration/     Jest tests against deployed resources (self-skip w/o env)
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
Each tunable has a **default** (in `NETWORK_DEFAULTS` / `DEFAULT_RETAIN_DATA`)
that a user can **override at deploy time via CDK context** (`-c key=value`)
without editing any source. Overrides are validated, so a bad value fails fast
at synth with a clear message.

Account/region resolve from the CDK CLI environment or the
`CDK_DEPLOY_ACCOUNT` / `CDK_DEPLOY_REGION` vars.

| Context key      | Default        | Validation            | Meaning                                        |
| ---------------- | -------------- | --------------------- | ---------------------------------------------- |
| `cidr`           | `10.0.0.0/16`  | IPv4 CIDR, /16../28    | VPC IPv4 CIDR block                             |
| `maxAzs`         | `2`            | integer 1..6           | Availability Zones to span                      |
| `natGateways`    | `1`            | integer 0..maxAzs      | NAT gateways (1 = single regional; bump for HA) |
| `subnetCidrMask` | `24`           | integer 16..28         | Netmask for each subnet CIDR                     |
| `databasePort`   | `5432`         | integer 1..65535       | Database port (PostgreSQL)                       |
| `retainData`     | `false`        | truthy                 | Retain stateful resources on stack deletion      |

Examples:

```bash
# Use defaults
npm run deploy -- --all

# Bring your own CIDR and full-HA NAT
npm run deploy -- --all -c cidr=10.42.0.0/16 -c maxAzs=2 -c natGateways=2
```

To change a **default** for everyone, edit `NETWORK_DEFAULTS` in
`lib/config/index.ts`. To change a value for a **single deploy**, pass it as
context — no code change needed.

## Compliance

`bin/app.ts` applies cdk-nag's `AwsSolutionsChecks` at synth time. As stacks are
implemented, resolve findings (or add scoped `NagSuppressions` with a reason)
before deploying.

## Next steps

Flesh out each remaining stack/construct pair in dependency order:
~~Network~~ → Storage → Database → Compute → Ai → Analytics → Edge → Monitoring.
Add resource assertions to a dedicated unit test per stack (see
`test/unit/network-stack.test.ts` as the template) and live checks to the
integration suite as you go.
