import { Stack } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { BaseStackProps } from './stack-props.js';

/**
 * MonitoringStack — observability for the blog platform.
 *
 * Responsibility: CloudWatch log groups, metrics, alarms, dashboards, and
 * alerting. Centralizes cross-cutting observability so every other stack can
 * surface its telemetry in one place.
 *
 * TODO (flesh out later):
 *  - CloudWatch dashboard (CloudFront, Lambda, Aurora, Bedrock metrics)
 *  - Alarms (Lambda errors/throttles, 5xx rate, Aurora CPU/connections)
 *  - SNS topic for alarm notifications
 *  - Log-group retention + metric filters for error patterns
 *
 * Depends on: consumes references from Compute/Edge/Database/Ai stacks.
 */
export interface MonitoringStackProps extends BaseStackProps {
  // Pass in the resources to monitor once the producing stacks expose them, e.g.:
  // readonly lambdaFunctions?: lambda.IFunction[];
  // readonly distributionId?: string;
}

export class MonitoringStack extends Stack {
  // public readonly alarmTopic: sns.ITopic;
  // public readonly dashboard: cloudwatch.Dashboard;

  constructor(scope: Construct, id: string, props: MonitoringStackProps) {
    super(scope, id, props);

    // Placeholder — dashboards, alarms, and SNS topic will be added here.
    void props.config;
  }
}
