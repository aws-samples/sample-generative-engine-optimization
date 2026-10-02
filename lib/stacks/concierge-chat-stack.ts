import { CfnOutput, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
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
 * ConciergeChatStack — the on-site concierge chat Lambda + public REST API.
 *
 * Deploys the browser-facing chat endpoint (`assets/code/chat-endpoint/`) as a
 * single Python Lambda fronted by an **API Gateway REST API** (`POST /chat`
 * with CORS). The function invokes the AgentCore managed harness server-side
 * and returns the reply. It calls only the AgentCore data plane, so it runs
 * OUTSIDE the VPC with no Aurora / content-bucket access.
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
      memorySize: 256,
      // The agent loop (Bedrock reasoning + gateway tool calls) can run well
      // past 30s. The harness itself allows up to 120s (CfnHarness
      // timeoutSeconds), so give the Lambda headroom beyond that to receive and
      // relay the streamed reply. Lambda Function URLs allow up to 15 min.
      timeout: Duration.seconds(150),
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

    // Public REST API: POST /chat (+ CORS preflight). This is the demo's one
    // public, unauthenticated, browser-to-server route — CORS is locked to the
    // CloudFront origin and the Lambda self-validates input. API Gateway (rather
    // than a Lambda Function URL) is used because this account rejects public
    // Function URLs; the REST API also matches the committed OpenAPI intent.
    // Access-log group for the API stage (explicit DESTROY so teardown is clean).
    const apiAccessLogs = new logs.LogGroup(this, 'ChatApiAccessLogs', {
      logGroupName: `/${prefix}/concierge-chat/apigw/access`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: config.retainData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    const api = new apigateway.RestApi(this, 'ChatApi', {
      restApiName: `${prefix}-concierge-chat-api`,
      description: 'Public on-site concierge chat endpoint (POST /chat).',
      deployOptions: {
        stageName: config.compute.apiStageName,
        // Stage logging (addresses APIG1 access logs + APIG6 execution logs).
        // The account-level API Gateway CloudWatch role is created by the
        // ComputeStack (one per region), so stage logging works here too.
        accessLogDestination: new apigateway.LogGroupLogDestination(apiAccessLogs),
        accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields(),
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: [allowedOrigin],
        allowMethods: ['POST', 'OPTIONS'],
        allowHeaders: ['Content-Type'],
      },
    });

    const chat = api.root.addResource('chat');
    chat.addMethod('POST', new apigateway.LambdaIntegration(fn), {
      operationName: 'conciergeChat',
      methodResponses: [{ statusCode: '200' }, { statusCode: '400' }, { statusCode: '502' }],
    });

    new CfnOutput(this, 'ChatApiEndpoint', {
      // Full invoke URL for the chat turn, e.g. https://<id>.execute-api.<region>.amazonaws.com/<stage>/chat
      value: `${api.url}chat`,
      description: 'Public API Gateway URL for the on-site concierge chat (POST /chat)',
      exportName: `${prefix}-chat-api-endpoint`,
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
      {
        id: 'AwsSolutions-IAM4',
        reason:
          'The API Gateway account role uses the AWS-managed ' +
          'AmazonAPIGatewayPushToCloudWatchLogs policy required to enable stage ' +
          'access/execution logging — the standard least-privilege baseline, ' +
          'matching the ComputeStack API.',
        appliesTo: [
          'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AmazonAPIGatewayPushToCloudWatchLogs',
        ],
      },
      {
        id: 'AwsSolutions-APIG2',
        reason:
          'Request validation is handled inside the chat Lambda (JSON parse, ' +
          'non-empty message, length cap); the endpoint is a thin proxy to the ' +
          'AgentCore harness and does not use model-based request validation.',
      },
      {
        id: 'AwsSolutions-APIG3',
        reason:
          'WAF association is planned at the CloudFront edge (EdgeStack) rather ' +
          'than per-API for this demo scope, matching the ComputeStack API.',
      },
      {
        id: 'AwsSolutions-APIG4',
        reason:
          'The chat endpoint is intentionally public and unauthenticated — it is ' +
          'the browser-to-server route for the on-site concierge widget. CORS is ' +
          'locked to the CloudFront origin and the Lambda self-validates input.',
      },
      {
        id: 'AwsSolutions-COG4',
        reason:
          'No Cognito user pool authorizer: the chat endpoint is intentionally ' +
          'public for the on-site widget, consistent with the data API.',
      },
    ]);
  }
}
