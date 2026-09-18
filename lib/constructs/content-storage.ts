import { Construct } from 'constructs';

/**
 * Props for {@link ContentStorage}.
 * TODO: add retainData, versioning, and lifecycle settings.
 */
export interface ContentStorageProps {
  readonly prefix: string;
  readonly retainData: boolean;
}

/**
 * ContentStorage — S3 buckets for the blog.
 *
 * TODO (flesh out later):
 *  - Private content bucket (OAC-accessed by CloudFront), versioned, SSE-KMS
 *  - Data-lake bucket for analytics + Athena query-results bucket
 *  - Access logging, TLS-only bucket policy, lifecycle rules
 *  - removalPolicy / autoDeleteObjects driven by retainData
 */
export class ContentStorage extends Construct {
  // public readonly contentBucket: s3.IBucket;
  // public readonly dataLakeBucket: s3.IBucket;
  // public readonly queryResultsBucket: s3.IBucket;

  constructor(scope: Construct, id: string, _props: ContentStorageProps) {
    super(scope, id);
    // Placeholder.
  }
}
