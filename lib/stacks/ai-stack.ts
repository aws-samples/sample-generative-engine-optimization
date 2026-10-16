/*
 * Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { Aws, CfnOutput, Stack } from 'aws-cdk-lib';
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

    // The harness must be able to CALL its gateway (the gateway's inbound auth is
    // AWS_IAM, so the harness presents SigV4). Without this the MCP client fails
    // to initialize at invoke time with a 4xx ("Failed to start MCP client").
    // Mirrors the live geo-harness-exec-role's InvokeAgentCoreGateway +
    // AgentCoreRuntime statements. Scoped to this gateway's ARN.
    harnessRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'InvokeAgentCoreGateway',
        actions: [
          'bedrock-agentcore:InvokeGateway',
          'bedrock-agentcore:GetGateway',
          'bedrock-agentcore:ListGatewayTargets',
        ],
        resources: [gateway.attrGatewayArn],
      }),
    );
    // InvokeAgentRuntime is scoped to agent-runtime resources in THIS account
    // and region (removing cross-account/cross-region exposure). The managed
    // harness's own runtime ARN is service-assigned and not known at synth, so
    // the runtime-id segment stays a wildcard. GetWorkloadAccessToken is a
    // workload-identity token action that takes NO resource ARN (AWS's own
    // BedrockAgentCoreRuntimeServiceRolePolicy grants it on `*`), so it is
    // split into its own `*` statement and documented in the nag suppression.
    harnessRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AgentCoreRuntime',
        actions: ['bedrock-agentcore:InvokeAgentRuntime'],
        resources: [
          `arn:${Aws.PARTITION}:bedrock-agentcore:${Aws.REGION}:${Aws.ACCOUNT_ID}:runtime/*`,
        ],
      }),
    );
    harnessRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AgentCoreWorkloadToken',
        actions: ['bedrock-agentcore:GetWorkloadAccessToken'],
        // No resource-level ARN form exists for this workload-identity token
        // action; it must be granted on `*`. See the IAM5 suppression below.
        resources: ['*'],
      }),
    );

    // ── Gateway target: the existing REST API, auto-translated into MCP tools. ──
    // The MCP apiGateway config references the REST API by id + stage, and the
    // tool filter exposes the GET methods the api-handler serves (GET /properties …).
    const apiTarget = new agentcore.CfnGatewayTarget(this, 'GeoApiTarget', {
      // GatewayIdentifier wants the gateway ID (a short pattern-constrained
      // string), NOT the ARN — attrGatewayArn fails the service's pattern
      // validation. Use attrGatewayIdentifier.
      gatewayIdentifier: gateway.attrGatewayIdentifier,
      name: `${prefix}-api`,
      targetConfiguration: {
        mcp: {
          apiGateway: {
            restApiId,
            stage: apiStageName,
            apiGatewayToolConfiguration: {
              toolFilters: [{ filterPath: '/*', methods: ['GET'] }],
            },
          },
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
            'Answer only from tool results; never invent properties, amenities, or prices. ' +
            'Never ask the traveler for a property ID or any internal identifier -- they ' +
            'do not know it. When a traveler names or describes a property (by name, city, ' +
            'or in a follow-up such as "that one" or "the first option"), call ' +
            'searchProperties to resolve it to a property, then use that property for ' +
            'availability or rate lookups. If the request is ambiguous or matches more than ' +
            'one property, ask a brief clarifying question in human terms (property name or ' +
            'city) or list the top matches for the traveler to choose -- never an ID. ' +
            'When the traveler gives or implies dates (for example "this weekend", "tonight", ' +
            '"next Friday", or specific dates), resolve them to concrete check-in and ' +
            'check-out dates and call getAvailability for the candidate properties before ' +
            'quoting rates -- do not answer a dated request with standard rates alone. ' +
            'Interpret "this weekend" as the upcoming Saturday check-in to Sunday check-out. ' +
            'State the check-in and check-out dates you used in your answer, and if a ' +
            'property has no availability for those dates, say so rather than omitting it.',
        },
      ],
      tools: [
        {
          type: 'agentcore_gateway',
          name: `${prefix}-hotel-gateway`,
          config: {
            agentCoreGateway: {
              gatewayArn: gateway.attrGatewayArn,
              outboundAuth: { awsIam: {} }, // AWS_IAM outbound (gateway-to-API via its role)
            },
          },
        },
      ],
      // Explicitly opt OUT of memory (single-turn Q&A), matching the live
      // geo-concierge harness. Without this the service defaults memory ON, and
      // the runtime calls bedrock-agentcore:ListEvents at invoke time — which
      // AccessDenies against this exec role (and the live role grants no memory
      // actions either, because the live harness has memory disabled).
      memory: { disabled: {} },
      maxIterations: 10,
      timeoutSeconds: 120,
    });
    harness.addDependency(apiTarget); // tools must exist before the harness references them

    // No explicit HarnessEndpoint: AgentCore auto-creates a DEFAULT endpoint
    // with the harness (the name 'DEFAULT' is reserved and cannot be created
    // explicitly — the service rejects it with ValidationException). The
    // geo-onsite-chat Lambda invokes with no qualifier, which targets DEFAULT.
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
          'is scoped to execute-api:Invoke on exactly the project REST API stage; ' +
          'InvokeAgentRuntime is scoped to this account+region agent-runtime ' +
          'namespace (runtime/*, since the managed harness runtime id is ' +
          'service-assigned and unknown at synth). The remaining wildcards are the ' +
          'model-family / method-path / runtime-id segments, which have no narrower ' +
          'resource form. bedrock-agentcore:GetWorkloadAccessToken is a workload-' +
          'identity token action with NO resource-level ARN form (AWS\'s own ' +
          'BedrockAgentCoreRuntimeServiceRolePolicy grants it on `*`), so it is ' +
          'granted on `*` by necessity.',
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
