/*
 * Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { App, Stack } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { getConfig, type AppConfig } from '../../lib/config/index.js';
import { NetworkStack, StorageStack } from '../../lib/stacks/index.js';
import { BlogApi } from '../../lib/constructs/blog-api.js';
import { TEST_ENV } from './helpers.js';

const CLUSTER_ARN = 'arn:aws:rds:us-east-1:123456789012:cluster:test-cluster';
const SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:test-secret';

/**
 * BlogApi needs a VPC + security group (network layer) and a content bucket
 * (storage layer). We synth those two stacks, then build the construct inside a
 * dedicated host stack and assert on THAT stack's template — so the assertions
 * are about the construct's own resources, not the parent ComputeStack.
 */
function synth(opts: { distributionId?: string } = {}): Template {
  const app = new App();
  const config: AppConfig = { ...getConfig(app), env: TEST_ENV };
  const network = new NetworkStack(app, 'test-network', { env: config.env, config });
  const storage = new StorageStack(app, 'test-storage', { env: config.env, config });
  const host = new Stack(app, 'test-blogapi-host', { env: config.env });
  new BlogApi(host, 'BlogApi', {
    prefix: 'geo-demo-dev',
    compute: config.compute,
    vpc: network.vpc,
    lambdaSecurityGroup: network.lambdaSecurityGroup,
    contentBucket: storage.bucket,
    clusterArn: CLUSTER_ARN,
    dbSecretArn: SECRET_ARN,
    dbName: config.database.dbName,
    distributionId: opts.distributionId,
  });
  return Template.fromStack(host);
}

describe('BlogApi construct', () => {
  const template = synth({ distributionId: 'E2HKAT79V522DO' });

  it('creates exactly the four GEO Lambdas (python3.13, Lambda proxy backend)', () => {
    template.resourceCountIs('AWS::Lambda::Function', 4);
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'python3.13',
      Handler: 'lambda_function.lambda_handler',
    });
    for (const name of [
      'geo-demo-dev-api-handler',
      'geo-demo-dev-citation-tracker',
      'geo-demo-dev-patch-applier',
      'geo-demo-dev-promoter',
    ]) {
      template.hasResourceProperties('AWS::Lambda::Function', { FunctionName: name });
    }
  });

  it('runs every Lambda in the VPC with the one shared security group', () => {
    const fns = template.findResources('AWS::Lambda::Function');
    const vpcFns = Object.values(fns).filter((f) => f.Properties?.VpcConfig);
    expect(vpcFns).toHaveLength(4);
    for (const f of vpcFns) {
      expect(f.Properties.VpcConfig.SubnetIds).toBeDefined();
      expect(f.Properties.VpcConfig.SecurityGroupIds).toHaveLength(1);
    }
  });

  it('builds a public REGIONAL REST API with NO authorizer (public GEO entry point)', () => {
    template.resourceCountIs('AWS::ApiGateway::RestApi', 1);
    template.hasResourceProperties('AWS::ApiGateway::RestApi', {
      Name: 'geo-demo-dev-hospitality-api',
      EndpointConfiguration: { Types: ['REGIONAL'] },
    });
    template.resourceCountIs('AWS::ApiGateway::Authorizer', 0);
    const methods = template.findResources('AWS::ApiGateway::Method');
    for (const m of Object.values(methods)) {
      expect(m.Properties.AuthorizationType).toBe('NONE');
    }
  });

  it('wires the discovered route tree with operationIds for the AgentCore gateway', () => {
    template.resourceCountIs('AWS::ApiGateway::Resource', 5);
    template.resourceCountIs('AWS::ApiGateway::Method', 5);
    for (const op of [
      'searchProperties',
      'getProperty',
      'getRates',
      'getAvailability',
      'createReservation',
    ]) {
      template.hasResourceProperties('AWS::ApiGateway::Method', { OperationName: op });
    }
  });

  it('scopes the api-handler to RDS Data API + its secret only (least privilege)', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: ['rds-data:ExecuteStatement', 'rds-data:BatchExecuteStatement'],
            Resource: CLUSTER_ARN,
          }),
          Match.objectLike({
            Action: 'secretsmanager:GetSecretValue',
            Resource: SECRET_ARN,
          }),
        ]),
      },
    });
  });

  it('scopes PutMetricData to the configured namespace via condition (not a bare *)', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'cloudwatch:PutMetricData',
            Resource: '*',
            Condition: {
              StringEquals: { 'cloudwatch:namespace': config().compute.metricsNamespace },
            },
          }),
        ]),
      },
    });
  });

  it('grants the promoter a CloudFront invalidation scoped to the one distribution', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'cloudfront:CreateInvalidation',
            Resource: Match.objectLike({
              'Fn::Join': Match.arrayWith([
                Match.arrayWith([Match.stringLikeRegexp('distribution/E2HKAT79V522DO')]),
              ]),
            }),
          }),
        ]),
      },
    });
  });
});

