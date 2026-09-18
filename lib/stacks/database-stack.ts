import { Stack } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { BaseStackProps } from './stack-props.js';

/**
 * DatabaseStack — Aurora database for the blog platform.
 *
 * Responsibility: the relational store for posts, comments, and metadata.
 * Aurora Serverless v2 is a good default for spiky blog traffic.
 *
 * TODO (flesh out later):
 *  - Aurora (PostgreSQL/MySQL) cluster, Serverless v2 scaling config
 *  - Credentials in Secrets Manager with rotation
 *  - Deploy into NetworkStack's isolated subnets; SG ingress from Lambda only
 *  - Optional RDS Proxy for Lambda connection pooling
 *  - Respect config.retainData for removal / deletion protection / snapshots
 *
 * Depends on: NetworkStack (VPC + security groups).
 */
export interface DatabaseStackProps extends BaseStackProps {
  // readonly vpc: ec2.IVpc;
}

export class DatabaseStack extends Stack {
  // public readonly cluster: rds.IDatabaseCluster;
  // public readonly secret: secretsmanager.ISecret;

  constructor(scope: Construct, id: string, props: DatabaseStackProps) {
    super(scope, id, props);

    // Placeholder — Aurora cluster will be added here.
    void props.config;
  }
}
