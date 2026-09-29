import { Construct } from 'constructs';

/**
 * Props for {@link BlogAnalytics}.
 * TODO: add dataLakeBucket, queryResultsBucket, table schemas.
 */
export interface BlogAnalyticsProps {
  readonly prefix: string;
}

/**
 * BlogAnalytics — Glue catalog + Athena workgroup over blog data.
 *
 * TODO (flesh out later):
 *  - Glue database + tables (or crawler) over the data-lake bucket
 *  - Athena workgroup with dedicated, encrypted query-results location
 *  - Named queries for common blog reports (top posts, traffic, etc.)
 */
export class BlogAnalytics extends Construct {
  // public readonly workgroupName: string;
  // public readonly glueDatabaseName: string;

  constructor(scope: Construct, id: string, _props: BlogAnalyticsProps) {
    super(scope, id);
    // Placeholder.
  }
}