describe('BlogApi without a distributionId', () => {
  it('omits the CloudFront invalidation grant entirely', () => {
    const template = synth();
    const json = JSON.stringify(template.findResources('AWS::IAM::Policy'));
    expect(json).not.toContain('cloudfront:CreateInvalidation');
  });
});

/**
 * Stage-only safety boundary — the blog's "automation never writes to live"
 * guarantee, enforced at the worker Lambdas' S3 IAM:
 *   - patch-applier (run by the automated loop) READS live but WRITES only to
 *     staging/ — it can never mutate web_application/.
 *   - promoter is the deliberate promotion TOOL and so DOES write both prefixes.
 */
describe('BlogApi stage-only S3 boundary', () => {
  const template = synth({ distributionId: 'E2HKAT79V522DO' });

  function s3StatementsFor(roleFragment: string): Array<Record<string, unknown>> {
    const policies = template.findResources('AWS::IAM::Policy');
    return Object.entries(policies)
      .filter(([id]) => id.includes(roleFragment))
      .flatMap(([, p]) => p.Properties?.PolicyDocument?.Statement ?? [])
      .filter((s: { Action?: string | string[] }) => {
        const a = Array.isArray(s.Action) ? s.Action : [s.Action];
        return a.some((x) => typeof x === 'string' && x.startsWith('s3:'));
      });
  }

  function grantsS3Write(stmt: Record<string, unknown>): boolean {
    const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
    return actions.some(
      (a) =>
        typeof a === 'string' && (a.startsWith('s3:PutObject') || a.startsWith('s3:DeleteObject')),
    );
  }

  it('patch-applier can READ live content but has no write to web_application/*', () => {
    const stmts = s3StatementsFor('PatchApplier');
    const liveWrite = stmts.filter(
      (s) => JSON.stringify(s.Resource).includes('/web_application/') && grantsS3Write(s),
    );
    expect(liveWrite).toHaveLength(0);
    const liveRead = stmts.filter((s) => JSON.stringify(s.Resource).includes('/web_application/'));
    expect(liveRead.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(liveRead)).toContain('s3:GetObject');
  });

  it('patch-applier writes ONLY to staging/*', () => {
    const writes = s3StatementsFor('PatchApplier').filter(grantsS3Write);
    expect(writes.length).toBeGreaterThanOrEqual(1);
    for (const w of writes) {
      expect(JSON.stringify(w.Resource)).toContain('/staging/');
      expect(JSON.stringify(w.Resource)).not.toContain('/web_application/');
    }
  });

  it('promoter (the promotion tool) DOES get write on both live and staging', () => {
    const json = JSON.stringify(s3StatementsFor('Promoter').filter(grantsS3Write));
    expect(json).toContain('/web_application/');
    expect(json).toContain('/staging/');
  });
});

/** Resolve config once for assertions that read config values. */
function config(): AppConfig {
  const app = new App();
  return { ...getConfig(app), env: TEST_ENV };
}
