import * as path from 'node:path';
import { Duration, RemovalPolicy } from 'aws-cdk-lib';
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
      code: lambda.Code.fromAsset(codeDir('citation-tracker')),
      timeout: Duration.seconds(compute.citationTimeoutSeconds),
      environment: {
        CONTENT_BUCKET: contentBucket.bucketName,
        BEDROCK_MODEL_ID: compute.bedrockModelId,
        CW_NAMESPACE: compute.metricsNamespace,
        STAGING_PREFIX: STORAGE_PREFIXES.staging,
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

    // --- patch-applier: read live content, write staging candidates --------
    this.patchApplier = new lambda.Function(this, 'PatchApplier', {
      ...commonProps,
      functionName: `${prefix}-patch-applier`,
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
          resources: ['*'],
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

    // Route tree discovered from the live REST API:
    //   GET  /properties
    //   GET  /properties/{propertyId}
    //   GET  /properties/{propertyId}/rates
    //   GET  /properties/{propertyId}/availability
    //   POST /reservations
    const properties = this.api.root.addResource('properties');
    properties.addMethod('GET', integration);

    const property = properties.addResource('{propertyId}');
    property.addMethod('GET', integration);
    property.addResource('rates').addMethod('GET', integration);
    property.addResource('availability').addMethod('GET', integration);

    const reservations = this.api.root.addResource('reservations');
    reservations.addMethod('POST', integration);

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
}
