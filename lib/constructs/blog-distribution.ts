import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { STORAGE_PREFIXES, type EdgeConfig } from '../config/index.js';

const PRICE_CLASS: Record<EdgeConfig['priceClass'], cloudfront.PriceClass> = {
  all: cloudfront.PriceClass.PRICE_CLASS_ALL,
  '200': cloudfront.PriceClass.PRICE_CLASS_200,
  '100': cloudfront.PriceClass.PRICE_CLASS_100,
};

/** Props for {@link BlogDistribution}. */
export interface BlogDistributionProps {
  /** Resource-name prefix (e.g. `geo-demo-dev`). */
  readonly prefix: string;
  /** Edge settings resolved from the environment config. */
  readonly edge: EdgeConfig;
  /** The content bucket (from the storage layer). */
  readonly contentBucket: s3.IBucket;
  /**
   * The API Gateway origin domain (host only, no scheme/path), e.g.
   * `abc123.execute-api.us-east-1.amazonaws.com`.
   */
  readonly apiOriginDomain: string;
  /** The API stage name, used as the origin path for the API behavior. */
  readonly apiStageName: string;
}

/**
 * BlogDistribution — the CloudFront distribution for the GEO app.
 *
 * - **Default behavior** → S3 content bucket via **Origin Access Control**
 *   (OAC), origin path = the `web_application/` prefix, `index.html` root.
 *   Cached with the managed CachingOptimized policy; HTTPS-only.
 * - **`/api/*` behavior** → the API Gateway origin (no caching, forward all
 *   viewer headers except Host), so external agents reach the REST API through
 *   the same domain.
 * - **Standard access logging** to the content bucket under `logs/cf_logs/`
 *   (requires bucket ACLs, which the StorageStack enables).
 */
export class BlogDistribution extends Construct {
  public readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: BlogDistributionProps) {
    super(scope, id);

    const { prefix, edge, contentBucket, apiOriginDomain, apiStageName } = props;

    // S3 origin via OAC, scoped to the web_application/ prefix.
    const s3Origin = origins.S3BucketOrigin.withOriginAccessControl(contentBucket, {
      originPath: `/${STORAGE_PREFIXES.webApplication.replace(/\/$/, '')}`,
    });

    // API Gateway origin (HTTPS custom origin). Stage name is the origin path.
    const apiOrigin = new origins.HttpOrigin(apiOriginDomain, {
      originPath: `/${apiStageName}`,
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
    });

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `${prefix} — Octank Hospitality (SPA + API)`,
      defaultRootObject: edge.defaultRootObject,
      priceClass: PRICE_CLASS[edge.priceClass],
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      // Note: minimumProtocolVersion has no effect with the default CloudFront
      // certificate (fixed at TLSv1); set it alongside a custom domain + cert.
      // Standard access logs -> content bucket under logs/cf_logs/.
      enableLogging: true,
      logBucket: contentBucket,
      logFilePrefix: STORAGE_PREFIXES.cloudFrontLogs,
      defaultBehavior: {
        origin: s3Origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
      },
      additionalBehaviors: {
        [edge.apiPathPattern]: {
          origin: apiOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
      },
    });
  }

  /** The distribution id (for the promoter's CloudFront invalidations). */
  public get distributionId(): string {
    return this.distribution.distributionId;
  }

  /** The distribution domain name (e.g. dxxxx.cloudfront.net). */
  public get domainName(): string {
    return this.distribution.distributionDomainName;
  }
}
