import { CfnOutput, Stack } from 'aws-cdk-lib';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as iam from 'aws-cdk-lib/aws-iam';
import { NagSuppressions } from 'cdk-nag';
import type { Construct } from 'constructs';
import type { BaseStackProps } from './stack-props.js';

/**
 * Props for {@link AiStack}.
 *
 * Consumes the REST API id from the ComputeStack so the AgentCore Gateway can
 * expose that API's operations as MCP tools. Passed cross-stack in `bin/app.ts`.
 */
export interface AiStackProps extends BaseStackProps {
  /** The public REST API id (from ComputeStack) the Gateway fronts as MCP tools. */
  readonly restApiId: string;
  /** The REST API stage name (e.g. `v1`) the Gateway target points at. */
  readonly apiStageName: string;
}

/**
 * AiStack — the AgentCore "Be Called" layer (Gateway + managed Harness).
 *
 * Reproduces, in IaC, what was first built by hand in the console:
 *   - `geo-hotel-gateway`  : an MCP Gateway (IAM inbound auth) whose target is the
 *                            existing REST API, auto-translated into MCP tools.
 *   - `geo-concierge`      : a managed Harness (Claude Sonnet 4.6) that uses the
 *                            Gateway as its tool source — this is the on-site
 *                            concierge brain the `geo-onsite-chat` Lambda invokes.
 *   - a DEFAULT HarnessEndpoint for stable invocation.
 *
 * Depends on: ComputeStack (REST API id + stage).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️  CDK-VERSION SENSITIVITY — READ BEFORE DEPLOY
 * The `aws-cdk-lib/aws-bedrockagentcore` L1 constructs (CfnGateway /
 * CfnGatewayTarget / CfnHarness / CfnHarnessEndpoint) are GA but their nested
 * property names and union shapes can differ across CDK minor versions. Run
 * `cdk synth AiStack` FIRST and fix any prop-name drift the synth flags against
 * your installed `aws-cdk-lib` — do NOT assume this compiles untouched. Confirm
 * the module exports these constructs: `npm ls aws-cdk-lib` + check the
 * generated `.d.ts`, or `npm i aws-cdk-lib@latest` if they're absent.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export class AiStack extends Stack {
  private readonly _harnessArn: string;

  constructor(scope: Construct, id: string, props: AiStackProps) {
    super(scope, id, props);

    const { config, restApiId, apiStageName } = props;
    const prefix = config.prefix;

    // ── Gateway service role: lets the Gateway call the REST API (outbound). ──
    const gatewayRole = new iam.Role(this, 'GatewayRole', {
      roleName: `${prefix}-gateway-role`,
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
      description: 'Outbound role the AgentCore Gateway uses to invoke the REST API.',
    });
    gatewayRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['execute-api:Invoke'],
        resources: [`arn:aws:execute-api:${this.region}:${this.account}:${restApiId}/${apiStageName}/*/*`],
      }),
    );

    // ── Harness execution role: invoke the model via the INFERENCE PROFILE. ──
    // NOTE: the inference-profile ARN is REQUIRED (not just foundation-model/*).
    // Sonnet 4.6 invokes via the global inference profile; a foundation-model-only
    // scope fails at runtime with AccessDenied. (Hard-won lesson from the console build.)
    const harnessRole = new iam.Role(this, 'HarnessExecRole', {
      roleName: `${prefix}-harness-exec-role`,
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
      description: 'Runtime role the managed harness assumes to invoke the model.',
    });
    harnessRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: [
          'arn:aws:bedrock:*::foundation-model/anthropic.claude-*',
          `arn:aws:bedrock:*:${this.account}:inference-profile/global.anthropic.claude-*`,
        ],
      }),
    );

    // ── Gateway (reproduces `geo-hotel-gateway`): MCP, IAM inbound auth. ──
    const gateway = new agentcore.CfnGateway(this, 'GeoHotelGateway', {
      name: `${prefix}-hotel-gateway`,
      protocolType: 'MCP',
      authorizerType: 'AWS_IAM', // inbound SigV4 (agent-to-gateway)
      roleArn: gatewayRole.roleArn,
    });

    // ── Gateway target: the existing REST API, auto-translated into MCP tools. ──
    // ⚠️ Nested shape (targetConfiguration.mcp.apiGateway / credentialProvider*) is
    // the most version-sensitive part — verify against CfnGatewayTarget prop types.
    const apiGatewayArn = `arn:aws:apigateway:${this.region}::/restapis/${restApiId}/stages/${apiStageName}`;
    const apiTarget = new agentcore.CfnGatewayTarget(this, 'GeoApiTarget', {
      gatewayIdentifier: gateway.attrGatewayId,
      name: `${prefix}-api`,
      targetConfiguration: {
        mcp: {
          apiGateway: { apiGatewayArn },
        },
      },
      credentialProviderConfigurations: [{ credentialProviderType: 'GATEWAY_IAM_ROLE' }],
    });
    apiTarget.addDependency(gateway);

    // ── Harness (reproduces `geo-concierge`): Sonnet 4.6, gateway as tool source. ──
    const harness = new agentcore.CfnHarness(this, 'GeoConcierge', {
      harnessName: 'geo_concierge', // [a-zA-Z][a-zA-Z0-9_]{0,39}; immutable (change ⇒ replacement)
      executionRoleArn: harnessRole.roleArn,
      model: {
        bedrockModelConfig: { modelId: 'global.anthropic.claude-sonnet-4-6' },
      },
      systemPrompt: [
        {
          text:
            'You are the Octank Hospitality concierge. Help travelers find rooms, ' +
            'check availability, and compare rates using the available tools. ' +
            'Answer only from tool results; never invent properties, amenities, or prices.',
        },
      ],
      tools: [
        {
          type: 'agentcore_gateway',
          name: `${prefix}-hotel-gateway`,
          config: { agentcoreGatewayConfig: { gatewayArn: gateway.attrGatewayArn } },
        },
      ],
      maxIterations: 10,
      timeoutSeconds: 120,
    });
    harness.addDependency(apiTarget); // tools must exist before the harness references them

    // ── Stable DEFAULT endpoint callers (the geo-onsite-chat Lambda) invoke. ──
    const endpoint = new agentcore.CfnHarnessEndpoint(this, 'GeoConciergeEndpoint', {
      harnessId: harness.attrHarnessId,
      name: 'DEFAULT',
    });
    endpoint.addDependency(harness);

    this._harnessArn = harness.attrArn;

    new CfnOutput(this, 'HarnessArn', {
      value: harness.attrArn,
      description: 'ARN of the geo-concierge managed harness (set as HARNESS_ARN on geo-onsite-chat).',
      exportName: `${prefix}-harness-arn`,
    });
    new CfnOutput(this, 'GatewayArn', {
      value: gateway.attrGatewayArn,
      description: 'ARN of the geo-hotel-gateway MCP gateway.',
      exportName: `${prefix}-gateway-arn`,
    });

    // cdk-nag: the two service roles use scoped-but-wildcarded model/API ARNs.
    NagSuppressions.addStackSuppressions(this, [
      {
        id: 'AwsSolutions-IAM5',
        reason:
          'Harness role is scoped to the Claude model family plus the global ' +
          'inference-profile ARN (required for Sonnet invocation); the gateway role ' +
          'is scoped to execute-api:Invoke on exactly the project REST API stage. ' +
          'The remaining wildcards are the model-family / method-path segments, ' +
          'which have no narrower resource form.',
      },
    ]);
  }

  /**
   * The managed harness ARN. Wire this into the `geo-onsite-chat` Lambda as its
   * `HARNESS_ARN` env var, and grant the Lambda role BOTH
   * `bedrock-agentcore:InvokeHarness` and `bedrock-agentcore:InvokeAgentRuntime`
   * on this ARN (both are required — missing the second is a common AccessDenied).
   */
  public get harnessArn(): string {
    return this._harnessArn;
  }
}
