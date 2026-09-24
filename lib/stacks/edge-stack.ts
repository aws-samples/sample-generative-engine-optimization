import { Annotations, CfnOutput, Stack } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { NagSuppressions } from 'cdk-nag';
import type { Construct } from 'constructs';
import { BlogDistribution } from '../constructs/blog-distribution.js';
import type { BaseStackProps } from './stack-props.js';

/** Props for {@link EdgeStack}. */
export interface EdgeStackProps extends BaseStackProps {
  /**
   * Name of the content bucket (from the StorageStack). Imported read-only here
   * rather than passed as a live construct, so the OAC/log wiring does not
   * create a Storage<->Edge dependency cycle.
   */
  readonly contentBucketName: string;
  /** API Gateway origin domain (host only) from the ComputeStack. */
  readonly apiOriginDomain: string;
  /** API Gateway stage name from the ComputeStack. */
  readonly apiStageName: string;
}

/**
 * EdgeStack — the CloudFront distribution for the GEO app.
 *
 * Serves the SPA from S3 (OAC) and routes `/api/*` to the API Gateway origin,
 * with standard access logging to the content bucket's `logs/cf_logs/` prefix,
 * via the {@link BlogDistribution} construct.
 */
export class EdgeStack extends Stack {
  private readonly blogDistribution: BlogDistribution;

  constructor(scope: Construct, id: string, props: EdgeStackProps) {
    super(scope, id, props);

    const { config, contentBucketName, apiOriginDomain, apiStageName } = props;

    // Import the bucket read-only: an imported IBucket's addToResourcePolicy is
    // a no-op, so `withOriginAccessControl` won't write a back-reference policy
    // into the StorageStack (the OAC read statement is added there explicitly).
    const contentBucket = s3.Bucket.fromBucketName(this, 'ContentBucket', contentBucketName);

    // Expected: CDK can't write the OAC policy on an imported bucket. We add it
    // in the StorageStack on purpose (to avoid a Storage<->Edge cycle), so this
    // warning is acknowledged rather than acted on.
    Annotations.of(this).acknowledgeWarning(
      '@aws-cdk/aws-cloudfront-origins:updateImportedBucketPolicyOac',
    );

    this.blogDistribution = new BlogDistribution(this, 'Edge', {
      prefix: config.prefix,
      edge: config.edge,
      contentBucket,
      apiOriginDomain,
      apiStageName,
    });

    new CfnOutput(this, 'DistributionId', {
      value: this.blogDistribution.distributionId,
      description: 'CloudFront distribution id',
      exportName: `${config.prefix}-distribution-id`,
    });

    new CfnOutput(this, 'DistributionDomainName', {
      value: this.blogDistribution.domainName,
      description: 'CloudFront distribution domain name',
      exportName: `${config.prefix}-distribution-domain`,
    });

    // cdk-nag: this demo distribution intentionally uses the default CloudFront
    // certificate/domain and no WAF. Documented for the demo scope.
    NagSuppressions.addStackSuppressions(this, [
      {
        id: 'AwsSolutions-CFR1',
        reason: 'Geo restrictions are not required for this public demo.',
      },
      {
        id: 'AwsSolutions-CFR2',
        reason: 'WAF integration is out of scope for the demo distribution.',
      },
      {
        id: 'AwsSolutions-CFR4',
        reason:
          'Using the default CloudFront certificate, which only supports TLSv1; ' +
          'a custom domain + cert (TLSv1.2_2021) is planned before production.',
      },
    ]);
  }

  /** The CloudFront distribution id (for the promoter's invalidations). */
  public get distributionId(): string {
    return this.blogDistribution.distributionId;
  }

  /** The CloudFront distribution domain name. */
  public get domainName(): string {
    return this.blogDistribution.domainName;
  }
}
