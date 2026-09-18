import { Stack } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { BaseStackProps } from './stack-props.js';

/**
 * StorageStack — S3 buckets for the blog platform.
 *
 * Responsibility: object storage. Typically a content/assets bucket served via
 * CloudFront, plus an analytics/data-lake bucket that Athena queries and that
 * receives access/query logs.
 *
 * TODO (flesh out later):
 *  - Content bucket (private, OAC-accessed by CloudFront, versioned)
 *  - Data-lake bucket for analytics + an Athena query-results bucket
 *  - Access logging, lifecycle rules, SSE-KMS, TLS-only bucket policy
 *  - Respect config.retainData for removalPolicy / autoDeleteObjects
 */
export class StorageStack extends Stack {
  // public readonly contentBucket: s3.IBucket;
  // public readonly dataLakeBucket: s3.IBucket;

  constructor(scope: Construct, id: string, props: BaseStackProps) {
    super(scope, id, props);

    // Placeholder — S3 buckets will be added here.
    void props.config;
  }
}
