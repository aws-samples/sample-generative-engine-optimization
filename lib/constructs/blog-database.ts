import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CustomResource, Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import type * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { STORAGE_PREFIXES, type DatabaseConfig } from '../config/index.js';

/** Master username for the Aurora cluster (password is auto-generated). */
const MASTER_USERNAME = 'blogadmin';

/** S3 key of the schema+data SQL script (uploaded by the StorageStack). */
const SQL_KEY = `${STORAGE_PREFIXES.code}db/geo_demo_full.sql`;

/** Repo path of the SQL script, used to hash it so the loader re-runs on change. */
const SQL_ASSET_PATH = path.resolve(process.cwd(), 'assets', 'db', 'geo_demo_full.sql');

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
   * The content bucket holding the SQL script under `code/db/`. When provided,
   * a schema-loader custom resource applies the script to the cluster on deploy.
   */
  readonly contentBucket?: s3.IBucket;
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

    const { prefix, database, databasePort, vpc, lambdaSecurityGroup, contentBucket, retainData } =
      props;

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
      // RDS Data API: lets the Lambda tier query Aurora over HTTP (no socket),
      // via the rds-data VPC interface endpoint.
      enableDataApi: true,
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

    // --- Schema + data loader ----------------------------------------------
    // A custom resource that applies assets/db/geo_demo_full.sql to the cluster
    // via the RDS Data API once the cluster exists. Runs on Create/Update and
    // re-runs whenever the SQL content changes (the script is re-runnable).
    if (contentBucket) {
      this.createSchemaLoader(prefix, database.dbName, contentBucket);
    }
  }

  /**
   * Provision the schema-loader Lambda + custom resource. The Lambda reads the
   * SQL from S3 and executes it via the Data API inside a transaction. It is
   * NOT VPC-attached: the Data API and S3 are reachable over public AWS
   * endpoints, and the loader needs no in-VPC access.
   */
  private createSchemaLoader(prefix: string, dbName: string, contentBucket: s3.IBucket): void {
    const loaderFn = new lambda.Function(this, 'SchemaLoaderFn', {
      functionName: `${prefix}-db-loader`,
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'lambda_function.lambda_handler',
      code: lambda.Code.fromAsset(path.resolve(process.cwd(), 'assets', 'code', 'db-loader')),
      // The full script is ~8k statements applied sequentially over the Data
      // API, so allow generous time and memory.
      timeout: Duration.minutes(15),
      memorySize: 512,
      environment: {
        DB_CLUSTER_ARN: this.cluster.clusterArn,
        DB_SECRET_ARN: this.secret.secretArn,
        DB_NAME: dbName,
        CONTENT_BUCKET: contentBucket.bucketName,
        SQL_KEY: SQL_KEY,
      },
    });

    // Data API on the cluster + read the DB secret + read the SQL object.
    loaderFn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'RdsDataApiLoad',
        actions: [
          'rds-data:BeginTransaction',
          'rds-data:CommitTransaction',
          'rds-data:RollbackTransaction',
          'rds-data:ExecuteStatement',
          'rds-data:BatchExecuteStatement',
        ],
        resources: [this.cluster.clusterArn],
      }),
    );
    this.secret.grantRead(loaderFn);
    contentBucket.grantRead(loaderFn, `${STORAGE_PREFIXES.code}db/*`);

    const provider = new cr.Provider(this, 'SchemaLoaderProvider', {
      onEventHandler: loaderFn,
      logRetention: logs.RetentionDays.ONE_MONTH,
    });

    // Hash the SQL so the custom resource re-runs when the script changes.
    const sqlHash = fs.existsSync(SQL_ASSET_PATH)
      ? crypto.createHash('sha256').update(fs.readFileSync(SQL_ASSET_PATH)).digest('hex')
      : 'no-sql-asset';

    const loader = new CustomResource(this, 'SchemaLoader', {
      serviceToken: provider.serviceToken,
      resourceType: 'Custom::GeoDbSchemaLoader',
      properties: { SqlKey: SQL_KEY, SqlHash: sqlHash },
    });

    // Ensure the cluster (and its writer instance) is ready before loading.
    loader.node.addDependency(this.cluster);
  }
}
