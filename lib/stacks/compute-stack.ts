import { Stack } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { BaseStackProps } from './stack-props.js';

/**
 * ComputeStack — Lambda functions + API surface for the blog platform.
 *
 * Responsibility: the application backend. Lambda functions that read/write
 * Aurora, call the Bedrock agent, and serve the API behind CloudFront.
 *
 * TODO (flesh out later):
 *  - Lambda functions (Node.js) for the blog API (CRUD posts, comments, search)
 *  - API Gateway (HTTP API) or Lambda function URLs as the origin
 *  - VPC attachment + SG so functions can reach Aurora / RDS Proxy
 *  - IAM grants to S3, Secrets Manager, and Bedrock
 *  - Env vars wiring DB secret ARN, bucket names, agent id
 *
 * Depends on: NetworkStack, DatabaseStack, StorageStack, AiStack.
 */
export interface ComputeStackProps extends BaseStackProps {
  // readonly vpc: ec2.IVpc;
  // readonly dbSecret: secretsmanager.ISecret;
  // readonly contentBucket: s3.IBucket;
}

export class ComputeStack extends Stack {
  // public readonly apiEndpoint: string;

  constructor(scope: Construct, id: string, props: ComputeStackProps) {
    super(scope, id, props);

    // Placeholder — Lambda functions + API will be added here.
    void props.config;
  }
}
