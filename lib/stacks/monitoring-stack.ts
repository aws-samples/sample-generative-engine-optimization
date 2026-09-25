import { Stack } from 'aws-cdk-lib';
import type * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';
import { BlogObservability } from '../constructs/blog-observability.js';
import type { BaseStackProps } from './stack-props.js';

/** Props for {@link MonitoringStack}. */
export interface MonitoringStackProps extends BaseStackProps {
  /** The VPC to capture flow logs for (from the NetworkStack). */
  readonly vpc: ec2.IVpc;
  /**
   * Name of the log/content bucket (from the StorageStack). Imported read-only
   * so the flow-log bucket policy is not written back into the StorageStack.
   */
  readonly logBucketName: string;
}

/**
 * MonitoringStack — the logging / observability module for the GEO platform.
 *
 * Prototype scope: route S3-capable log sources into the shared content bucket.
 * Currently configures VPC Flow Logs -> S3 (`logs/vpc_flow/`) via the
 * {@link BlogObservability} construct. Dashboards and alarms can be added here
 * later; Lambda and API Gateway logs remain on CloudWatch (their only
 * supported destination).
 */
export class MonitoringStack extends Stack {
  constructor(scope: Construct, id: string, props: MonitoringStackProps) {
    super(scope, id, props);

    const { config, vpc, logBucketName } = props;

    const logBucket = s3.Bucket.fromBucketName(this, 'LogBucket', logBucketName);

    new BlogObservability(this, 'Observability', {
      prefix: config.prefix,
      monitoring: config.monitoring,
      vpc,
      logBucket,
    });
  }
}
