/*
 * Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { getConfig, type AppConfig } from '../../lib/config/index.js';
import { ConciergeChatStack } from '../../lib/stacks/index.js';
import { TEST_ENV } from './helpers.js';

const FAKE_HARNESS_ARN =
  'arn:aws:bedrock-agentcore:us-east-1:123456789012:harness/geo_concierge-abc123';
const FAKE_CF_DOMAIN = 'd123example.cloudfront.net';
const ALLOWED_ORIGIN = `https://${FAKE_CF_DOMAIN}`;

function synth(context: Record<string, unknown> = {}): Template {
  const app = new App({ context });
  const config: AppConfig = { ...getConfig(app), env: TEST_ENV };
  const stack = new ConciergeChatStack(app, 'test-concierge-chat', {
    env: config.env,
    config,
    harnessArn: FAKE_HARNESS_ARN,
    cloudFrontDomainName: FAKE_CF_DOMAIN,
    chatCodeDir: path.resolve(process.cwd(), 'assets', 'code', 'chat-endpoint'),
    contentBucketName: 'geo-demo-dev-content-123456789012-ca-central-1',
    distributionId: 'E1234567890ABC',
  });
  return Template.fromStack(stack);
}

describe('ConciergeChatStack (async submit/worker/poll chat API)', () => {
  const template = synth();

  it('creates the DynamoDB jobs table (PK jobId, TTL, PAY_PER_REQUEST)', () => {
    // TableV2 synthesizes to AWS::DynamoDB::GlobalTable.
    template.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
      TableName: 'geo-demo-dev-chat-jobs',
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: Match.arrayWith([
        Match.objectLike({ AttributeName: 'jobId', KeyType: 'HASH' }),
      ]),
      AttributeDefinitions: Match.arrayWith([
        Match.objectLike({ AttributeName: 'jobId', AttributeType: 'S' }),
      ]),
      TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
    });
  });

  it('creates the SUBMIT Lambda (python3.13, JOBS_TABLE + WORKER_FUNCTION_NAME env)', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'python3.13',
      Handler: 'lambda_function.handler',
      FunctionName: 'geo-demo-dev-chat-submit',
      Environment: {
        Variables: Match.objectLike({
          JOBS_TABLE: Match.anyValue(),
          WORKER_FUNCTION_NAME: Match.anyValue(),
          ALLOWED_ORIGIN: ALLOWED_ORIGIN,
        }),
      },
    });
  });

  it('creates the WORKER Lambda (python3.13, HARNESS_ARN + JOBS_TABLE env)', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'python3.13',
      Handler: 'lambda_function.handler',
      FunctionName: 'geo-demo-dev-onsite-chat',
      Environment: {
        Variables: Match.objectLike({
          HARNESS_ARN: FAKE_HARNESS_ARN,
          JOBS_TABLE: Match.anyValue(),
        }),
      },
    });
  });

  it('creates the POLL Lambda (python3.13, JOBS_TABLE + ALLOWED_ORIGIN env)', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'python3.13',
      Handler: 'lambda_function.handler',
      FunctionName: 'geo-demo-dev-chat-poll',
      Environment: {
        Variables: Match.objectLike({
          JOBS_TABLE: Match.anyValue(),
          ALLOWED_ORIGIN: ALLOWED_ORIGIN,
        }),
      },
    });
  });

  it('keeps all functions OUTSIDE the VPC', () => {
    const fns = template.findResources('AWS::Lambda::Function');
    expect(Object.values(fns).every((f) => !f.Properties?.VpcConfig)).toBe(true);
  });

  it('fronts the functions with a public REST API (POST /chat + GET /chat/{jobId})', () => {
    template.hasResourceProperties('AWS::ApiGateway::RestApi', {
      Name: 'geo-demo-dev-concierge-chat-api',
    });
    // POST /chat (submit) and GET /chat/{jobId} (poll), both unauthenticated.
    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'POST',
      AuthorizationType: 'NONE',
    });
    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'GET',
      AuthorizationType: 'NONE',
    });
    // A /chat resource and a /{jobId} child resource.
    template.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: 'chat' });
    template.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: '{jobId}' });
  });

  it('grants the worker both AgentCore invoke actions scoped to the single harness ARN', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: ['bedrock-agentcore:InvokeHarness', 'bedrock-agentcore:InvokeAgentRuntime'],
            Resource: FAKE_HARNESS_ARN,
          }),
        ]),
      },
    });
  });

  it('lets the worker write job results to DynamoDB (UpdateItem/PutItem)', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['dynamodb:PutItem', 'dynamodb:UpdateItem']),
            Effect: 'Allow',
          }),
        ]),
      },
    });
  });

  it('lets the submit function invoke the worker (lambda:InvokeFunction)', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'lambda:InvokeFunction',
            Effect: 'Allow',
          }),
        ]),
      },
    });
  });

  it('lets the poll function read the jobs table (dynamodb:GetItem)', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['dynamodb:GetItem']),
            Effect: 'Allow',
          }),
        ]),
      },
    });
  });

  it('declares explicit DESTROY log groups incl. the worker group for clean teardown', () => {
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/aws/lambda/geo-demo-dev-onsite-chat',
    });
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/aws/lambda/geo-demo-dev-chat-submit',
    });
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/aws/lambda/geo-demo-dev-chat-poll',
    });
    const groups = template.findResources('AWS::Logs::LogGroup');
    for (const g of Object.values(groups)) {
      expect(g.DeletionPolicy).toBe('Delete');
    }
  });

  it('exports the async chat endpoints and worker function name', () => {
    template.hasOutput('ChatSubmitEndpoint', {});
    template.hasOutput('ChatApiBaseUrl', {});
    template.hasOutput('ChatFunctionName', {});
  });

  it('writes the widget runtime config into web_application/ and invalidates it', () => {
    // The BucketDeployment that writes chat-config.json synthesizes to a
    // Custom::CDKBucketDeployment scoped to web_application/, and auto-
    // invalidates the public /chat-config.json path at the edge.
    template.hasResourceProperties('Custom::CDKBucketDeployment', {
      DestinationBucketKeyPrefix: 'web_application/',
      DistributionPaths: ['/chat-config.json'],
    });
  });
});
