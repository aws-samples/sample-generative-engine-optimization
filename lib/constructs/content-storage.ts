/*
 * Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { Aws, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';
import { STORAGE_PREFIXES, type StorageConfig } from '../config/index.js';

/** Props for {@link ContentStorage}. */
export interface ContentStorageProps {
  /** Resource-name prefix (e.g. `geo-demo-dev`). */
  readonly prefix: string;
  /** Storage settings resolved from the environment config. */
  readonly storage: StorageConfig;
  /**
   * When true, the bucket is retained on stack deletion; when false it is
   * destroyed and emptied for clean teardown (dev default).
   */
  readonly retainData: boolean;
  /**
   * Absolute path to the repo's `assets/` directory holding the source content
   * to upload (web_application/, code/, db/). When provided and the
   * subdirectories exist, CDK uploads them into the bucket at deploy time.
   */
  readonly assetsDir?: string;
  /**
   * CloudFront distribution id (supplied via context, like the promoter's).
   * When set, the web_application upload auto-invalidates the SPA paths at the
   * edge so content changes are served immediately — no manual invalidation.
   * Absent on the first deploy (EdgeStack doesn't exist yet); pass it on a
   * later deploy with `-c distributionId=...` to enable auto-invalidation.
   */
  readonly distributionId?: string;
}

/**
 * ContentStorage — the single S3 bucket for the GEO / hotel-booking platform.
 *
 * One bucket with these top-level prefixes:
 *  - web_application/  : single-page app + served files (CloudFront OAC origin)
 *  - code/             : Lambda code, OpenAPI import spec, DB DDL/seed (NOT served)
 *  - logs/             : cf_logs/ (CloudFront) + athena_logs/ (query results) + s3/
 *  - staging/          : feedback-loop area (agent corrections awaiting review)
 *
 * Secure defaults: all public access blocked, S3-managed encryption, TLS-only
 * bucket policy, versioning, and S3 server access logging to logs/s3/. Bucket
 * ACLs are enabled (BUCKET_OWNER_PREFERRED) so CloudFront native logging can
 * deliver to logs/cf_logs/. Lifecycle rules are scoped per prefix, and the
 * removal policy + object auto-delete are driven by `retainData`.
 *
 * When `assetsDir` is supplied, the construct uploads:
 *  - <assetsDir>/web_application -> web_application/
 *  - <assetsDir>/code            -> code/
 *  - <assetsDir>/db              -> code/db/   (DDL + seed live under code/)
 */
export class ContentStorage extends Construct {
  /** The single storage bucket. */
  public readonly bucket: s3.Bucket;

  /** Object-key prefixes within {@link bucket}. */
  public readonly prefixes = STORAGE_PREFIXES;

