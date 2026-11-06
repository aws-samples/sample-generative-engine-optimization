/*
 * Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT-0
 */

import { App, Stack } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { getConfig, type AppConfig } from '../../lib/config/index.js';
import { NetworkStack, StorageStack } from '../../lib/stacks/index.js';
import { BlogDatabase } from '../../lib/constructs/blog-database.js';
import { TEST_ENV } from './helpers.js';

/**
 * The DatabaseStack test already covers engine/encryption/IAM-auth, Serverless
 * v2 ACU, writer/readers, the secret, proxy/rotation gating, the removal policy
 * by retainData, and the schema loader + its IAM. This construct test targets
 * what that stack test does NOT: the network-isolation security group (the
 * construct's "reachable only from the Lambda tier, no open egress" claim) and
 * the no-bucket -> no-loader branch.
 */
function build(opts: { withBucket?: boolean; retainData?: boolean } = {}): Template {
  const app = new App();
  const config: AppConfig = { ...getConfig(app), env: TEST_ENV };
  const network = new NetworkStack(app, 'test-network', { env: config.env, config });
  const storage = new StorageStack(app, 'test-storage', { env: config.env, config });
  const host = new Stack(app, 'test-db-host', { env: config.env });
  new BlogDatabase(host, 'Database', {
    prefix: 'geo-demo-dev',
    database: config.database,
    databasePort: config.network.databasePort,
    vpc: network.vpc,
    lambdaSecurityGroup: network.lambdaSecurityGroup,
    contentBucket: opts.withBucket ? storage.bucket : undefined,
    retainData: opts.retainData ?? false,
  });
  return Template.fromStack(host);
}

describe('BlogDatabase network isolation', () => {
  const template = build({ withBucket: true });

  it('creates a dedicated database security group with NO open egress', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupName: 'geo-demo-dev-database-sg',
      SecurityGroupEgress: Match.arrayWith([
        Match.objectLike({ CidrIp: '255.255.255.255/32', Description: 'Disallow all traffic' }),
      ]),
    });
    const sgs = template.findResources('AWS::EC2::SecurityGroup');
    const dbSg = Object.values(sgs).find(
      (s) => s.Properties?.GroupName === 'geo-demo-dev-database-sg',
    );
    expect(JSON.stringify(dbSg?.Properties.SecurityGroupEgress)).not.toContain('0.0.0.0/0');
  });

  it('allows ingress ONLY from the Lambda SG on the Postgres port (5432)', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      IpProtocol: 'tcp',
      FromPort: 5432,
      ToPort: 5432,
      Description: 'Allow PostgreSQL from the Lambda API',
      SourceSecurityGroupId: Match.anyValue(),
    });
    const ingress = template.findResources('AWS::EC2::SecurityGroupIngress');
    expect(Object.keys(ingress)).toHaveLength(1);
    for (const rule of Object.values(ingress)) {
      expect(rule.Properties.CidrIp).toBeUndefined();
    }
  });

  it('attaches that security group to the cluster', () => {
    const clusters = template.findResources('AWS::RDS::DBCluster');
    const cluster = Object.values(clusters)[0];
    expect(JSON.stringify(cluster.Properties.VpcSecurityGroupIds)).toContain('DatabaseSg');
  });

  it('places the cluster in isolated subnets via a DB subnet group', () => {
    template.resourceCountIs('AWS::RDS::DBSubnetGroup', 1);
  });
});

describe('BlogDatabase without a content bucket', () => {
  const template = build({ withBucket: false });

  it('still builds the cluster but provisions NO schema loader', () => {
    template.resourceCountIs('AWS::RDS::DBCluster', 1);
    template.resourceCountIs('Custom::GeoDbSchemaLoader', 0);
    const fns = template.findResources('AWS::Lambda::Function');
    const loader = Object.values(fns).find(
      (f) => f.Properties?.FunctionName === 'geo-demo-dev-db-loader',
    );
    expect(loader).toBeUndefined();
  });
});
