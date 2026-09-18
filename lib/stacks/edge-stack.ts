import { Stack } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { BaseStackProps } from './stack-props.js';

/**
 * EdgeStack — CloudFront distribution for the blog platform.
 *
 * Responsibility: the public entry point. Serves static content from the S3
 * content bucket via Origin Access Control and routes API paths to the compute
 * origin (API Gateway / function URL).
 *
 * TODO (flesh out later):
 *  - CloudFront distribution with S3 (OAC) + API behaviors
 *  - Cache policies, response-headers policy (security headers), TLS cert
 *  - Optional WAF web ACL, custom domain + Route 53 alias
 *  - Access logs delivered to the StorageStack data-lake bucket
 *
 * Depends on: StorageStack (content bucket), ComputeStack (API origin).
 *
 * Note: some CloudFront features (Lambda@Edge, ACM certs) require us-east-1.
 */
export interface EdgeStackProps extends BaseStackProps {
  // readonly contentBucket: s3.IBucket;
  // readonly apiEndpoint: string;
}

export class EdgeStack extends Stack {
  // public readonly distributionDomainName: string;

  constructor(scope: Construct, id: string, props: EdgeStackProps) {
    super(scope, id, props);

    // Placeholder — CloudFront distribution will be added here.
    void props.config;
  }
}
