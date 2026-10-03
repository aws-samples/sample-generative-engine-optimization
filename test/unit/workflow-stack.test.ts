import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { getConfig, type AppConfig } from '../../lib/config/index.js';
import { NetworkStack, StorageStack, ComputeStack, WorkflowStack } from '../../lib/stacks/index.js';
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
  });
  const workflow = new WorkflowStack(app, 'test-workflow', {
    env: config.env,
    config,
    citationTracker: compute.citationTracker,
    patchApplier: compute.patchApplier,
    promoter: compute.promoter,
  });
  return Template.fromStack(workflow);
}

describe('WorkflowStack (feedback-loop Step Function)', () => {
  const template = synth();

  it('creates a single Standard state machine', () => {
    template.resourceCountIs('AWS::StepFunctions::StateMachine', 1);
    template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
      StateMachineName: 'geo-demo-dev-feedback-loop',
      StateMachineType: 'STANDARD',
    });
  });

  it('has the feedback-loop states in its definition', () => {
    const machines = template.findResources('AWS::StepFunctions::StateMachine');
    const def = JSON.stringify(Object.values(machines)[0].Properties.DefinitionString);
    for (const state of [
      'MeasureLive',
      'HasGap',
      'ApplyPatch',
      'PatchChanged',
      'ReTestCandidate',
      'ValidateAndStage',
    ]) {
      expect(def).toContain(state);
    }
  });

  it('grants the state machine invoke on the worker functions', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Action: 'lambda:InvokeFunction' }),
        ]),
      },
    });
  });

  it('enables logging + a DESTROY log group by default', () => {
    template.hasResource('AWS::Logs::LogGroup', { DeletionPolicy: 'Delete' });
    template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
      LoggingConfiguration: Match.objectLike({ Level: 'ALL' }),
    });
  });

  it('exports the state machine ARN', () => {
    template.hasOutput('StateMachineArn', {});
  });

  it('schedules the state machine weekly via EventBridge Scheduler', () => {
    template.resourceCountIs('AWS::Scheduler::Schedule', 1);
    template.hasResourceProperties('AWS::Scheduler::Schedule', {
      Name: 'geo-demo-dev-feedback-loop-weekly',
      ScheduleExpression: 'rate(7 days)',
      ScheduleExpressionTimezone: 'America/Chicago',
      State: 'ENABLED',
      FlexibleTimeWindow: Match.objectLike({ Mode: 'FLEXIBLE' }),
      Target: Match.objectLike({ Input: '{}' }),
    });
  });
});

describe('WorkflowStack honors context overrides', () => {
  it('omits logging when workflowLogging=false', () => {
    const t = synth({ workflowLogging: false });
    t.resourceCountIs('AWS::Logs::LogGroup', 0);
  });

  it('omits the schedule when workflowSchedule=false', () => {
    const t = synth({ workflowSchedule: false });
    t.resourceCountIs('AWS::Scheduler::Schedule', 0);
  });
});
