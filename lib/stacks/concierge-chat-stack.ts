/*
 * Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { CfnOutput, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { NagSuppressions } from 'cdk-nag';
import type { Construct } from 'constructs';
import { STORAGE_PREFIXES } from '../config/index.js';
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
  /** Directory holding the chat WORKER Lambda source (`assets/code/chat-endpoint`). */
  readonly chatCodeDir: string;
  /**
   * Name of the content S3 bucket (from StorageStack). Passed as a plain string
   * (not a live construct) per the repo's cycle-avoidance convention. Used to
   * write the widget's runtime `chat-config.json` into `web_application/`, so
   * the served SPA learns this stack's chat API URL without baking an
   * environment-specific value into the asset at author time.
   */
  readonly contentBucketName: string;
  /**
   * CloudFront distribution id (from EdgeStack). When set, the config
   * deployment invalidates `/chat-config.json` at the edge so the updated value
   * is served immediately. Passed as a plain string (EdgeStack is already an
   * upstream dependency via `cloudFrontDomainName`), so no extra cycle.
   */
  readonly distributionId: string;
}

/**
 * ConciergeChatStack — the on-site concierge chat behind an ASYNC submit/poll
 * REST API.
 *
 * The browser-facing chat is served as an ASYNCHRONOUS request/poll flow on a
 * public **API Gateway REST API** (`${prefix}-concierge-chat-api`):
 *
 *   - `POST /chat`         → SUBMIT Lambda: records a PENDING job in DynamoDB,
 *                            invokes the WORKER asynchronously, returns 202
 *                            `{jobId}` immediately.
 *   - WORKER (async only)  → invokes the AgentCore managed harness (the ~49s
 *                            agent loop) and writes the result back to DynamoDB.
 *   - `GET /chat/{jobId}`  → POLL Lambda: reads the job and reports
 *                            PENDING / DONE / ERROR.
 *
 * Why async (proven live): the agent loop runs ~49s; API Gateway REST APIs
 * have a HARD 29s integration timeout, so a synchronous POST always times out
 * even though the Lambda succeeds. Lambda Function URLs are blocked by an
 * account guardrail (403 at the edge). The submit/poll split is the way to
 * expose this harness to the browser.
 *
 * All three functions call only the AgentCore data plane + DynamoDB, so they
 * run OUTSIDE the VPC with no Aurora / content-bucket access.
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

    // Submit/poll code dirs are siblings of the worker dir, so bin/app.ts needs
    // no change (it still passes chatCodeDir = assets/code/chat-endpoint).
    const submitCodeDir = path.resolve(chatCodeDir, '..', 'chat-submit');
    const pollCodeDir = path.resolve(chatCodeDir, '..', 'chat-poll');

    // --- Job store ---------------------------------------------------------
    // Ephemeral request/response scratch: PK jobId, 1h TTL, on-demand billing.
    // DESTROY unless retainData so teardown is clean (jobs are transient).
    const jobsTable = new dynamodb.TableV2(this, 'ChatJobsTable', {
      tableName: `${prefix}-chat-jobs`,
      partitionKey: { name: 'jobId', type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: 'ttl',
      billing: dynamodb.Billing.onDemand(),
      removalPolicy: config.retainData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    // --- WORKER: runs the ~49s agent loop, writes result to DynamoDB -------
    // Unchanged name `${prefix}-onsite-chat`; keeps its /aws/lambda log group.
    // Invoked ASYNCHRONOUSLY by the submit function (never behind API Gateway).
    const worker = new lambda.Function(this, 'ChatFunction', {
      functionName: `${prefix}-onsite-chat`,
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'lambda_function.handler',
      code: lambda.Code.fromAsset(chatCodeDir),
      memorySize: 256,
      // The agent loop (Bedrock reasoning + gateway tool calls) runs ~49s. Give
      // the worker headroom beyond the harness's own 120s cap to receive and
      // relay the streamed reply.
      timeout: Duration.seconds(150),
      logGroup: this.logGroupFor('ChatLogGroup', `${prefix}-onsite-chat`, config.retainData),
      environment: {
        HARNESS_ARN: harnessArn,
        JOBS_TABLE: jobsTable.tableName,
      },
    });

    // Both actions are required to invoke the managed harness; scoped to the
    // single harness ARN (NOT a wildcard).
    worker.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'InvokeConciergeHarness',
        actions: ['bedrock-agentcore:InvokeHarness', 'bedrock-agentcore:InvokeAgentRuntime'],
        resources: [harnessArn],
      }),
    );
    // Worker writes job results back (UpdateItem on success/failure).
    jobsTable.grantWriteData(worker);

    // --- SUBMIT: records a PENDING job, fires the worker, returns 202 ------
    const submit = new lambda.Function(this, 'ChatSubmitFunction', {
      functionName: `${prefix}-chat-submit`,
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'lambda_function.handler',
      code: lambda.Code.fromAsset(submitCodeDir),
      memorySize: 256,
      timeout: Duration.seconds(10),
      logGroup: this.logGroupFor('ChatSubmitLogGroup', `${prefix}-chat-submit`, config.retainData),
      environment: {
        JOBS_TABLE: jobsTable.tableName,
        WORKER_FUNCTION_NAME: worker.functionName,
        ALLOWED_ORIGIN: allowedOrigin,
      },
    });
    jobsTable.grantWriteData(submit);
    worker.grantInvoke(submit);

    // --- POLL: reads the job, reports PENDING/DONE/ERROR -------------------
    const poll = new lambda.Function(this, 'ChatPollFunction', {
      functionName: `${prefix}-chat-poll`,
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'lambda_function.handler',
      code: lambda.Code.fromAsset(pollCodeDir),
      memorySize: 256,
      timeout: Duration.seconds(10),
      logGroup: this.logGroupFor('ChatPollLogGroup', `${prefix}-chat-poll`, config.retainData),
      environment: {
        JOBS_TABLE: jobsTable.tableName,
        ALLOWED_ORIGIN: allowedOrigin,
      },
    });
    jobsTable.grantReadData(poll);

    // --- Public REST API: POST /chat (submit) + GET /chat/{jobId} (poll) ---
    // This is the demo's one public, unauthenticated, browser-to-server route.
    // CORS is locked to the CloudFront origin and the Lambdas self-validate
    // input. API Gateway (rather than a Lambda Function URL) is used because
    // this account rejects public Function URLs; the async submit/poll split
    // works around API Gateway's hard 29s integration timeout vs the ~49s loop.
    const apiAccessLogs = new logs.LogGroup(this, 'ChatApiAccessLogs', {
      logGroupName: `/${prefix}/concierge-chat/apigw/access`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: config.retainData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    const api = new apigateway.RestApi(this, 'ChatApi', {
      restApiName: `${prefix}-concierge-chat-api`,
      description: 'Public on-site concierge chat endpoint (async POST /chat + GET /chat/{jobId}).',
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
        allowMethods: ['POST', 'GET', 'OPTIONS'],
        allowHeaders: ['Content-Type'],
      },
    });

    const chat = api.root.addResource('chat');
    chat.addMethod('POST', new apigateway.LambdaIntegration(submit), {
      operationName: 'submitChat',
      methodResponses: [{ statusCode: '202' }, { statusCode: '400' }, { statusCode: '502' }],
    });

    const job = chat.addResource('{jobId}');
    job.addMethod('GET', new apigateway.LambdaIntegration(poll), {
      operationName: 'pollChat',
      methodResponses: [{ statusCode: '200' }, { statusCode: '400' }, { statusCode: '404' }],
    });

    // --- Runtime config for the served SPA ---------------------------------
    // The on-site chat widget (assets/web_application/index.html) is uploaded by
    // the StorageStack and must stay environment-agnostic (no hard-coded API
    // URL). Instead, THIS stack — which owns the chat API and therefore knows
    // its URL — writes a tiny `web_application/chat-config.json` into the same
    // content bucket. The widget fetches it at load time to discover the base
    // URL. `api.url` is a deploy-time token, resolved by Source.jsonData.
    //
    // Cycle-safe: ConciergeChatStack already sits downstream of StorageStack
    // (via ai -> compute -> storage), so writing into the bucket here is a
    // one-directional reference; nothing reads back from this stack. The bucket
    // is imported read/write by name (same string-prop convention as the rest
    // of the stack). `prune: false` ensures this deployment only manages
    // chat-config.json and never touches the SPA files the StorageStack owns.
    const contentBucket = s3.Bucket.fromBucketName(this, 'ContentBucket', props.contentBucketName);
    // Import the distribution by id (not a live construct) so writing+invalidating
    // here does not create an Edge<->Chat cycle; EdgeStack is already upstream.
    const distribution = cloudfront.Distribution.fromDistributionAttributes(this, 'EdgeDistribution', {
      distributionId: props.distributionId,
      // domainName is required by the import API but unused for invalidation.
      domainName: cloudFrontDomainName,
    });
    new s3deploy.BucketDeployment(this, 'ChatConfigDeployment', {
      destinationBucket: contentBucket,
      destinationKeyPrefix: STORAGE_PREFIXES.webApplication,
      sources: [
        s3deploy.Source.jsonData('chat-config.json', {
          chatApiBaseUrl: api.url,
          allowedOrigin,
        }),
      ],
      prune: false,
      retainOnDelete: false,
      // Auto-invalidate the config at the edge so the SPA sees the new URL
      // immediately after a deploy (no manual CloudFront invalidation needed).
      // distributionPaths are PUBLIC URL paths, not S3 keys: the distribution's
      // origin path is `/web_application`, so the object lives at the public
      // path `/chat-config.json`.
      distribution,
      distributionPaths: ['/chat-config.json'],
    });

    new CfnOutput(this, 'ChatSubmitEndpoint', {
      // Full invoke URL for a chat submit, e.g.
      // https://<id>.execute-api.<region>.amazonaws.com/<stage>/chat (POST).
      value: `${api.url}chat`,
      description: 'Public API Gateway URL to submit a concierge chat turn (POST /chat -> 202 {jobId})',
      exportName: `${prefix}-chat-submit-endpoint`,
    });
    new CfnOutput(this, 'ChatApiBaseUrl', {
      // Base stage URL; poll at `${base}chat/{jobId}` (GET).
      value: api.url,
      description: 'Base URL of the concierge chat API (poll at chat/{jobId})',
      exportName: `${prefix}-chat-api-base-url`,
    });
    new CfnOutput(this, 'ChatFunctionName', {
      value: worker.functionName,
      description: 'Name of the on-site concierge chat worker Lambda',
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
          'The chat Lambdas use the AWS-managed AWSLambdaBasicExecutionRole for ' +
          'CloudWatch logging (no VPC exec role — these functions are outside ' +
          'the VPC). This matches the standard least-privilege baseline.',
        appliesTo: [
          'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
        ],
      },
      {
        id: 'AwsSolutions-IAM5',
        reason:
          'Scoped wildcards only: (a) the bedrock-agentcore:InvokeHarness / ' +
          'InvokeAgentRuntime grant is scoped to exactly one harness ARN; ' +
          '(b) grantReadData/grantWriteData expand to the single jobs table ' +
          'plus its CDK-generated `.../index/*` suffix (no indexes are defined); ' +
          '(c) grantInvoke resolves to the single worker function ARN plus the ' +
          '`:*` version-qualifier form; (d) the CDK-managed BucketDeployment ' +
          'helper Lambda (ChatConfigDeployment) needs wildcard S3 access to read ' +
          'the staged asset and write chat-config.json to the content bucket, ' +
          'scoped to those buckets, plus cloudfront:CreateInvalidation (which ' +
          'CloudFront does not support at resource level) to flush the config at ' +
          'the edge. All are CDK-generated scoped wildcards.',
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
          'Request validation is handled inside the chat Lambdas (JSON parse, ' +
          'non-empty message, length cap); the endpoints are thin proxies to ' +
          'the job store / harness and do not use model-based request validation.',
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
          'locked to the CloudFront origin and the Lambdas self-validate input.',
      },
      {
        id: 'AwsSolutions-COG4',
        reason:
          'No Cognito user pool authorizer: the chat endpoint is intentionally ' +
          'public for the on-site widget, consistent with the data API.',
      },
      {
        id: 'AwsSolutions-DDB3',
        reason:
          'The chat jobs table is an ephemeral request/response scratch store ' +
          'with a ~1h TTL; jobs are transient and DESTROY-gated. Point-in-time ' +
          'recovery is unnecessary for this throwaway data.',
      },
    ]);
  }

  /**
   * Create the CloudWatch log group for a Lambda explicitly, with a DESTROY
   * removal policy (unless retainData), so `cdk destroy` removes it and a
   * later `cdk deploy` does not fail with "log group already exists". Mirrors
   * the BlogApi `logGroupFor` pattern, gated on retainData per the task.
   */
  private logGroupFor(id: string, functionName: string, retainData: boolean): logs.LogGroup {
    return new logs.LogGroup(this, id, {
      logGroupName: `/aws/lambda/${functionName}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: retainData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });
  }
}
