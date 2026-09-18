import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import type * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import type { DatabaseConfig } from '../config/index.js';

/** Master username for the Aurora cluster (password is auto-generated). */
const MASTER_USERNAME = 'blogadmin';

/** Props for {@link BlogDatabase}. */
export interface BlogDatabaseProps {
  /** Resource-name prefix (e.g. `geo-blog-dev`). */
  readonly prefix: string;
  /** Database settings resolved from the environment config. */
  readonly database: DatabaseConfig;
  /** Port the cluster listens on (from the network config). */
  readonly databasePort: number;
  /** The VPC to place the cluster in (from the network layer). */
  readonly vpc: ec2.IVpc;
  /**
   * The Lambda tier's security group (from the network layer). The cluster's
   * own security group is created here and allows ingress only from this SG.
   */
  readonly lambdaSecurityGroup: ec2.ISecurityGroup;
  /**
   * When true, the cluster is retained/protected on stack deletion; when false
   * it is destroyed for clean teardown (dev default).
   */
  readonly retainData: boolean;
}

/**
 * BlogDatabase — Aurora PostgreSQL Serverless v2 cluster for the blog.
 *
 *  - Runs in the VPC's isolated subnets (no internet route).
 *  - Reachable only via the provided security group (ingress from Lambda).
 *  - Master credentials are generated and stored in Secrets Manager.
 *  - Serverless v2 writer (+ optional readers), ACU range from config.
 *  - Optional RDS Proxy (connection pooling) and secret rotation, config-gated.
 *  - Removal policy and deletion protection driven by `retainData`.
 */
export class BlogDatabase extends Construct {
  /** The Aurora cluster. */
  public readonly cluster: rds.DatabaseCluster;
  /** The generated master-credentials secret. */
  public readonly secret: secretsmanager.ISecret;
  /** The cluster's security group (ingress from the Lambda tier only). */
  public readonly securityGroup: ec2.SecurityGroup;
  /** The RDS Proxy, when `enableProxy` is set; otherwise undefined. */
  public readonly proxy?: rds.DatabaseProxy;

  constructor(scope: Construct, id: string, props: BlogDatabaseProps) {
    super(scope, id);

    const { prefix, database, databasePort, vpc, lambdaSecurityGroup, retainData } = props;

    const removalPolicy = retainData ? RemovalPolicy.SNAPSHOT : RemovalPolicy.DESTROY;

    // The database security group is owned here (same stack as the cluster) to
    // avoid a cross-stack dependency cycle; ingress is limited to the Lambda
    // tier's security group on the database port.
    this.securityGroup = new ec2.SecurityGroup(this, 'Sg', {
      vpc,
      securityGroupName: `${prefix}-database-sg`,
      description: 'Aurora PostgreSQL; inbound from Lambda only.',
      allowAllOutbound: false,
    });
    this.securityGroup.addIngressRule(
      lambdaSecurityGroup,
      ec2.Port.tcp(databasePort),
      'Allow PostgreSQL from the Lambda API',
    );

    // Aurora PostgreSQL engine, version pinned from config (never "latest").
    const [major] = database.engineVersion.split('.');
    const engine = rds.DatabaseClusterEngine.auroraPostgres({
      version: rds.AuroraPostgresEngineVersion.of(database.engineVersion, major),
    });

    // Serverless v2 instances share the cluster-level ACU range below.
    const writer = rds.ClusterInstance.serverlessV2('Writer', {
      instanceIdentifier: `${prefix}-writer`,
      // Writer should not be publicly accessible; it lives in isolated subnets.
      publiclyAccessible: false,
    });

    const readers = Array.from({ length: database.readers }, (_, i) =>
      rds.ClusterInstance.serverlessV2(`Reader${i + 1}`, {
        instanceIdentifier: `${prefix}-reader-${i + 1}`,
        // Scale readers with load so idle readers don't cost full capacity.
        scaleWithWriter: true,
        publiclyAccessible: false,
      }),
    );

    this.cluster = new rds.DatabaseCluster(this, 'Cluster', {
      clusterIdentifier: `${prefix}-aurora`,
      engine,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [this.securityGroup],
      port: databasePort,
      defaultDatabaseName: database.dbName,
      // Generate + store master credentials in Secrets Manager.
      credentials: rds.Credentials.fromGeneratedSecret(MASTER_USERNAME, {
        secretName: `${prefix}/aurora/credentials`,
      }),
      writer,
      readers,
      serverlessV2MinCapacity: database.minAcu,
      serverlessV2MaxCapacity: database.maxAcu,
      storageEncrypted: true,
      iamAuthentication: true,
      deletionProtection: retainData,
      removalPolicy,
    });

    // The cluster always has a secret when using generated credentials.
    this.secret = this.cluster.secret!;

    // Optional secret rotation (Secrets Manager runs a managed rotation Lambda
    // in the VPC). Gated because it adds cost + a scheduled function.
    if (database.enableRotation) {
      this.cluster.addRotationSingleUser({
        automaticallyAfter: Duration.days(30),
      });
    }

    // Optional RDS Proxy for Lambda connection pooling. Gated because it is an
    // always-on hourly cost that only pays off under real connection churn.
    if (database.enableProxy) {
      this.proxy = this.cluster.addProxy('Proxy', {
        dbProxyName: `${prefix}-proxy`,
        secrets: [this.secret],
        vpc,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
        securityGroups: [this.securityGroup],
        requireTLS: true,
      });
    }
  }
}
