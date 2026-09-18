import { Construct } from 'constructs';

/**
 * Props for {@link BlogDistribution}.
 * TODO: add contentBucket, apiEndpoint, domain/cert, WAF toggle.
 */
export interface BlogDistributionProps {
  readonly prefix: string;
}

/**
 * BlogDistribution — CloudFront distribution for the blog.
 *
 * TODO (flesh out later):
 *  - Distribution with S3 (OAC) default behavior + API path behavior
 *  - Cache + response-headers (security headers) policies, TLS cert
 *  - Optional WAF web ACL, custom domain + Route 53 alias
 *  - Access logging to the data-lake bucket
 */
export class BlogDistribution extends Construct {
  // public readonly distributionDomainName: string;

  constructor(scope: Construct, id: string, _props: BlogDistributionProps) {
    super(scope, id);
    // Placeholder.
  }
}
