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
  });
  return Template.fromStack(stack);
}

describe('ConciergeChatStack (on-site chat Lambda + REST API)', () => {
  const template = synth();

  it('creates a python3.13 Lambda with the right handler and env vars', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'python3.13',
      Handler: 'lambda_function.handler',
      FunctionName: 'geo-demo-dev-onsite-chat',
      Environment: {
        Variables: Match.objectLike({
          HARNESS_ARN: FAKE_HARNESS_ARN,
          ALLOWED_ORIGIN: ALLOWED_ORIGIN,
        }),
      },
    });
  });

  it('keeps the function OUTSIDE the VPC', () => {
    const fns = template.findResources('AWS::Lambda::Function');
    expect(Object.values(fns).every((f) => !f.Properties?.VpcConfig)).toBe(true);
  });

  it('fronts the function with a public REST API exposing POST /chat', () => {
    template.hasResourceProperties('AWS::ApiGateway::RestApi', {
      Name: 'geo-demo-dev-concierge-chat-api',
    });
    // POST /chat method on the API
    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'POST',
      AuthorizationType: 'NONE',
    });
    // A /chat resource
    template.hasResourceProperties('AWS::ApiGateway::Resource', {
      PathPart: 'chat',
    });
  });

  it('grants both AgentCore invoke actions scoped to the single harness ARN', () => {
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

  it('declares an explicit DESTROY log group for clean teardown', () => {
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/aws/lambda/geo-demo-dev-onsite-chat',
    });
    const groups = template.findResources('AWS::Logs::LogGroup');
    for (const g of Object.values(groups)) {
      expect(g.DeletionPolicy).toBe('Delete');
    }
  });

  it('exports the chat API endpoint', () => {
    template.hasOutput('ChatApiEndpoint', {});
  });
});
