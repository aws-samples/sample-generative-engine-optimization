import { CfnOutput, Stack } from 'aws-cdk-lib';
import type * as ec2 from 'aws-cdk-lib/aws-ec2';
import type * as rds from 'aws-cdk-lib/aws-rds';
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

    const { config, vpc, lambdaSecurityGroup } = props;

    this.blogDatabase = new BlogDatabase(this, 'Database', {
      prefix: config.prefix,
      database: config.database,
      databasePort: config.network.databasePort,
      vpc,
      lambdaSecurityGroup,
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
  }

  /** The Aurora cluster (for ComputeStack to grant access + read endpoints). */
  public get cluster(): rds.IDatabaseCluster {
    return this.blogDatabase.cluster;
  }

  /** The master-credentials secret (for ComputeStack to grant read). */
  public get secret(): secretsmanager.ISecret {
    return this.blogDatabase.secret;
  }
}
