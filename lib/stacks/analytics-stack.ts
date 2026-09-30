import { Stack } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { BaseStackProps } from './stack-props.js';

/**
 * AnalyticsStack — Athena analytics over blog data in S3.
 *
 * Responsibility: querying the data-lake bucket (access logs, page-view events,
 * exported content) with Athena for reporting and dashboards.
 *
 * TODO (flesh out later):
 *  - Glue database + tables (or crawler) over the data-lake bucket
 *  - Athena workgroup with a dedicated query-results location + encryption
 *  - Named queries for common blog analytics (top posts, traffic, etc.)
 *
 * Depends on: StorageStack (data-lake + query-results buckets).
 */
// Placeholder: no extra props yet. A type alias (not an empty interface) keeps
// the named type for future extension without tripping no-empty-object-type.
export type AnalyticsStackProps = BaseStackProps;

export class AnalyticsStack extends Stack {
  // public readonly workgroupName: string;
  // public readonly glueDatabaseName: string;

  constructor(scope: Construct, id: string, props: AnalyticsStackProps) {
    super(scope, id, props);

    // Placeholder — Athena workgroup + Glue catalog will be added here.
    void props.config;
  }
}
