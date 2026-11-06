/*
 * Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT-0
 */

import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { getConfig, type AppConfig } from '../../lib/config/index.js';
import { NetworkStack, StorageStack, ComputeStack, AiStack } from '../../lib/stacks/index.js';
import { TEST_ENV } from './helpers.js';

const CLUSTER_ARN = 'arn:aws:rds:us-east-1:123456789012:cluster:test-cluster';
const SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:test-secret';

/**
 * AiStack — the AgentCore "Be Called" layer (Gateway + Gateway Target +
 * managed Harness). It consumes the REST API id + stage from a ComputeStack
 * (which needs network + storage), so we build that minimal chain and feed the
 * live cross-stack references in, mirroring bin/app.ts.
 *
 * This stack is marked synth-only / not-yet-live-verified in the README, so
 * these unit assertions are the primary safety net for it: they pin the gateway
 * auth mode, the GET-only tool filter, the harness model/memory config, and the
 * two service roles' least-privilege IAM.
 */
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
  });
  const ai = new AiStack(app, 'test-ai', {
    env: config.env,
    config,
    restApiId: compute.restApiId,
    apiStageName: compute.apiStageName,
  });
  return Template.fromStack(ai);
}

describe('AiStack (AgentCore "Be Called" layer)', () => {
  // Guard: the aws-bedrockagentcore L1 props drift across aws-cdk-lib minors
  // (see the warning header in ai-stack.ts). If the installed version's prop
  // names differ, synth() throws here and every assertion fails loudly — itself
  // the signal to re-align the matchers with the actual synthesized template.
  const template = synth();

  it('synthesizes exactly one Gateway, Gateway target, and Harness', () => {
    template.resourceCountIs('AWS::BedrockAgentCore::Gateway', 1);
    template.resourceCountIs('AWS::BedrockAgentCore::GatewayTarget', 1);
    template.resourceCountIs('AWS::BedrockAgentCore::Harness', 1);
  });

  it('creates an MCP gateway with AWS_IAM inbound auth', () => {
    template.hasResourceProperties('AWS::BedrockAgentCore::Gateway', {
      Name: 'geo-demo-dev-hotel-gateway',
      ProtocolType: 'MCP',
      AuthorizerType: 'AWS_IAM',
    });
  });

  it('exposes ONLY GET methods of the REST API as MCP tools (read-only surface)', () => {
    const targets = template.findResources('AWS::BedrockAgentCore::GatewayTarget');
    const serialized = JSON.stringify(Object.values(targets)[0].Properties);
    expect(serialized).toContain('"Methods":["GET"]');
    expect(serialized).toContain('"FilterPath":"/*"');
    // Outbound credentials come from the gateway's own IAM role.
    expect(serialized).toContain('GATEWAY_IAM_ROLE');
  });

  it('pins the harness to Sonnet 4.6, disables memory, and bounds the loop', () => {
    template.hasResourceProperties('AWS::BedrockAgentCore::Harness', {
      HarnessName: 'geo_concierge',
      Model: Match.objectLike({
        BedrockModelConfig: Match.objectLike({ ModelId: 'global.anthropic.claude-sonnet-4-6' }),
      }),
      Memory: Match.objectLike({ Disabled: Match.anyValue() }),
      MaxIterations: 10,
      TimeoutSeconds: 120,
    });
  });

  it('scopes the harness role to the CONFIGURED model AND its inference profile', () => {
    // Narrowed from the whole anthropic.claude-* family to the specific model
    // the harness runs on (one trailing * covers region/version variants).
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['bedrock:InvokeModel']),
            Resource: Match.arrayWith([
              'arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-6*',
              Match.stringLikeRegexp('inference-profile/global\\.anthropic\\.claude-sonnet-4-6\\*'),
            ]),
          }),
        ]),
      },
    });
  });

  it('grants the harness role the AgentCore invoke/token statements', () => {
    const policies = template.findResources('AWS::IAM::Policy');
    const actions = Object.values(policies)
      .flatMap((p) => p.Properties.PolicyDocument.Statement as Array<Record<string, unknown>>)
      .flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]));
    expect(actions).toEqual(
      expect.arrayContaining([
        'bedrock-agentcore:InvokeGateway',
        'bedrock-agentcore:GetGateway',
        'bedrock-agentcore:ListGatewayTargets',
        'bedrock-agentcore:InvokeAgentRuntime',
        'bedrock-agentcore:GetWorkloadAccessToken',
      ]),
    );
  });

  it('scopes the gateway role to execute-api:Invoke on the project REST API stage', () => {
    const policies = template.findResources('AWS::IAM::Policy');
    const execApi = Object.values(policies)
      .flatMap((p) => p.Properties.PolicyDocument.Statement as Array<Record<string, unknown>>)
      .find((s) => {
        const a = Array.isArray(s.Action) ? s.Action : [s.Action];
        return a.includes('execute-api:Invoke');
      });
    expect(execApi).toBeDefined();
    // Scoped to a real execute-api ARN, not a bare '*'.
    expect(JSON.stringify(execApi?.Resource)).toContain('execute-api');
    expect(execApi?.Resource).not.toEqual('*');
  });

  it('restricts InvokeAgentRuntime to this account+region runtime namespace (not *)', () => {
    const policies = template.findResources('AWS::IAM::Policy');
    const runtimeStmt = Object.values(policies)
      .flatMap((p) => p.Properties.PolicyDocument.Statement as Array<Record<string, unknown>>)
      .find((s) => {
        const a = Array.isArray(s.Action) ? s.Action : [s.Action];
        return a.includes('bedrock-agentcore:InvokeAgentRuntime');
      });
    expect(runtimeStmt).toBeDefined();
    // The runtime ARN is scoped (runtime/*), not a blanket '*'.
    expect(JSON.stringify(runtimeStmt?.Resource)).toContain('runtime/*');
    expect(runtimeStmt?.Resource).not.toEqual('*');
  });

  it('exports the harness and gateway ARNs for downstream wiring', () => {
    template.hasOutput('HarnessArn', {
      Export: Match.objectLike({ Name: 'geo-demo-dev-harness-arn' }),
    });
    template.hasOutput('GatewayArn', {
      Export: Match.objectLike({ Name: 'geo-demo-dev-gateway-arn' }),
    });
  });
});
