import { Duration, RemovalPolicy, TimeZone } from 'aws-cdk-lib';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as schedulerTargets from 'aws-cdk-lib/aws-scheduler-targets';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { Construct } from 'constructs';
import type { WorkflowConfig } from '../config/index.js';

/** Props for {@link BlogWorkflow}. */
export interface BlogWorkflowProps {
  /** Resource-name prefix (e.g. `geo-demo-dev`). */
  readonly prefix: string;
  /** Workflow settings resolved from the environment config. */
  readonly workflow: WorkflowConfig;
  /** The citation-tracker Lambda (measures citation share). */
  readonly citationTracker: lambda.IFunction;
  /** The patch-applier Lambda (writes a candidate to staging/). */
  readonly patchApplier: lambda.IFunction;
  /** The promoter Lambda (validate + stage-only; never writes live). */
  readonly promoter: lambda.IFunction;
}

/**
 * BlogWorkflow — the GEO automated feedback loop, as a Standard Step Function.
 *
 * Mirrors the `geo-feedback-loop` state machine:
 *
 *   MeasureLive (citation-tracker, target=live)
 *     -> HasGap? (top_gap.top_fix present?)
 *          yes -> ApplyPatch (patch-applier, writes to staging/)
 *                   -> PatchChanged? (patch.changed == true?)
 *                        yes -> ReTestCandidate (citation-tracker, target=staging)
 *                                 -> ValidateAndStage (promoter, stage-only)
 *                                      -> Done (Succeed)
 *                        no  -> NoGapDone (Succeed)
 *          no  -> NoGapDone (Succeed)
 *
 * STAGE-ONLY: the loop never writes to live content; a validated candidate is
 * left in staging/ for manual promotion. The Step Functions role only gets
 * lambda:InvokeFunction on the three workers (granted automatically by the
 * LambdaInvoke tasks).
 */
export class BlogWorkflow extends Construct {
  public readonly stateMachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: BlogWorkflowProps) {
    super(scope, id);

    const { prefix, workflow, citationTracker, patchApplier, promoter } = props;

    // Measure current citation share for the live content, diagnose gaps.
    const measureLive = new tasks.LambdaInvoke(this, 'MeasureLive', {
      lambdaFunction: citationTracker,
      comment: 'Measure current citation share for the live content.',
      payload: sfn.TaskInput.fromObject({ target: 'live' }),
      // Unwrap the Lambda's JSON body into $.measure (payloadResponseOnly keeps
      // the function result rather than the full invoke envelope).
      payloadResponseOnly: true,
      resultPath: '$.measure',
    });

    // Deterministically patch the diagnosed property; write to staging/ only.
    const applyPatch = new tasks.LambdaInvoke(this, 'ApplyPatch', {
      lambdaFunction: patchApplier,
      comment: 'Patch the diagnosed property JSON-LD; staging/ only.',
      payload: sfn.TaskInput.fromObject({
        'property_slug.$': '$.measure.top_gap.property_slug',
        'top_fix.$': '$.measure.top_gap.top_fix',
      }),
      payloadResponseOnly: true,
      resultPath: '$.patch',
    });

    // Re-measure citation share against the STAGED candidate content.
    const reTestCandidate = new tasks.LambdaInvoke(this, 'ReTestCandidate', {
      lambdaFunction: citationTracker,
      comment: 'Re-measure citation share against the staged candidate.',
      payload: sfn.TaskInput.fromObject({
        target: 'staging',
        'staged_key.$': '$.patch.staged_key',
      }),
      payloadResponseOnly: true,
      resultPath: '$.retest',
    });

    // Stage-only: if candidate beats baseline, leave it in staging/; else discard.
    const validateAndStage = new tasks.LambdaInvoke(this, 'ValidateAndStage', {
      lambdaFunction: promoter,
      comment: 'Stage-only validation; never writes to live.',
      payload: sfn.TaskInput.fromObject({
        'staged_key.$': '$.patch.staged_key',
        'live_key.$': '$.patch.live_key',
        'property_slug.$': '$.patch.property_slug',
        'baseline_citation_rate.$': '$.measure.citation_rate_pct',
        'candidate_citation_rate.$': '$.retest.citation_rate_pct',
      }),
      payloadResponseOnly: true,
      resultPath: '$.validate',
    });

    const done = new sfn.Succeed(this, 'Done', {
      comment: 'Loop complete; a validated candidate may be waiting in staging/.',
    });
    const noGapDone = new sfn.Succeed(this, 'NoGapDone', {
      comment: 'No citation gap to act on (or patch made no change).',
    });

    // PatchChanged? — only re-test if the patch actually changed content.
    const patchChanged = new sfn.Choice(this, 'PatchChanged', {
      comment: 'If the patch produced no change, skip re-test.',
    })
      .when(
        sfn.Condition.booleanEquals('$.patch.changed', true),
        reTestCandidate.next(validateAndStage.next(done)),
      )
      .otherwise(noGapDone);

    // HasGap? — proceed only if a top_fix was diagnosed.
    const hasGap = new sfn.Choice(this, 'HasGap', {
      comment: 'Proceed only if a prompt was not cited and produced a top_fix.',
    })
      .when(
        sfn.Condition.isPresent('$.measure.top_gap.top_fix'),
        applyPatch.next(patchChanged),
      )
      .otherwise(noGapDone);

    const definition = measureLive.next(hasGap);

    const logGroup = workflow.enableLogging
      ? new logs.LogGroup(this, 'LogGroup', {
          logGroupName: `/aws/vendedlogs/states/${prefix}-feedback-loop`,
          retention: logs.RetentionDays.ONE_MONTH,
          removalPolicy: RemovalPolicy.DESTROY,
        })
      : undefined;

    this.stateMachine = new sfn.StateMachine(this, 'FeedbackLoop', {
      stateMachineName: `${prefix}-feedback-loop`,
      stateMachineType: sfn.StateMachineType.STANDARD,
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      timeout: Duration.minutes(15),
      ...(logGroup
        ? {
            logs: {
              destination: logGroup,
              level: sfn.LogLevel.ALL,
              includeExecutionData: true,
            },
            tracingEnabled: true,
          }
        : {}),
    });

    // EventBridge Scheduler trigger — mirrors the live `geo-feedback-loop-weekly`
    // schedule (rate(7 days), America/Chicago, 5-min flexible window, empty
    // input, 0 retries). The L2 StepFunctionsStartExecution target auto-creates
    // the scheduler execution role with a scoped states:StartExecution grant on
    // this state machine (equivalent to the live geo-scheduler-role). Gated on
    // config so it can be disabled per-deploy.
    if (workflow.enableSchedule) {
      new scheduler.Schedule(this, 'FeedbackLoopSchedule', {
        scheduleName: `${prefix}-feedback-loop-weekly`,
        description: 'Recurring trigger for the GEO feedback-loop state machine.',
        schedule: scheduler.ScheduleExpression.expression(
          workflow.scheduleExpression,
          TimeZone.of(workflow.scheduleTimezone),
        ),
        timeWindow: scheduler.TimeWindow.flexible(Duration.minutes(5)),
        target: new schedulerTargets.StepFunctionsStartExecution(this.stateMachine, {
          input: scheduler.ScheduleTargetInput.fromText('{}'),
          maxEventAge: Duration.hours(24),
          retryAttempts: 0,
        }),
      });
    }
  }
}
