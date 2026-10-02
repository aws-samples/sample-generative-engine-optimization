import { CfnOutput, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { NagSuppressions } from 'cdk-nag';
import type { Construct } from 'constructs';
import type { BaseStackProps } from './stack-props.js';

/**
 * Props for {@link ConciergeChatStack}.
 *
 * Cross-stack values arrive as PLAIN STRINGS (not live constructs) so this
 * stack sits strictly downstream of the AiStack (harness ARN) and EdgeStack
 * (CloudFront domain) with no dependency cycle — the repo's cycle-avoidance
 * convention, matching how StorageStack takes `assetsDir: string`.
 */
export interface ConciergeChatStackProps extends BaseStackProps {
  /** The geo-concierge managed harness ARN (from AiStack) — set as `HARNESS_ARN`. */
  readonly harnessArn: string;
  /** The CloudFront distribution domain (host only, from EdgeStack) for the CORS origin. */
  readonly cloudFrontDomainName: string;
  /** Directory holding the chat Lambda source (`assets/code/chat-endpoint`). */
  readonly chatCodeDir: string;
}

/**
 * ConciergeChatStack — the on-site concierge chat Lambda + public Function URL.
 *
 * Deploys the browser-facing chat endpoint (`assets/code/chat-endpoint/`) as a
 * single Python Lambda fronted by a Lambda **Function URL** (NOT API Gateway).
 * The function invokes the AgentCore managed harness server-side and returns the
 * reply. It calls only the AgentCore data plane, so it runs OUTSIDE the VPC with
 * no Aurora / content-bucket access.
 *
 * Downstream of both AiStack (harness ARN) and EdgeStack (CloudFront domain for
 * CORS); neither reads anything back from this stack, so there is no dependency
 * cycle.
 */
export class ConciergeChatStack extends Stack {
  constructor(scope: Construct, id: string, props: ConciergeChatStackProps) {
    super(scope, id, props);

    const { config, harnessArn, cloudFrontDomainName, chatCodeDir } = props;
    const prefix = config.prefix;
    const allowedOrigin = `https://${cloudFrontDomainName}`;

    // Explicit DESTROY log group (unless retainData) so `cdk destroy` removes it
    // and a later deploy doesn't fail with "log group already exists". Mirrors
    // the BlogApi `logGroupFor` pattern, gated on retainData per the task.
    const logGroup = new logs.LogGroup(this, 'ChatLogGroup', {
      logGroupName: `/aws/lambda/${prefix}-onsite-chat`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: config.retainData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    // The chat Lambda — python3.13, handler `lambda_function.handler`. No VPC:
    // it only reaches the AgentCore data plane. MAX_MESSAGE_CHARS and
    // HARNESS_QUALIFIER are intentionally left unset (defaults apply).
    const fn = new lambda.Function(this, 'ChatFunction', {
      functionName: `${prefix}-onsite-chat`,
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'lambda_function.handler',
      code: lambda.Code.fromAsset(chatCodeDir),
      memorySize: 128,
      timeout: Duration.seconds(30),
      logGroup,
      environment: {
        HARNESS_ARN: harnessArn,
        ALLOWED_ORIGIN: allowedOrigin,
      },
    });

    // Both actions are required to invoke the managed harness; scoped to the
    // single harness ARN (NOT a wildcard).
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'InvokeConciergeHarness',
        actions: ['bedrock-agentcore:InvokeHarness', 'bedrock-agentcore:InvokeAgentRuntime'],
        resources: [harnessArn],
      }),
    );

    // Public, origin-locked Function URL. authType NONE is deliberate: this is
    // the demo's one public, unauthenticated, browser-to-server route (CORS is
    // locked to the CloudFront origin and the Lambda self-validates input),
    // mirroring the ComputeStack's "intentionally public" APIG4/COG4 rationale.
    // AwsSolutionsChecks has no Function-URL-auth rule, so NONE raises no finding.
    const fnUrl = fn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      cors: {
        allowedOrigins: [allowedOrigin],
        allowedMethods: [lambda.HttpMethod.POST],
        allowedHeaders: ['content-type'],
      },
    });

    new CfnOutput(this, 'ChatFunctionUrl', {
      value: fnUrl.url,
      description: 'Public Lambda Function URL for the on-site concierge chat widget',
      exportName: `${prefix}-chat-function-url`,
    });
    new CfnOutput(this, 'ChatFunctionName', {
      value: fn.functionName,
      description: 'Name of the on-site concierge chat Lambda',
      exportName: `${prefix}-chat-function-name`,
    });

    // cdk-nag: acknowledged posture for this public chat endpoint.
    NagSuppressions.addStackSuppressions(this, [
      {
        id: 'AwsSolutions-L1',
        reason:
          'Runtime is intentionally pinned to python3.13 (the current latest ' +
          'Python runtime) to match the deployed functions. Pinning is ' +
          'deliberate; the version is bumped explicitly, never auto-followed.',
      },
      {
        id: 'AwsSolutions-IAM4',
        reason:
          'The chat Lambda uses the AWS-managed AWSLambdaBasicExecutionRole for ' +
          'CloudWatch logging (no VPC exec role — this function is outside the ' +
          'VPC). This matches the standard least-privilege baseline.',
        appliesTo: [
          'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
        ],
      },
      {
        id: 'AwsSolutions-IAM5',
        reason:
          'The bedrock-agentcore:InvokeHarness / InvokeAgentRuntime grant is ' +
          'scoped to exactly one harness ARN (the geo-concierge harness); there ' +
          'is no narrower resource form. Defensive — the single-ARN grant is ' +
          'unlikely to trip IAM5.',
      },
    ]);
  }
}
