import * as ec2 from 'aws-cdk-lib/aws-ec2';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { STORAGE_PREFIXES, type MonitoringConfig } from '../config/index.js';

const TRAFFIC_TYPE: Record<MonitoringConfig['flowLogTrafficType'], ec2.FlowLogTrafficType> = {
  ALL: ec2.FlowLogTrafficType.ALL,
  ACCEPT: ec2.FlowLogTrafficType.ACCEPT,
  REJECT: ec2.FlowLogTrafficType.REJECT,
};

/** Props for {@link BlogObservability}. */
export interface BlogObservabilityProps {
  /** Resource-name prefix (e.g. `geo-demo-dev`). */
  readonly prefix: string;
  /** Monitoring settings resolved from the environment config. */
  readonly monitoring: MonitoringConfig;
  /** The VPC to capture flow logs for (from the network layer). */
  readonly vpc: ec2.IVpc;
  /** The content bucket that receives logs (from the storage layer). */
  readonly logBucket: s3.IBucket;
}

/**
 * BlogObservability — the logging module for the GEO platform.
 *
 * Prototype scope (Option B): route every log source that natively supports S3
 * into the shared content bucket, and leave CloudWatch-only sources
 * (Lambda, API Gateway — which cannot write to S3) on CloudWatch.
 *
 * S3-destined logs (all under the bucket's `logs/` prefix):
 *  - VPC Flow Logs   -> logs/vpc_flow/   (configured here)
 *  - CloudFront      -> logs/cf_logs/    (EdgeStack)
 *  - S3 access logs  -> logs/s3/         (StorageStack, self-logging)
 *  - Athena results  -> logs/athena_logs/ (AnalyticsStack, later)
 *
 * CloudWatch-only logs (native destination, cannot go to S3):
 *  - Lambda functions        (ComputeStack)
 *  - API Gateway access logs (ComputeStack)
 */
export class BlogObservability extends Construct {
  constructor(scope: Construct, id: string, props: BlogObservabilityProps) {
    super(scope, id);

    const { monitoring, vpc, logBucket } = props;

    // VPC Flow Logs -> S3 bucket under logs/vpc_flow/. Created as a standalone
    // FlowLog in THIS construct's scope (rather than vpc.addFlowLog, which would
    // attach the resource to the VPC's own stack) so the logging module owns it.
    new ec2.FlowLog(this, 'FlowLogToS3', {
      resourceType: ec2.FlowLogResourceType.fromVpc(vpc),
      destination: ec2.FlowLogDestination.toS3(logBucket, STORAGE_PREFIXES.vpcFlowLogs),
      trafficType: TRAFFIC_TYPE[monitoring.flowLogTrafficType],
    });
  }
}
