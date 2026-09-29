# Reusable Constructs

Composable L3 constructs, one per platform component. Stacks in `lib/stacks`
instantiate these rather than defining resources inline, keeping stacks thin and
constructs unit-testable in isolation.

Each file is currently a typed placeholder with a documented `props` interface
and a `TODO` for the resources it will own. Flesh them out as component details
firm up.

| Construct            | Owns                                             | Used by          |
| -------------------- | ------------------------------------------------ | ---------------- |
| `BlogNetwork`        | VPC, subnets, security groups, VPC endpoints     | NetworkStack     |
| `ContentStorage`     | S3 content + data-lake + query-results buckets   | StorageStack     |
| `BlogDatabase`       | Aurora cluster, secret, (optional) RDS Proxy     | DatabaseStack    |
| `BlogApi`            | Lambda functions + API Gateway / function URL    | ComputeStack     |
| `BlogBedrockAgent`   | Bedrock agent, alias, action groups, KB          | AiStack          |
| `BlogAnalytics`      | Glue catalog + Athena workgroup                  | AnalyticsStack   |
| `BlogDistribution`   | CloudFront distribution + policies + OAC         | EdgeStack        |
| `BlogObservability`  | CloudWatch dashboard, alarms, SNS topic          | MonitoringStack  |
