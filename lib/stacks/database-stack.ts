/*
 * Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { CfnOutput, Stack } from 'aws-cdk-lib';
import type * as ec2 from 'aws-cdk-lib/aws-ec2';
import type * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { NagSuppressions } from 'cdk-nag';
import type { Construct } from 'constructs';
import { BlogDatabase } from '../constructs/blog-database.js';
import type { BaseStackProps } from './stack-props.js';

/**
 * Props for {@link DatabaseStack}. Consumes network references (option A:
 * cross-stack references passed in `bin/app.ts`).
 */
export interface DatabaseStackProps extends BaseStackProps {
  /** The VPC from the NetworkStack. */
  readonly vpc: ec2.IVpc;
  /** The Lambda tier's security group from the NetworkStack (source of DB ingress). */
  readonly lambdaSecurityGroup: ec2.ISecurityGroup;
  /**
   * Name of the content bucket (from the StorageStack) holding the SQL script.
   * Imported read-only so the schema-loader's S3 read grant does not write a
   * back-reference policy into the StorageStack.
   */
  readonly contentBucketName: string;
}

/**
 * DatabaseStack — Aurora PostgreSQL Serverless v2 for the blog platform.
 *
 * Owns the cluster and its Secrets Manager credentials via the
 * {@link BlogDatabase} construct. The cluster runs in the network's isolated
 * subnets and is reachable only from the Lambda tier.
 */
export class DatabaseStack extends Stack {
  private readonly blogDatabase: BlogDatabase;

  constructor(scope: Construct, id: string, props: DatabaseStackProps) {
    super(scope, id, props);

    const { config, vpc, lambdaSecurityGroup, contentBucketName } = props;

    const contentBucket = s3.Bucket.fromBucketName(this, 'ContentBucket', contentBucketName);

    this.blogDatabase = new BlogDatabase(this, 'Database', {
      prefix: config.prefix,
      database: config.database,
      databasePort: config.network.databasePort,
      vpc,
      lambdaSecurityGroup,
      contentBucket,
      retainData: config.retainData,
    });

    new CfnOutput(this, 'ClusterEndpoint', {
      value: this.blogDatabase.cluster.clusterEndpoint.hostname,
      description: 'Aurora cluster writer endpoint hostname',
      exportName: `${config.prefix}-db-endpoint`,
    });

    new CfnOutput(this, 'SecretArn', {
      value: this.blogDatabase.secret.secretArn,
      description: 'ARN of the Aurora master-credentials secret',
      exportName: `${config.prefix}-db-secret-arn`,
    });

    new CfnOutput(this, 'ClusterArn', {
      value: this.blogDatabase.cluster.clusterArn,
      description: 'ARN of the Aurora cluster (for the RDS Data API)',
      exportName: `${config.prefix}-db-cluster-arn`,
    });

    // cdk-nag: the master secret uses a generated password without rotation by
    // default (rotation is config-gated). Acknowledge for dev; enable rotation
    // (`-c enableRotation=true`) or suppress with a documented reason in prod.
    if (!config.database.enableRotation) {
      NagSuppressions.addStackSuppressions(this, [
        {
          id: 'AwsSolutions-SMG4',
          reason:
            'Secret rotation is intentionally config-gated (off by default for ' +
            'dev). Enable with `-c enableRotation=true` for production.',
        },
      ]);
    }

    // Deletion protection is intentionally tied to `retainData` so dev can be
    // torn down cleanly with `cdk destroy`. When retainData is true (prod-like)
    // the cluster sets DeletionProtection + a SNAPSHOT removal policy and this
    // suppression does not apply.
    if (!config.retainData) {
      NagSuppressions.addStackSuppressions(this, [
        {
          id: 'AwsSolutions-RDS10',
          reason:
            'Deletion protection is intentionally disabled for the dev ' +
            'environment (retainData=false) to allow clean teardown. It is ' +
            'enabled automatically when retainData=true.',
        },
      ]);
    }

    // The schema-loader (db-loader Lambda + its CDK-managed custom-resource
    // Provider) is a deploy-time helper. Its findings are inherent to the
    // pattern: pinned runtime, managed exec role, and the scoped/CDK-managed
    // wildcard permissions of the Provider framework and the S3 read grant.
    NagSuppressions.addStackSuppressions(
      this,
      [
        {
          id: 'AwsSolutions-L1',
          reason:
            'The schema-loader runtime is pinned to python3.13 (current latest) ' +
            'to match the application Lambdas; the CDK Provider Lambda runtime is ' +
            'controlled by CDK.',
        },
        {
          id: 'AwsSolutions-IAM4',
          reason:
            'The db-loader and CDK Provider Lambdas use the AWS-managed ' +
            'AWSLambdaBasicExecutionRole for CloudWatch Logs.',
          appliesTo: [
            'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
          ],
        },
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'Scoped/inherent wildcards for the schema loader: the CDK Provider ' +
            'framework grants lambda:InvokeFunction on its own onEvent handler, ' +
            'and the S3 read grant expands to GetObject*/GetBucket*/List* scoped ' +
            'to the code/db/* prefix of the content bucket.',
        },
      ],
      true,
    );
  }

  /** The Aurora cluster (for ComputeStack to grant access + read endpoints). */
  public get cluster(): rds.IDatabaseCluster {
    return this.blogDatabase.cluster;
  }

  /** The master-credentials secret (for ComputeStack to grant read). */
  public get secret(): secretsmanager.ISecret {
    return this.blogDatabase.secret;
  }

  /** The Aurora cluster ARN (for the RDS Data API in ComputeStack). */
  public get clusterArn(): string {
    return this.blogDatabase.cluster.clusterArn;
  }
}
