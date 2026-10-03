/*
 * Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { getConfig, type AppConfig } from '../../lib/config/index.js';
import { NetworkStack, StorageStack, ComputeStack } from '../../lib/stacks/index.js';
import { TEST_ENV } from './helpers.js';

const CLUSTER_ARN = 'arn:aws:rds:us-east-1:123456789012:cluster:test-cluster';
const SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:test-secret';

function synth(context: Record<string, unknown> = {}): Template {
  const app = new App({ context });
  const config: AppConfig = { ...getConfig(app), env: TEST_ENV };
  const network = new NetworkStack(app, 'test-network', { env: config.env, config });
  const storage = new StorageStack(app, 'test-storage', { env: config.env, config });
  const compute = new ComputeStack(app, 'test-compute', {
    env: config.env,
    config,
    vpc: network.vpc,
    lambdaSecurityGroup: network.lambdaSecurityGroup,
    contentBucket: storage.bucket,
    clusterArn: CLUSTER_ARN,
    dbSecretArn: SECRET_ARN,
    distributionId: 'E2HKAT79V522DO',
  });
  return Template.fromStack(compute);
}

describe('ComputeStack (Lambdas + REST API)', () => {
  const template = synth();

  it('creates the four Python 3.13 Lambda functions', () => {
    template.resourceCountIs('AWS::Lambda::Function', 4);
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'python3.13',
      Handler: 'lambda_function.lambda_handler',
    });
  });

  it('attaches every function to the VPC', () => {
    const fns = template.findResources('AWS::Lambda::Function');
    const withVpc = Object.values(fns).filter((f) => f.Properties?.VpcConfig);
    expect(withVpc).toHaveLength(4);
  });

  it('creates an explicit DESTROY log group per function (clean teardown)', () => {
    // 4 lambda log groups + 1 API Gateway access log group = 5, all DESTROY.
    const groups = template.findResources('AWS::Logs::LogGroup');
    expect(Object.keys(groups).length).toBeGreaterThanOrEqual(5);
    for (const g of Object.values(groups)) {
      expect(g.DeletionPolicy).toBe('Delete');
    }
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/aws/lambda/geo-demo-dev-api-handler',
    });
  });

  it('sets the discovered per-function timeouts', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'geo-demo-dev-api-handler',
      Timeout: 30,
    });
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'geo-demo-dev-citation-tracker',
      Timeout: 300,
    });
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'geo-demo-dev-promoter',
      Timeout: 3,
    });
  });

  it('grants the api-handler RDS Data API + secret read', () => {
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

  it('grants the citation-tracker Bedrock invoke', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
          }),
        ]),
      },
    });
  });

  it('creates a regional REST API with the discovered route tree', () => {
    template.resourceCountIs('AWS::ApiGateway::RestApi', 1);
    // properties, {propertyId}, rates, availability, reservations = 5 resources.
    template.resourceCountIs('AWS::ApiGateway::Resource', 5);
    // 4 GET + 1 POST = 5 methods.
    template.resourceCountIs('AWS::ApiGateway::Method', 5);
  });

  it('deploys an API stage with throttling', () => {
    template.hasResourceProperties('AWS::ApiGateway::Stage', {
      StageName: 'prod',
      MethodSettings: Match.arrayWith([
        Match.objectLike({ ThrottlingRateLimit: 50, ThrottlingBurstLimit: 100 }),
      ]),
    });
  });

  it('exports the API endpoint', () => {
    template.hasOutput('ApiEndpoint', {});
  });
});

describe('ComputeStack honors context overrides', () => {
  it('applies an overridden lambda memory and api timeout', () => {
    const t = synth({ lambdaMemoryMb: 256, apiTimeoutSeconds: 15 });
    t.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'geo-demo-dev-api-handler',
      MemorySize: 256,
      Timeout: 15,
    });
  });
});
