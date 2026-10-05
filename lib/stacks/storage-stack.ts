/*
 * Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { CfnOutput, Stack } from 'aws-cdk-lib';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import { NagSuppressions } from 'cdk-nag';
import type { Construct } from 'constructs';
import { ContentStorage } from '../constructs/content-storage.js';
import { STORAGE_PREFIXES } from '../config/index.js';
import type { BaseStackProps } from './stack-props.js';

/** Props for {@link StorageStack}. */
export interface StorageStackProps extends BaseStackProps {
  /**
   * Absolute path to the repo's `assets/` directory. When set, its
   * web_application/, code/, and db/ subdirectories are uploaded into the
   * bucket at deploy time.
   */
  readonly assetsDir?: string;
  /**
   * CloudFront distribution id (via context, like the promoter's). When set,
   * the SPA upload auto-invalidates the edge cache so content changes are
   * served immediately. Absent on the first deploy (EdgeStack doesn't exist
   * yet); supply it later with `-c distributionId=...`.
   */
  readonly distributionId?: string;
}

/**
 * StorageStack — the single S3 bucket for the GEO / hotel-booking platform.
 *
 * Owns one bucket with web_application/, code/, logs/ and staging/ prefixes via
 * the {@link ContentStorage} construct, and uploads source assets into it.
 * Consumed by EdgeStack (CloudFront origin + access logs), AnalyticsStack
 * (Athena results), and ComputeStack (code + DB schema).
 */
export class StorageStack extends Stack {
  private readonly contentStorage: ContentStorage;

  /** Object-key prefixes within the bucket. */
  public readonly prefixes = STORAGE_PREFIXES;

  constructor(scope: Construct, id: string, props: StorageStackProps) {
    super(scope, id, props);

    const { config, assetsDir, distributionId } = props;

    this.contentStorage = new ContentStorage(this, 'Storage', {
      prefix: config.prefix,
      storage: config.storage,
      retainData: config.retainData,
      assetsDir,
      distributionId,
    });

    new CfnOutput(this, 'BucketName', {
      value: this.contentStorage.bucket.bucketName,
      description: 'Name of the content storage bucket',
      exportName: `${config.prefix}-bucket-name`,
    });

    new CfnOutput(this, 'BucketArn', {
      value: this.contentStorage.bucket.bucketArn,
      description: 'ARN of the content storage bucket',
      exportName: `${config.prefix}-bucket-arn`,
    });

    // The BucketDeployment used to upload assets is a CDK-managed construct: it
    // provisions an AWS-owned Lambda whose runtime, execution role, and S3
    // permissions we do not control. These findings are inherent to that
    // construct and only apply when assets are actually deployed.
    if (assetsDir) {
      NagSuppressions.addStackSuppressions(
        this,
        [
          {
            id: 'AwsSolutions-L1',
            reason: 'Runtime of the CDK-managed BucketDeployment Lambda is controlled by CDK.',
          },
          {
            id: 'AwsSolutions-IAM4',
            reason:
              'The CDK-managed BucketDeployment Lambda uses the AWS-managed ' +
              'AWSLambdaBasicExecutionRole for CloudWatch Logs access.',
            appliesTo: [
              'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
            ],
          },
          {
            id: 'AwsSolutions-IAM5',
            reason:
              'The CDK-managed BucketDeployment Lambda needs wildcard S3 access ' +
              'to read the staged asset bucket and write objects to the ' +
              'destination bucket (scope limited to those buckets), plus ' +
              'cloudfront:CreateInvalidation when a distribution id is supplied ' +
              '(CloudFront does not support resource-level ARNs for invalidation) ' +
              'to flush the SPA edge cache after an upload.',
          },
        ],
        true,
      );
    }
  }

  /** The single storage bucket (for Edge/Analytics/Compute stacks). */
  public get bucket(): s3.IBucket {
    return this.contentStorage.bucket;
  }
}
