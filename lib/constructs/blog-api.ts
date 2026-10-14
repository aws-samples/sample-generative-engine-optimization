/*
 * Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { Aws, Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { STORAGE_PREFIXES, type ComputeConfig } from '../config/index.js';

/** Props for {@link BlogApi}. */
export interface BlogApiProps {
  /** Resource-name prefix (e.g. `geo-demo-dev`). */
  readonly prefix: string;
  /** Compute settings resolved from the environment config. */
  readonly compute: ComputeConfig;
  /** VPC the Lambdas run in (from the network layer). */
  readonly vpc: ec2.IVpc;
  /** Security group for the Lambdas (from the network layer). */
  readonly lambdaSecurityGroup: ec2.ISecurityGroup;
  /** The content bucket (from the storage layer). */
  readonly contentBucket: s3.IBucket;
  /** Aurora cluster ARN (for the RDS Data API). */
  readonly clusterArn: string;
  /** ARN of the Aurora credentials secret. */
  readonly dbSecretArn: string;
  /** Database name for the Data API. */
  readonly dbName: string;
  /**
   * CloudFront distribution id the promoter invalidates. Optional because the
   * EdgeStack is built later; when absent the promoter still deploys.
   */
  readonly distributionId?: string;
}

/** Directory holding the Lambda source folders (assets/code). */
function codeDir(subDir: string): string {
  return path.resolve(process.cwd(), 'assets', 'code', subDir);
}

/**
 * BlogApi — the four GEO Lambdas + public REST API for the hotel-booking app.
 *
 * Lambdas (python3.13, VPC-attached, least-privilege per-function role):
 *  - api-handler      : REST API backend, queries Aurora via the Data API
 *  - citation-tracker : Bedrock citation analysis, CloudWatch metrics
 *  - patch-applier    : reads live content, writes candidates to staging/
 *  - promoter         : promotes staging/ -> web_application/, invalidates CF
 *
 * A public regional REST API Gateway fronts api-handler with the discovered
 * route tree. Lambda proxy integration means the API reaches the function
 * through the Lambda service — the function's VPC attachment only governs its
 * outbound access (Aurora Data API, Secrets Manager, Bedrock, S3).
 */
export class BlogApi extends Construct {
  public readonly apiHandler: lambda.Function;
  public readonly citationTracker: lambda.Function;
  public readonly patchApplier: lambda.Function;
  public readonly promoter: lambda.Function;
  public readonly api: apigateway.RestApi;

  /** The invoke URL of the deployed API stage. */
  public readonly apiEndpoint: string;

  /** The API Gateway origin domain (host only) for a CloudFront origin. */
  public get apiOriginDomain(): string {
    return `${this.api.restApiId}.execute-api.${this.api.env.region}.amazonaws.com`;
  }

