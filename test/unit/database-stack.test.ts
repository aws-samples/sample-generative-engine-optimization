import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { getConfig, type AppConfig } from '../../lib/config/index.js';
import { NetworkStack, StorageStack, DatabaseStack } from '../../lib/stacks/index.js';
import { TEST_ENV } from './helpers.js';

/**
 * Build a DatabaseStack sourcing its VPC + SG from a real NetworkStack and its
 * content bucket name from a StorageStack in the same app, mirroring how
 * bin/app.ts wires them (option A).
 */
function synth(context: Record<string, unknown> = {}): Template {
  const app = new App({ context });
  const config: AppConfig = { ...getConfig(app), env: TEST_ENV };
  const network = new NetworkStack(app, 'test-network', { env: config.env, config });
  const storage = new StorageStack(app, 'test-storage', { env: config.env, config });
  const database = new DatabaseStack(app, 'test-database', {
    env: config.env,
    config,
    vpc: network.vpc,
    lambdaSecurityGroup: network.lambdaSecurityGroup,
    contentBucketName: storage.bucket.bucketName,
  });
  return Template.fromStack(database);
}

describe('DatabaseStack (Aurora)', () => {
  const template = synth();

  it('creates a single Aurora PostgreSQL cluster', () => {
    template.resourceCountIs('AWS::RDS::DBCluster', 1);
    template.hasResourceProperties('AWS::RDS::DBCluster', {
      Engine: 'aurora-postgresql',
      DatabaseName: 'geo_db',
    });
  });

  it('configures Serverless v2 capacity (0.5–2 ACU by default)', () => {
    template.hasResourceProperties('AWS::RDS::DBCluster', {
      ServerlessV2ScalingConfiguration: {
        MinCapacity: 0.5,
        MaxCapacity: 2,
      },
    });
  });

  it('provisions a writer instance and no readers by default', () => {
    template.resourceCountIs('AWS::RDS::DBInstance', 1);
    template.hasResourceProperties('AWS::RDS::DBInstance', {
      DBInstanceClass: 'db.serverless',
    });
  });

  it('encrypts storage and enables IAM auth', () => {
    template.hasResourceProperties('AWS::RDS::DBCluster', {
      StorageEncrypted: true,
      EnableIAMDatabaseAuthentication: true,
    });
  });

  it('generates a master-credentials secret', () => {
    template.resourceCountIs('AWS::SecretsManager::Secret', 1);
  });

  it('places the cluster in a DB subnet group (isolated subnets)', () => {
    template.resourceCountIs('AWS::RDS::DBSubnetGroup', 1);
  });

  it('does not create an RDS Proxy by default', () => {
    template.resourceCountIs('AWS::RDS::DBProxy', 0);
  });

  it('does not create a rotation schedule by default', () => {
    template.resourceCountIs('AWS::SecretsManager::RotationSchedule', 0);
  });

  it('destroys the cluster on deletion when retainData is false (dev default)', () => {
    template.hasResource('AWS::RDS::DBCluster', {
      DeletionPolicy: 'Delete',
      Properties: Match.objectLike({ DeletionProtection: false }),
    });
  });

  it('exports the cluster endpoint and secret ARN', () => {
    template.hasOutput('ClusterEndpoint', {});
    template.hasOutput('SecretArn', {});
  });

  it('provisions a schema-loader Lambda (python3.13) pointed at the SQL script', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'geo-demo-dev-db-loader',
      Runtime: 'python3.13',
      Handler: 'lambda_function.lambda_handler',
      Environment: {
        Variables: Match.objectLike({
          SQL_KEY: 'code/db/geo_demo_full.sql',
          DB_NAME: 'geo_db',
        }),
      },
    });
  });

  it('grants the loader RDS Data API transaction + statement permissions', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([
              'rds-data:BeginTransaction',
              'rds-data:CommitTransaction',
              'rds-data:ExecuteStatement',
            ]),
          }),
        ]),
      },
    });
  });

  it('creates the schema-loader custom resource', () => {
    template.resourceCountIs('Custom::GeoDbSchemaLoader', 1);
  });

  it('gives the db-loader an explicit DESTROY log group (clean teardown)', () => {
    template.hasResource('AWS::Logs::LogGroup', {
      DeletionPolicy: 'Delete',
      Properties: Match.objectLike({ LogGroupName: '/aws/lambda/geo-demo-dev-db-loader' }),
    });
  });
});

describe('DatabaseStack honors context overrides', () => {
  it('adds a reader when readers=1', () => {
    // writer + 1 reader = 2 instances.
    synth({ readers: 1 }).resourceCountIs('AWS::RDS::DBInstance', 2);
  });

  it('creates an RDS Proxy when enableProxy=true', () => {
    synth({ enableProxy: true }).resourceCountIs('AWS::RDS::DBProxy', 1);
  });

  it('creates a rotation schedule when enableRotation=true', () => {
    synth({ enableRotation: true }).resourceCountIs('AWS::SecretsManager::RotationSchedule', 1);
  });

  it('applies overridden ACU capacity', () => {
    synth({ minAcu: 1, maxAcu: 8 }).hasResourceProperties('AWS::RDS::DBCluster', {
      ServerlessV2ScalingConfiguration: { MinCapacity: 1, MaxCapacity: 8 },
    });
  });

  it('retains + protects the cluster when retainData=true', () => {
    synth({ retainData: true }).hasResource('AWS::RDS::DBCluster', {
      DeletionPolicy: 'Snapshot',
      Properties: Match.objectLike({ DeletionProtection: true }),
    });
  });
});
