/*
 * Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { App, Stack } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { getConfig, type WorkflowConfig } from '../../lib/config/index.js';
import { BlogWorkflow } from '../../lib/constructs/blog-workflow.js';
import { TEST_ENV } from './helpers.js';

/**
 * BlogWorkflow needs three IFunctions and a WorkflowConfig. We stand up three
 * throwaway Lambdas in a host stack, build the construct there, and assert on
 * THAT stack's template.
 *
 * SCOPE: the "stage-only, never writes to live" guarantee is enforced by the
 * promoter/patch-applier IAM in BlogApi — not here. This construct's own IAM is
 * purely lambda:InvokeFunction on the three workers.
 */
function workflowConfig(context: Record<string, unknown> = {}): WorkflowConfig {
  const app = new App({ context });
  return getConfig(app).workflow;
}

function synth(opts: { workflow?: WorkflowConfig } = {}): Template {
  const app = new App();
  const host = new Stack(app, 'test-workflow-host', { env: TEST_ENV });
  const mk = (id: string) =>
    new lambda.Function(host, id, {
      functionName: `geo-demo-dev-${id}`,
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'lambda_function.lambda_handler',
      code: lambda.Code.fromInline('def lambda_handler(e, c): return {}'),
    });
  new BlogWorkflow(host, 'Workflow', {
    prefix: 'geo-demo-dev',
    workflow: opts.workflow ?? workflowConfig(),
    citationTracker: mk('citation-tracker'),
    patchApplier: mk('patch-applier'),
    promoter: mk('promoter'),
  });
  return Template.fromStack(host);
}

describe('BlogWorkflow construct', () => {
  const template = synth();

  it('creates exactly one Standard state machine with the deterministic name', () => {
    template.resourceCountIs('AWS::StepFunctions::StateMachine', 1);
    template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
      StateMachineName: 'geo-demo-dev-feedback-loop',
      StateMachineType: 'STANDARD',
    });
  });

  it('encodes the full Measure -> HasGap -> Patch -> ReTest -> Validate flow', () => {
    const machines = template.findResources('AWS::StepFunctions::StateMachine');
    const def = JSON.stringify(Object.values(machines)[0].Properties.DefinitionString);
    for (const state of [
      'MeasureLive',
      'HasGap',
      'ApplyPatch',
      'PatchChanged',
      'ReTestCandidate',
      'ValidateAndStage',
      'Done',
      'NoGapDone',
    ]) {
      expect(def).toContain(state);
    }
  });

  it('starts from MeasureLive against the LIVE target and re-tests STAGING', () => {
    const machines = template.findResources('AWS::StepFunctions::StateMachine');
    const defStr = JSON.stringify(Object.values(machines)[0].Properties.DefinitionString);
    // ASL is a nested JSON string inside an Fn::Join, so keys appear escaped.
    expect(defStr).toContain('target\\":\\"live');
    expect(defStr).toContain('target\\":\\"staging');
    expect(defStr).toContain('StartAt\\":\\"MeasureLive');
  });

  it('gates re-test on an actual change (top_fix present, changed==true)', () => {
    const machines = template.findResources('AWS::StepFunctions::StateMachine');
    const defStr = JSON.stringify(Object.values(machines)[0].Properties.DefinitionString);
    expect(defStr).toContain('top_fix');
    expect(defStr).toContain('changed');
  });

  it('bounds runtime with a 15-minute (900s) timeout in the ASL definition', () => {
    const machines = template.findResources('AWS::StepFunctions::StateMachine');
    const defStr = JSON.stringify(Object.values(machines)[0].Properties.DefinitionString);
    expect(defStr).toContain('TimeoutSeconds');
    expect(defStr).toContain('900');
  });

  it('grants the state-machine role ONLY lambda:InvokeFunction (no S3/CloudFront)', () => {
    const json = JSON.stringify(template.findResources('AWS::IAM::Policy'));
    expect(json).toContain('lambda:InvokeFunction');
    expect(json).not.toContain('s3:PutObject');
    expect(json).not.toContain('cloudfront:CreateInvalidation');
  });

  it('scopes the invoke grant to the three worker functions (version-qualified)', () => {
    const policies = template.findResources('AWS::IAM::Policy');
    const invokeStmts = Object.values(policies)
      .flatMap((p) => p.Properties?.PolicyDocument?.Statement ?? [])
      .filter((s: { Action?: string }) => s.Action === 'lambda:InvokeFunction');
    expect(invokeStmts).toHaveLength(3);
    const json = JSON.stringify(invokeStmts);
    for (const worker of ['citationtracker', 'patchapplier', 'promoter']) {
      expect(json).toContain(worker);
    }
    expect(json).toContain(':*');
    expect(json).not.toContain('"Resource":"*"');
  });

  it('enables ALL-level logging to a DESTROY vended-logs group with tracing on', () => {
    template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
      LoggingConfiguration: Match.objectLike({ Level: 'ALL', IncludeExecutionData: true }),
      TracingConfiguration: { Enabled: true },
    });
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/aws/vendedlogs/states/geo-demo-dev-feedback-loop',
    });
    template.hasResource('AWS::Logs::LogGroup', { DeletionPolicy: 'Delete' });
  });

  it('schedules the loop weekly with a flexible window, empty input, and no retries', () => {
    template.resourceCountIs('AWS::Scheduler::Schedule', 1);
    template.hasResourceProperties('AWS::Scheduler::Schedule', {
      Name: 'geo-demo-dev-feedback-loop-weekly',
      ScheduleExpression: 'rate(7 days)',
      ScheduleExpressionTimezone: 'America/Chicago',
      FlexibleTimeWindow: Match.objectLike({ Mode: 'FLEXIBLE', MaximumWindowInMinutes: 5 }),
      Target: Match.objectLike({
        Input: '{}',
        RetryPolicy: Match.objectLike({ MaximumRetryAttempts: 0 }),
      }),
    });
  });

  it('targets THIS state machine from the schedule (states:StartExecution)', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([Match.objectLike({ Action: 'states:StartExecution' })]),
      },
    });
  });
});

describe('BlogWorkflow with logging disabled', () => {
  it('creates no log group and emits no logging config', () => {
    const template = synth({ workflow: { ...workflowConfig(), enableLogging: false } });
    template.resourceCountIs('AWS::Logs::LogGroup', 0);
    const machines = template.findResources('AWS::StepFunctions::StateMachine');
    expect(Object.values(machines)[0].Properties.LoggingConfiguration).toBeUndefined();
  });
});

describe('BlogWorkflow with the schedule disabled', () => {
  it('builds the state machine but no EventBridge schedule', () => {
    const template = synth({ workflow: { ...workflowConfig(), enableSchedule: false } });
    template.resourceCountIs('AWS::StepFunctions::StateMachine', 1);
    template.resourceCountIs('AWS::Scheduler::Schedule', 0);
  });
});