  constructor(scope: Construct, id: string, props: BlogApiProps) {
    super(scope, id);

    const {
      prefix,
      compute,
      vpc,
      lambdaSecurityGroup,
      contentBucket,
      clusterArn,
      dbSecretArn,
      dbName,
      distributionId,
    } = props;

    // All functions run in the private-egress subnets with the shared Lambda SG.
    const vpcSubnets: ec2.SubnetSelection = { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS };
    const commonProps = {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'lambda_function.lambda_handler',
      memorySize: compute.lambdaMemoryMb,
      vpc,
      vpcSubnets,
      securityGroups: [lambdaSecurityGroup],
    } satisfies Partial<lambda.FunctionProps>;

    // --- api-handler: queries Aurora via the RDS Data API ------------------
    this.apiHandler = new lambda.Function(this, 'ApiHandler', {
      ...commonProps,
      functionName: `${prefix}-api-handler`,
      logGroup: this.logGroupFor('ApiHandlerLogGroup', `${prefix}-api-handler`),
      code: lambda.Code.fromAsset(codeDir('api-handler')),
      timeout: Duration.seconds(compute.apiTimeoutSeconds),
      environment: {
        DB_CLUSTER_ARN: clusterArn,
        DB_SECRET_ARN: dbSecretArn,
        DB_NAME: dbName,
      },
    });
    this.apiHandler.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'RdsDataApiQuery',
        actions: ['rds-data:ExecuteStatement', 'rds-data:BatchExecuteStatement'],
        resources: [clusterArn],
      }),
    );
    this.apiHandler.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'ReadDbSecret',
        actions: ['secretsmanager:GetSecretValue'],
        resources: [dbSecretArn],
      }),
    );

    // --- citation-tracker: Bedrock + CloudWatch metrics --------------------
    this.citationTracker = new lambda.Function(this, 'CitationTracker', {
      ...commonProps,
      functionName: `${prefix}-citation-tracker`,
      logGroup: this.logGroupFor('CitationTrackerLogGroup', `${prefix}-citation-tracker`),
      code: lambda.Code.fromAsset(codeDir('citation-tracker')),
      timeout: Duration.seconds(compute.citationTimeoutSeconds),
      environment: {
        CONTENT_BUCKET: contentBucket.bucketName,
        BEDROCK_MODEL_ID: compute.bedrockModelId,
        CW_NAMESPACE: compute.metricsNamespace,
        STAGING_PREFIX: STORAGE_PREFIXES.staging,
        // Grounded scoring + deterministic property resolution read the live
        // property pages (and the staged candidate) from the content bucket.
        PROPERTIES_PREFIX: `${STORAGE_PREFIXES.webApplication}properties/`,
        SCORE_MODE: compute.citationScoreMode,
        PROMPTS_FILE: 'prompts.json',
      },
    });
    this.citationTracker.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'InvokeBedrockModel',
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: [
          'arn:aws:bedrock:*::foundation-model/anthropic.claude-*',
          `arn:aws:bedrock:*:${this.node.tryGetContext('account') ?? '*'}:inference-profile/global.anthropic.claude-*`,
        ],
      }),
    );
    this.addMetricsPolicy(this.citationTracker, compute.metricsNamespace);
    contentBucket.grantRead(this.citationTracker, `${STORAGE_PREFIXES.code}*`);
    // Grounded scoring + property resolution read live pages; the re-test
    // pass reads the staged candidate. Read-only, prefix-scoped.
    contentBucket.grantRead(this.citationTracker, `${STORAGE_PREFIXES.webApplication}*`);
    contentBucket.grantRead(this.citationTracker, `${STORAGE_PREFIXES.staging}*`);

    // --- patch-applier: read live content, write staging candidates --------
    this.patchApplier = new lambda.Function(this, 'PatchApplier', {
      ...commonProps,
      functionName: `${prefix}-patch-applier`,
      logGroup: this.logGroupFor('PatchApplierLogGroup', `${prefix}-patch-applier`),
      code: lambda.Code.fromAsset(codeDir('patch-applier')),
      timeout: Duration.seconds(compute.workerTimeoutSeconds),
      environment: {
        CONTENT_BUCKET: contentBucket.bucketName,
        STAGING_PREFIX: STORAGE_PREFIXES.staging,
        PROPERTIES_PREFIX: `${STORAGE_PREFIXES.webApplication}properties/`,
      },
    });
    contentBucket.grantRead(this.patchApplier, `${STORAGE_PREFIXES.webApplication}*`);
    contentBucket.grantReadWrite(this.patchApplier, `${STORAGE_PREFIXES.staging}*`);

    // --- promoter: promote staging -> live, invalidate CloudFront ----------
    this.promoter = new lambda.Function(this, 'Promoter', {
      ...commonProps,
      functionName: `${prefix}-promoter`,
      logGroup: this.logGroupFor('PromoterLogGroup', `${prefix}-promoter`),
      code: lambda.Code.fromAsset(codeDir('promoter')),
      timeout: Duration.seconds(compute.workerTimeoutSeconds),
      environment: {
        CONTENT_BUCKET: contentBucket.bucketName,
        ORIGIN_PATH_PREFIX: STORAGE_PREFIXES.webApplication,
        CW_NAMESPACE: compute.metricsNamespace,
        ...(distributionId ? { DISTRIBUTION_ID: distributionId } : {}),
      },
    });
    // Promote reviewed content into the live prefix, discard staged candidates.
    contentBucket.grantReadWrite(this.promoter, `${STORAGE_PREFIXES.webApplication}*`);
    contentBucket.grantReadWrite(this.promoter, `${STORAGE_PREFIXES.staging}*`);
    contentBucket.grantDelete(this.promoter, `${STORAGE_PREFIXES.staging}*`);
    this.addMetricsPolicy(this.promoter, compute.metricsNamespace);
    if (distributionId) {
      this.promoter.addToRolePolicy(
        new iam.PolicyStatement({
          sid: 'InvalidateDistribution',
          actions: ['cloudfront:CreateInvalidation'],
          // Scoped to exactly the one distribution the promoter invalidates
          // (the id is known here, passed via context). CloudFront ARNs are
          // partition/account-global with no region segment.
          resources: [
            `arn:${Aws.PARTITION}:cloudfront::${Aws.ACCOUNT_ID}:distribution/${distributionId}`,
          ],
        }),
      );
    }

    // --- Public regional REST API ------------------------------------------
    const accessLogGroup = new logs.LogGroup(this, 'ApiAccessLogs', {
      logGroupName: `/${prefix}/apigw/access`,
      retention: logs.RetentionDays.ONE_MONTH,
      // Destroy with the stack so a failed/rolled-back deploy doesn't orphan the
      // named log group and block a subsequent create.
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.api = new apigateway.RestApi(this, 'RestApi', {
      restApiName: `${prefix}-hospitality-api`,
      description: 'Octank Hospitality API — public entry point for GEO agents.',
      endpointTypes: [apigateway.EndpointType.REGIONAL],
      // Create + register the account-level CloudWatch Logs role that API
      // Gateway requires before any stage can enable logging. Without this the
      // stage fails: "CloudWatch Logs role ARN must be set in account settings".
      cloudWatchRole: true,
      deployOptions: {
        stageName: compute.apiStageName,
        throttlingRateLimit: compute.apiThrottleRateLimit,
        throttlingBurstLimit: compute.apiThrottleBurstLimit,
        accessLogDestination: new apigateway.LogGroupLogDestination(accessLogGroup),
        accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields(),
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        metricsEnabled: true,
      },
    });

    const integration = new apigateway.LambdaIntegration(this.apiHandler);

    // Each method declares methodResponses AND an operationName. The AgentCore
    // Gateway (AiStack) builds an api-gateway target by fetching and parsing the
    // API's EXPORTED OpenAPI spec, and it requires, per operation:
    //   - a `responses` object  → provided by methodResponses (OpenAPI 3.0
    //     requires it; a method without it exports an operation with none, and
    //     the parser rejects it: "...(get).responses is missing").
    //   - an `operationId`      → provided by operationName; the gateway uses it
    //     to name the derived MCP tool, and rejects operations without one
    //     ("...has no operationId and no override provided").
    // The operationName values are the MCP tool names the concierge harness
    // (AiStack system prompt) refers to.
    const responses: apigateway.MethodResponse[] = [
      { statusCode: '200' },
      { statusCode: '400' },
      { statusCode: '404' },
    ];
    const opts = (operationName: string): apigateway.MethodOptions => ({
      operationName,
      methodResponses: responses,
    });

    // Route tree discovered from the live REST API:
    //   GET  /properties                                → searchProperties
    //   GET  /properties/{propertyId}                   → getProperty
    //   GET  /properties/{propertyId}/rates             → getRates
    //   GET  /properties/{propertyId}/availability      → getAvailability
    //   POST /reservations                              → createReservation
    const properties = this.api.root.addResource('properties');
    properties.addMethod('GET', integration, opts('searchProperties'));

    const property = properties.addResource('{propertyId}');
    property.addMethod('GET', integration, opts('getProperty'));
    property.addResource('rates').addMethod('GET', integration, opts('getRates'));
    property.addResource('availability').addMethod('GET', integration, opts('getAvailability'));

    const reservations = this.api.root.addResource('reservations');
    reservations.addMethod('POST', integration, opts('createReservation'));

    this.apiEndpoint = this.api.url;
  }

  /** Grant scoped cloudwatch:PutMetricData for a specific metrics namespace. */
  private addMetricsPolicy(fn: lambda.Function, namespace: string): void {
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'PublishMetrics',
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
        conditions: { StringEquals: { 'cloudwatch:namespace': namespace } },
      }),
    );
  }

  /**
   * Create the CloudWatch log group for a Lambda explicitly, with a DESTROY
   * removal policy, so `cdk destroy` removes it and a subsequent `cdk deploy`
   * does not fail with "log group already exists". Without this, Lambda
   * auto-creates an unmanaged `/aws/lambda/<fn>` group that survives teardown.
   */
  private logGroupFor(id: string, functionName: string): logs.LogGroup {
    return new logs.LogGroup(this, id, {
      logGroupName: `/aws/lambda/${functionName}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });
  }
}