  constructor(scope: Construct, id: string, props: ContentStorageProps) {
    super(scope, id);

    const { prefix, storage, retainData, assetsDir, distributionId } = props;
    const { account, region } = Stack.of(this);

    this.bucket = new s3.Bucket(this, 'Bucket', {
      // Deterministic, globally-unique name: account + region disambiguate.
      bucketName: `${prefix}-content-${account}-${region}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      // ACLs enabled so CloudFront native logging can write to logs/cf_logs/.
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
      removalPolicy: retainData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      autoDeleteObjects: !retainData,
      // S3 server access logs delivered to this same bucket under logs/s3/.
      // (A bucket may log to itself in a distinct prefix.)
      serverAccessLogsPrefix: STORAGE_PREFIXES.s3AccessLogs,
      lifecycleRules: [
        // Expire all logs after the retention window.
        {
          id: 'expire-logs',
          prefix: STORAGE_PREFIXES.logs,
          expiration: Duration.days(storage.logRetentionDays),
        },
        // Expire Athena query results sooner (they are regenerable).
        {
          id: 'expire-athena-results',
          prefix: STORAGE_PREFIXES.athenaResults,
          expiration: Duration.days(storage.queryResultRetentionDays),
        },
        // Transition served web content to Infrequent Access to control cost.
        {
          id: 'web-application-ia-transition',
          prefix: STORAGE_PREFIXES.webApplication,
          transitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: Duration.days(storage.contentIaTransitionDays),
            },
          ],
        },
        // Clean up old versions and aborted multipart uploads bucket-wide.
        {
          id: 'expire-noncurrent-versions',
          noncurrentVersionExpiration: Duration.days(storage.noncurrentVersionRetentionDays),
          abortIncompleteMultipartUploadAfter: Duration.days(7),
        },
      ],
    });

    // --- CloudFront OAC read access ----------------------------------------
    // The EdgeStack imports this bucket read-only (to avoid a Storage<->Edge
    // dependency cycle), so `withOriginAccessControl` cannot write this policy
    // for us. We add it here, in the stack that owns the bucket. The SourceArn
    // is wildcarded to any distribution in this account to avoid referencing the
    // EdgeStack (which would recreate the cycle); CloudFront still only reads via
    // its own OAC-signed requests.
    this.bucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowCloudFrontOacRead',
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
        actions: ['s3:GetObject'],
        resources: [this.bucket.arnForObjects(`${STORAGE_PREFIXES.webApplication}*`)],
        conditions: {
          StringEquals: {
            'AWS:SourceAccount': Aws.ACCOUNT_ID,
          },
          ArnLike: {
            'AWS:SourceArn': `arn:${Aws.PARTITION}:cloudfront::${Aws.ACCOUNT_ID}:distribution/*`,
          },
        },
      }),
    );

    // --- Upload source assets (content, code, DB schema) -------------------
    if (assetsDir) {
      // The SPA upload auto-invalidates the edge cache when a distribution id
      // is available (passed via context, like the promoter's). This is the
      // served content, so stale edge copies would otherwise linger after a
      // redeploy. Other prefixes (code/, db/, logs/, staging/) are never served
      // through CloudFront, so they need no invalidation.
      const webAppDistribution = distributionId
        ? cloudfront.Distribution.fromDistributionAttributes(this, 'EdgeDistribution', {
            distributionId,
            // domainName is required by the import API but unused for invalidation.
            domainName: `${distributionId}.cloudfront.net`,
          })
        : undefined;
      this.deployAsset(
        'WebAppDeployment',
        assetsDir,
        'web_application',
        STORAGE_PREFIXES.webApplication,
        webAppDistribution,
      );
      this.deployAsset('CodeDeployment', assetsDir, 'code', STORAGE_PREFIXES.code);
      // DDL + seed schema live under code/db/ so Lambdas/loaders can fetch them.
      this.deployAsset('DbSchemaDeployment', assetsDir, 'db', `${STORAGE_PREFIXES.code}db/`);
      // Seed the staging/ prefix with a .keep marker so it exists before the
      // patch-applier/promoter Lambdas write to it. (S3 has no real folders;
      // this guarantees the base prefix is present.)
      this.deployAsset('StagingDeployment', assetsDir, 'staging', STORAGE_PREFIXES.staging);
      // Sample CloudFront access logs (.gz) uploaded to logs/cf_logs/ so Athena
      // has data to query. Uploaded as-is (no content-encoding transform).
      this.deployAsset('CfLogsDeployment', assetsDir, 'logs/cf_logs', STORAGE_PREFIXES.cloudFrontLogs);
    }
  }

  /**
   * Deploy one asset subdirectory into the bucket under a destination prefix,
   * but only if the source directory actually exists (so partially-populated
   * asset trees don't break synth).
   *
   * When `distribution` is provided, the upload also invalidates the served
   * SPA paths (`/*`) at the CloudFront edge so content changes appear
   * immediately after a deploy.
   */
  private deployAsset(
    id: string,
    assetsDir: string,
    subDir: string,
    destPrefix: string,
    distribution?: cloudfront.IDistribution,
  ): void {
    const sourcePath = path.join(assetsDir, subDir);
    if (!fs.existsSync(sourcePath)) return;

    new s3deploy.BucketDeployment(this, id, {
      sources: [s3deploy.Source.asset(sourcePath)],
      destinationBucket: this.bucket,
      destinationKeyPrefix: destPrefix,
      // Only manage keys under this prefix; never wipe sibling prefixes.
      prune: false,
      retainOnDelete: false,
      // Served content only: invalidate all public SPA paths when a
      // distribution is supplied (origin path /web_application maps to `/*`).
      ...(distribution ? { distribution, distributionPaths: ['/*'] } : {}),
    });
  }

  /** Full `s3://` URI for a given prefix within the bucket. */
  public s3UriFor(prefix: string): string {
    return `s3://${this.bucket.bucketName}/${prefix}`;
  }
}
