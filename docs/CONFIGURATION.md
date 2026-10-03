# Configuration Reference

All configuration is **centralized** in [`lib/config/index.ts`](../lib/config/index.ts).
There is a single environment (`dev`). Every tunable has a **default** (in a
`*_DEFAULTS` object) and can be **overridden per-deploy via CDK context**
(`-c key=value`) without editing source. Overrides are **validated** at synth,
so an invalid value fails fast with a clear message.

## How resolution works

`getConfig(app)` (called in `bin/app.ts`) builds a single `AppConfig` object:

1. Start from the `*_DEFAULTS` for each group (network, database, storage,
   compute, edge, monitoring, workflow, analytics).
2. For each key, read CDK context (`app.node.tryGetContext(key)`); if present,
   validate and apply it.
3. Return the merged, typed config. Every stack derives its names, sizing, and
   policies from this object — nothing is hard-coded in the stacks.

```
defaults (*_DEFAULTS)  ──►  context overrides (-c key=value)  ──►  validate  ──►  AppConfig
```

Account/region resolve from the CDK CLI environment, or explicitly from the
`CDK_DEPLOY_ACCOUNT` / `CDK_DEPLOY_REGION` environment variables (falling back to
`us-east-1`).

## Changing values

- **For everyone (a new default):** edit the relevant `*_DEFAULTS` object in
  `lib/config/index.ts`.
- **For a single deploy:** pass `-c key=value`. Example:
  ```bash
  npm run deploy -- --all -c cidr=10.42.0.0/16 -c natGateways=2 -c lambdaMemoryMb=256
  ```

## Reference

### Network (`NETWORK_DEFAULTS`)

| Key              | Default       | Validation             | Meaning                                         |
| ---------------- | ------------- | ---------------------- | ----------------------------------------------- |
| `cidr`           | `10.0.0.0/16` | IPv4 CIDR, mask /16../28 | VPC IPv4 CIDR block                            |
| `maxAzs`         | `2`           | integer 1..6           | Availability Zones to span                      |
| `natGateways`    | `1`           | integer 0..maxAzs      | NAT gateways (1 = single regional; bump for HA) |
| `subnetCidrMask` | `24`          | integer 16..28         | Netmask for each subnet CIDR                    |
| `databasePort`   | `5432`        | integer 1..65535       | Database port (PostgreSQL)                      |

### Database (`DATABASE_DEFAULTS`)

| Key              | Default   | Validation        | Meaning                                          |
| ---------------- | --------- | ----------------- | ------------------------------------------------ |
| `dbName`         | `geo_db`  | string            | Initial database name                            |
| `engineVersion`  | `16.13`   | `major.minor`     | Aurora PostgreSQL version (pinned, never "latest") |
| `minAcu`         | `0.5`     | number 0.5..256   | Serverless v2 min capacity (ACU)                 |
| `maxAcu`         | `2`       | number ≥ minAcu   | Serverless v2 max capacity (ACU)                 |
| `readers`        | `0`       | integer 0..15     | Reader instances (0 = writer only)               |
| `enableProxy`    | `false`   | true/false        | Provision an RDS Proxy (connection pooling)      |
| `enableRotation` | `false`   | true/false        | Enable Secrets Manager credential rotation       |

> **Reconciliation note.** The `dbName` default is `geo_db`, matching the
> `geo_demo_full.sql` script and the database in the demo account
> (`501683248676`). Note that CDK-owned resources use the `geo-demo-dev-*`
> naming, whereas the pre-existing hand-built resources (`geo-demo-content-a2z4`,
> `geo-demo-db`) are separate — reconcile names before deploying into an account
> that already has them.

### Storage (`STORAGE_DEFAULTS`)

| Key                              | Default | Validation      | Meaning                                    |
| -------------------------------- | ------- | --------------- | ------------------------------------------ |
| `logRetentionDays`               | `90`    | integer 1..3650 | Expire objects under `logs/` after N days  |
| `queryResultRetentionDays`       | `30`    | integer 1..3650 | Expire Athena results (`logs/athena_logs/`) |
| `contentIaTransitionDays`        | `90`    | integer 1..3650 | Transition `web_application/` to Infrequent Access |
| `noncurrentVersionRetentionDays` | `30`    | integer 1..3650 | Expire noncurrent object versions          |

### Compute (`COMPUTE_DEFAULTS`)

