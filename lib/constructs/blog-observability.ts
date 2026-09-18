import { Construct } from 'constructs';

/**
 * Props for {@link BlogObservability}.
 * TODO: add references to the resources to monitor + alarm email/endpoints.
 */
export interface BlogObservabilityProps {
  readonly prefix: string;
}

/**
 * BlogObservability — CloudWatch dashboard, alarms, and alerting.
 *
 * TODO (flesh out later):
 *  - Dashboard widgets for CloudFront, Lambda, Aurora, Bedrock metrics
 *  - Alarms (Lambda errors/throttles, 5xx rate, Aurora CPU/connections)
 *  - SNS topic + subscriptions for notifications
 *  - Log-group retention + metric filters for error patterns
 */
export class BlogObservability extends Construct {
  // public readonly alarmTopic: sns.ITopic;
  // public readonly dashboard: cloudwatch.Dashboard;

  constructor(scope: Construct, id: string, _props: BlogObservabilityProps) {
    super(scope, id);
    // Placeholder.
  }
}
