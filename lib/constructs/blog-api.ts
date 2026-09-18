import { Construct } from 'constructs';

/**
 * Props for {@link BlogApi}.
 * TODO: add vpc, dbSecret, contentBucket, agent ids, and runtime settings.
 */
export interface BlogApiProps {
  readonly prefix: string;
}

/**
 * BlogApi — Lambda functions + API surface for the blog.
 *
 * TODO (flesh out later):
 *  - NodejsFunction handlers (posts, comments, search, AI assist)
 *  - HTTP API (API Gateway v2) or function URL as the CloudFront origin
 *  - VPC attachment + SG for Aurora / RDS Proxy access
 *  - IAM grants to S3, Secrets Manager, Bedrock; env-var wiring
 */
export class BlogApi extends Construct {
  // public readonly apiEndpoint: string;
  // public readonly functions: lambda.IFunction[];

  constructor(scope: Construct, id: string, _props: BlogApiProps) {
    super(scope, id);
    // Placeholder.
  }
}