| Key                      | Default                              | Validation         | Meaning                          |
| ------------------------ | ------------------------------------ | ------------------ | -------------------------------- |
| `lambdaMemoryMb`         | `128`                                | integer 128..10240 | Lambda memory (all functions)    |
| `apiTimeoutSeconds`      | `30`                                 | integer 1..900     | `api-handler` timeout            |
| `citationTimeoutSeconds` | `300`                                | integer 1..900     | `citation-tracker` timeout       |
| `workerTimeoutSeconds`   | `3`                                  | integer 1..900     | `patch-applier` / `promoter` timeout |
| `apiStageName`           | `prod`                               | string             | API Gateway stage name           |
| `apiThrottleRateLimit`   | `50`                                 | integer 1..10000   | API steady-state requests/sec    |
| `apiThrottleBurstLimit`  | `100`                                | integer 1..10000   | API burst requests               |
| `metricsNamespace`       | `GEO/CitationTracker`                | string             | CloudWatch metrics namespace (workers) |
| `bedrockModelId`         | `global.anthropic.claude-sonnet-4-6` | string             | Bedrock model for `citation-tracker` |

Additional (not in a `*_DEFAULTS` object; runtime input):

| Key              | Default | Meaning                                                       |
| ---------------- | ------- | ------------------------------------------------------------- |
| `distributionId` | (none)  | CloudFront distribution id for the promoter's invalidation (two-phase; see [DEPLOYMENT.md](DEPLOYMENT.md)) |

### Edge (`EDGE_DEFAULTS`)

| Key                 | Default      | Validation      | Meaning                        |
| ------------------- | ------------ | --------------- | ------------------------------ |
| `priceClass`        | `all`        | `all`/`200`/`100` | CloudFront price class       |
| `defaultRootObject` | `index.html` | string          | SPA root object                |
| `apiPathPattern`    | `/api/*`     | string          | Path routed to the API origin  |

### Monitoring (`MONITORING_DEFAULTS`)

| Key                  | Default | Validation             | Meaning                            |
| -------------------- | ------- | ---------------------- | ---------------------------------- |
| `flowLogTrafficType` | `ALL`   | `ALL`/`ACCEPT`/`REJECT` | VPC Flow Log traffic captured to S3 |

### Workflow (`WORKFLOW_DEFAULTS`)

Settings for the GEO feedback-loop Step Function (WorkflowStack). Note the
context keys are **not** the config field names: the resolver reads
`workflowLogging` / `workflowSchedule` / `workflowScheduleExpression` /
`workflowScheduleTimezone`.

| Key                         | Default            | Validation | Meaning                                                   |
| --------------------------- | ------------------ | ---------- | --------------------------------------------------------- |
| `workflowLogging`           | `true`             | true/false | CloudWatch execution logging + X-Ray tracing for the state machine |
| `workflowSchedule`          | `true`             | true/false | Create the EventBridge Scheduler schedule that triggers the loop |
| `workflowScheduleExpression`| `rate(7 days)`     | string     | Schedule expression (EventBridge Scheduler syntax)         |
| `workflowScheduleTimezone`  | `America/Chicago`  | string     | IANA timezone the schedule expression is evaluated in      |

### Analytics (`ANALYTICS_DEFAULTS`)

Names for the Glue catalog + Athena workgroup the AnalyticsStack creates over
the CloudFront logs. Each is overridable via CDK context like the other string
values (e.g. `-c analyticsWorkgroupName=my-wg`).

| Key                      | Default                 | Validation | Meaning                                 |
| ------------------------ | ----------------------- | ---------- | --------------------------------------- |
| `analyticsDatabaseName`  | `geo_demo_dev_logs`     | string     | Glue database holding the log table     |
| `analyticsTableName`     | `cloudfront_logs`       | string     | Glue EXTERNAL table over `logs/cf_logs/` |
| `analyticsWorkgroupName` | `geo-demo-dev-analytics` | string    | Athena workgroup name                    |

### Cross-cutting

| Key          | Default | Validation | Meaning                                          |
| ------------ | ------- | ---------- | ------------------------------------------------ |
| `retainData` | `false` | truthy     | Retain stateful resources (S3, Aurora) on stack deletion. `true` = prod-like: bucket retained, Aurora `SNAPSHOT` + deletion protection. |

## Validation behavior

Invalid overrides throw at synth with a descriptive message, e.g.:

```
Context "cidr" must be a valid IPv4 CIDR (e.g. 10.0.0.0/16), got "bad-value".
Context "maxAcu" (1) must be >= "minAcu" (2).
Context "priceClass" must be one of all|200|100, got "500".
```

This means a misconfiguration is caught **before** any resource is created.

## Storage prefixes (`STORAGE_PREFIXES`)

Not context-overridable, but the canonical object-key layout consumers share:

| Constant         | Value               |
| ---------------- | ------------------- |
| `webApplication` | `web_application/`  |
| `code`           | `code/`             |
| `logs`           | `logs/`             |
| `cloudFrontLogs` | `logs/cf_logs/`     |
| `athenaResults`  | `logs/athena_logs/` |
| `s3AccessLogs`   | `logs/s3/`          |
| `vpcFlowLogs`    | `logs/vpc_flow/`    |
| `staging`        | `staging/`          |
