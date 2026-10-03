# Reusable Constructs

Composable L3 constructs, one per platform component. Stacks in `lib/stacks`
instantiate these rather than defining resources inline, keeping stacks thin and
constructs unit-testable in isolation.

Most constructs are implemented. Two (`BlogBedrockAgent`, `BlogAnalytics`)
remain typed placeholders — their stacks currently build the resources from L1
(`Cfn*`) resources directly instead of going through the construct (see the
"Status" column).

| Construct            | Owns                                                       | Used by          | Status |
| -------------------- | ---------------------------------------------------------- | ---------------- | ------ |
| `BlogNetwork`        | VPC, subnets, security groups, VPC endpoints               | NetworkStack     | ✅ implemented |
| `ContentStorage`     | Single S3 content bucket (prefixes) + asset upload         | StorageStack     | ✅ implemented |
| `BlogDatabase`       | Aurora cluster, Secrets Manager secret, (optional) RDS Proxy | DatabaseStack  | ✅ implemented |
| `BlogApi`            | 4 Lambda functions + public REST API Gateway               | ComputeStack     | ✅ implemented |
| `BlogDistribution`   | CloudFront distribution + policies + OAC                   | EdgeStack        | ✅ implemented |
| `BlogWorkflow`       | GEO feedback-loop Step Functions state machine             | WorkflowStack    | ✅ implemented |
| `BlogObservability`  | Logging module: VPC Flow Logs → S3 `logs/vpc_flow/`        | MonitoringStack  | ✅ implemented |
| `BlogBedrockAgent`   | (placeholder) Bedrock agent, alias, action groups, KB      | — (AiStack builds AgentCore L1 directly) | ⬜ placeholder |
| `BlogAnalytics`      | (placeholder) Glue catalog + Athena workgroup              | — (AnalyticsStack builds Glue/Athena L1 directly) | ⬜ placeholder |

Notes:

- `ContentStorage` provisions **one** bucket with prefixes (`web_application/`,
  `code/`, `logs/…`, `staging/`), not separate content/data-lake/query-results
  buckets.
- `BlogApi` fronts its Lambdas with an API Gateway REST API, not a Lambda
  Function URL.
- `BlogObservability` is a logging module (routes S3-capable log sources to the
  shared bucket). CloudWatch dashboards, alarms, and an SNS topic are deferred.
- `BlogWorkflow` is exported from each construct module but not re-exported by
  `lib/constructs/index.ts`; `WorkflowStack` imports it directly from
  `../constructs/blog-workflow.js`.
- The on-site chat (`ConciergeChatStack`) is composed inline in its stack and
  has no dedicated construct.
- Construct classes keep the `Blog*` prefix from the original project name; a
  broad rename was deferred. All user-facing resource names use `geo-demo`.
