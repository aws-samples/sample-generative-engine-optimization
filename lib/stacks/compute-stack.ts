import { CfnOutput, Stack } from 'aws-cdk-lib';
import type * as ec2 from 'aws-cdk-lib/aws-ec2';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import { NagSuppressions } from 'cdk-nag';
import type { Construct } from 'constructs';
import { BlogApi } from '../constructs/blog-api.js';
import type { BaseStackProps } from './stack-props.js';

/**
 * Props for {@link ComputeStack}. Consumes network, storage, and database
 * references (cross-stack, passed in `bin/app.ts`).
 */
export interface ComputeStackProps extends BaseStackProps {
  /** VPC from the NetworkStack. */
  readonly vpc: ec2.IVpc;
  /** Lambda security group from the NetworkStack. */
  readonly lambdaSecurityGroup: ec2.ISecurityGroup;
  /** Content bucket from the StorageStack. */
  readonly contentBucket: s3.IBucket;
  /** Aurora cluster ARN from the DatabaseStack (RDS Data API). */
  readonly clusterArn: string;
  /** Aurora credentials secret ARN from the DatabaseStack. */
  readonly dbSecretArn: string;
  /** CloudFront distribution id the promoter invalidates (optional). */
  readonly distributionId?: string;
}

/**
 * ComputeStack — the GEO Lambdas + public REST API for the hotel-booking app.
 *
 * Owns the four Python Lambdas (VPC-attached, least-privilege) and the public
 * regional REST API Gateway via the {@link BlogApi} construct.
 */
export class ComputeStack extends Stack {
  private readonly blogApi: BlogApi;

  constructor(scope: Construct, id: string, props: ComputeStackProps) {
    super(scope, id, props);

    const { config, vpc, lambdaSecurityGroup, contentBucket, clusterArn, dbSecretArn, distributionId } =
      props;

    this.blogApi = new BlogApi(this, 'Api', {
      prefix: config.prefix,
      compute: config.compute,
      vpc,
      lambdaSecurityGroup,
      contentBucket,
      clusterArn,
      dbSecretArn,
      dbName: config.database.dbName,
      distributionId,
    });

    new CfnOutput(this, 'ApiEndpoint', {
      value: this.blogApi.apiEndpoint,
      description: 'Public invoke URL of the Octank Hospitality API',
      exportName: `${config.prefix}-api-endpoint`,
    });

    // cdk-nag: acknowledged posture for this compute layer.
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
          'Lambda functions use the AWS-managed AWSLambdaBasicExecutionRole and ' +
          'AWSLambdaVPCAccessExecutionRole for logging and VPC ENI management, ' +
          'matching the discovered least-privilege baseline.',
        appliesTo: [
          'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
          'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole',
        ],
      },
      {
        id: 'AwsSolutions-IAM5',
        reason:
          'Scoped wildcards: Bedrock model-family ARNs, PutMetricData (namespace-' +
          'conditioned), CloudFront CreateInvalidation, and prefix-scoped S3 grants ' +
          'required by the worker functions.',
      },
      {
        id: 'AwsSolutions-APIG2',
        reason:
          'Request validation is handled in the api-handler; the public API is a ' +
          'proxy for AI agents and does not use model-based request validation.',
      },
      {
        id: 'AwsSolutions-APIG3',
        reason:
          'WAF association is planned at the CloudFront edge (EdgeStack) rather ' +
          'than per-API for this demo scope.',
      },
      {
        id: 'AwsSolutions-APIG4',
        reason:
          'The API is intentionally public and unauthenticated so external AI ' +
          'engines (ChatGPT, Perplexity) can call it, per the project design.',
      },
      {
        id: 'AwsSolutions-COG4',
        reason:
          'No Cognito user pool authorizer: the API is intentionally public for ' +
          'external AI-engine access.',
      },
    ]);
  }

  /** Public invoke URL of the API. */
  public get apiEndpoint(): string {
    return this.blogApi.apiEndpoint;
  }
}
