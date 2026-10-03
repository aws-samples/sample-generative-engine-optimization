/*
 * Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as athena from 'aws-cdk-lib/aws-athena';
import * as glue from 'aws-cdk-lib/aws-glue';
import type { Construct } from 'constructs';
import { STORAGE_PREFIXES } from '../config/index.js';
import type { BaseStackProps } from './stack-props.js';

/** Props for {@link AnalyticsStack}. */
export interface AnalyticsStackProps extends BaseStackProps {
  /**
   * Name of the content bucket (from the StorageStack). Only the name is used
   * (to build Glue/Athena S3 location strings), so it is passed as a plain
   * string rather than a live construct, avoiding a Storage<->Analytics cycle.
   */
  readonly contentBucketName: string;
}

/**
 * The 33 CloudFront standard-log fields, in the exact order CloudFront writes
 * them to the tab-separated access-log files. Order and types must match the
 * log layout for Athena to parse the columns correctly.
 */
const CLOUDFRONT_LOG_COLUMNS: ReadonlyArray<{ name: string; type: string }> = [
  { name: 'date', type: 'date' },
  { name: 'time', type: 'string' },
  { name: 'x_edge_location', type: 'string' },
  { name: 'sc_bytes', type: 'bigint' },
  { name: 'c_ip', type: 'string' },
  { name: 'cs_method', type: 'string' },
  { name: 'cs_host', type: 'string' },
  { name: 'cs_uri_stem', type: 'string' },
  { name: 'sc_status', type: 'int' },
  { name: 'cs_referer', type: 'string' },
  { name: 'cs_user_agent', type: 'string' },
  { name: 'cs_uri_query', type: 'string' },
  { name: 'cs_cookie', type: 'string' },
  { name: 'x_edge_result_type', type: 'string' },
  { name: 'x_edge_request_id', type: 'string' },
  { name: 'x_host_header', type: 'string' },
  { name: 'cs_protocol', type: 'string' },
  { name: 'cs_bytes', type: 'bigint' },
  { name: 'time_taken', type: 'float' },
  { name: 'x_forwarded_for', type: 'string' },
  { name: 'ssl_protocol', type: 'string' },
  { name: 'ssl_cipher', type: 'string' },
  { name: 'x_edge_response_result_type', type: 'string' },
  { name: 'cs_protocol_version', type: 'string' },
  { name: 'fle_status', type: 'string' },
  { name: 'fle_encrypted_fields', type: 'int' },
  { name: 'c_port', type: 'int' },
  { name: 'time_to_first_byte', type: 'float' },
  { name: 'x_edge_detailed_result_type', type: 'string' },
  { name: 'sc_content_type', type: 'string' },
  { name: 'sc_content_len', type: 'bigint' },
  { name: 'sc_range_start', type: 'bigint' },
  { name: 'sc_range_end', type: 'bigint' },
];

/**
 * Saved AI-crawler detection queries over the `cloudfront_logs` table. Deployed
 * as Athena named queries on the analytics workgroup so operators can run them
 * from the console and so they are version-controlled alongside the table.
 */
const AI_CRAWLER_QUERIES: ReadonlyArray<{ name: string; description: string; sql: string }> = [
  {
    name: 'ai-crawler-daily-summary',
    description: 'Query 1: Daily AI crawler traffic summary — which AI crawlers visited and how many requests per day.',
    sql: `SELECT
  "date" AS day,
  CASE
    WHEN cs_user_agent LIKE '%GPTBot%'          THEN 'GPTBot (OpenAI)'
    WHEN cs_user_agent LIKE '%ChatGPT-User%'    THEN 'ChatGPT-User (OpenAI)'
    WHEN cs_user_agent LIKE '%ClaudeBot%'       THEN 'ClaudeBot (Anthropic)'
    WHEN cs_user_agent LIKE '%PerplexityBot%'   THEN 'PerplexityBot'
    WHEN cs_user_agent LIKE '%Google-Extended%' THEN 'Google-Extended'
    WHEN cs_user_agent LIKE '%Amazonbot%'       THEN 'Amazonbot (Amazon)'
    ELSE 'Other AI Crawler'
  END AS ai_crawler,
  COUNT(*) AS requests,
  COUNT(DISTINCT cs_uri_stem) AS unique_pages
FROM cloudfront_logs
WHERE cs_user_agent LIKE '%GPTBot%'
   OR cs_user_agent LIKE '%ChatGPT-User%'
   OR cs_user_agent LIKE '%ClaudeBot%'
   OR cs_user_agent LIKE '%PerplexityBot%'
   OR cs_user_agent LIKE '%Google-Extended%'
   OR cs_user_agent LIKE '%Amazonbot%'
GROUP BY 1, 2
ORDER BY 1 DESC, 3 DESC;`,
  },
  {
    name: 'ai-crawler-top-pages',
    description: 'Query 2: Most-visited pages by AI crawlers over the last 30 days — which content AI engines consume most.',
    sql: `SELECT
  cs_uri_stem AS page,
  COUNT(*) AS total_ai_requests,
  COUNT(DISTINCT CASE WHEN cs_user_agent LIKE '%GPTBot%' THEN 1 END) AS gptbot,
  COUNT(DISTINCT CASE WHEN cs_user_agent LIKE '%ClaudeBot%' THEN 1 END) AS claudebot,
  COUNT(DISTINCT CASE WHEN cs_user_agent LIKE '%PerplexityBot%' THEN 1 END) AS perplexitybot,
  COUNT(DISTINCT CASE WHEN cs_user_agent LIKE '%Google-Extended%' THEN 1 END) AS google_extended
FROM cloudfront_logs
WHERE (cs_user_agent LIKE '%GPTBot%'
    OR cs_user_agent LIKE '%ChatGPT-User%'
    OR cs_user_agent LIKE '%ClaudeBot%'
    OR cs_user_agent LIKE '%PerplexityBot%'
    OR cs_user_agent LIKE '%Google-Extended%'
    OR cs_user_agent LIKE '%Amazonbot%')
  AND "date" >= current_date - interval '30' day
GROUP BY 1
ORDER BY 2 DESC
LIMIT 50;`,
  },
  {
    name: 'ai-crawler-discoverability-gap',
    description: 'Query 3: Property pages NEVER visited by AI crawlers in the last 30 days — the discoverability gap.',
    sql: `SELECT DISTINCT cs_uri_stem AS page
FROM cloudfront_logs
WHERE cs_uri_stem LIKE '/properties/%'
  AND "date" >= current_date - interval '30' day
EXCEPT
SELECT DISTINCT cs_uri_stem
FROM cloudfront_logs
WHERE (cs_user_agent LIKE '%GPTBot%'
    OR cs_user_agent LIKE '%ClaudeBot%'
    OR cs_user_agent LIKE '%PerplexityBot%'
    OR cs_user_agent LIKE '%Google-Extended%'
    OR cs_user_agent LIKE '%Amazonbot%')
  AND "date" >= current_date - interval '30' day;`,
  },
  {
    name: 'ai-crawler-weekly-trend',
    description: 'Query 4: Week-over-week AI crawler trend over the last 90 days — for dashboards/alerting on traffic shifts.',
    sql: `SELECT
  date_trunc('week', "date") AS week,
  COUNT(*) AS ai_crawler_requests,
  COUNT(DISTINCT cs_uri_stem) AS unique_pages_crawled
FROM cloudfront_logs
WHERE (cs_user_agent LIKE '%GPTBot%'
    OR cs_user_agent LIKE '%ChatGPT-User%'
    OR cs_user_agent LIKE '%ClaudeBot%'
    OR cs_user_agent LIKE '%PerplexityBot%'
    OR cs_user_agent LIKE '%Google-Extended%'
    OR cs_user_agent LIKE '%Amazonbot%')
  AND "date" >= current_date - interval '90' day
GROUP BY 1
ORDER BY 1 DESC;`,
  },
];

/**
 * AnalyticsStack — Athena analytics over the CloudFront access logs in S3.
 *
 * Owns:
 *  - a Glue database and an EXTERNAL table over the `logs/cf_logs/` prefix of
 *    the content bucket, modeling the 33 CloudFront standard-log fields; and
 *  - an Athena workgroup whose query results land in `logs/athena_logs/`.
 *
 * The content bucket is referenced by NAME only (to build the S3 location
 * strings); nothing is granted on it here, so there is no Storage<->Analytics
 * dependency cycle.
 */
export class AnalyticsStack extends Stack {
  /** Glue database name (for wiring/tests). */
  public readonly glueDatabaseName: string;
  /** Glue table name (for wiring/tests). */
  public readonly glueTableName: string;
  /** Athena workgroup name (for wiring/tests). */
  public readonly workgroupName: string;

  constructor(scope: Construct, id: string, props: AnalyticsStackProps) {
    super(scope, id, props);

    const { config, contentBucketName } = props;
    const databaseName = config.analytics.databaseName;
    const tableName = config.analytics.tableName;
    const workgroupName = config.analytics.workgroupName;

    // Glue table Location must NOT have a trailing slash; Athena output
    // location KEEPS the trailing slash.
    const glueLocation = `s3://${contentBucketName}/${STORAGE_PREFIXES.cloudFrontLogs}`.replace(
      /\/$/,
      '',
    );
    const athenaOutput = `s3://${contentBucketName}/${STORAGE_PREFIXES.athenaResults}`;

    const removal = config.retainData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

    const database = new glue.CfnDatabase(this, 'LogsDatabase', {
      catalogId: Stack.of(this).account,
      databaseInput: { name: databaseName },
    });
    database.applyRemovalPolicy(removal);

    const table = new glue.CfnTable(this, 'CloudFrontLogsTable', {
      catalogId: Stack.of(this).account,
      databaseName,
      tableInput: {
        name: tableName,
        tableType: 'EXTERNAL_TABLE',
        parameters: {
          'skip.header.line.count': '2',
          EXTERNAL: 'TRUE',
        },
        storageDescriptor: {
          columns: CLOUDFRONT_LOG_COLUMNS.map((c) => ({ name: c.name, type: c.type })),
          location: glueLocation,
          inputFormat: 'org.apache.hadoop.mapred.TextInputFormat',
          outputFormat: 'org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat',
          compressed: false,
          serdeInfo: {
            serializationLibrary: 'org.apache.hadoop.hive.serde2.lazy.LazySimpleSerDe',
            parameters: {
              'serialization.format': '\t',
              'field.delim': '\t',
            },
          },
        },
      },
    });
    // The table lives inside the database; make the ordering explicit on the L1
    // so CloudFormation creates the database before the table (DependsOn).
    table.addResourceDependency(database);
    table.applyRemovalPolicy(removal);

    const workgroup = new athena.CfnWorkGroup(this, 'AnalyticsWorkGroup', {
      name: workgroupName,
      recursiveDeleteOption: true,
      workGroupConfiguration: {
        enforceWorkGroupConfiguration: true,
        publishCloudWatchMetricsEnabled: true,
        engineVersion: { selectedEngineVersion: 'AUTO' },
        resultConfiguration: { outputLocation: athenaOutput },
      },
    });
    workgroup.applyRemovalPolicy(removal);

    // Saved AI-crawler detection queries, attached to the workgroup + database
    // so they are deployed, version-controlled, and runnable from the Athena
    // console. They validate the cloudfront_logs table (verified live: the
    // seeded sample logs contain GPTBot/ClaudeBot/PerplexityBot traffic).
    // NOTE: the queries that filter `"date" >= current_date - interval 'N' day`
    // only return rows within that window; the seeded sample logs are dated
    // earlier, so widen the window (or remove the date filter) to see sample
    // data in a demo.
    AI_CRAWLER_QUERIES.forEach((nq, i) => {
      const named = new athena.CfnNamedQuery(this, `AiCrawlerQuery${i + 1}`, {
        database: databaseName,
        workGroup: workgroupName,
        name: `${config.prefix}-${nq.name}`,
        description: nq.description,
        queryString: nq.sql,
      });
      named.addDependency(workgroup);
      named.addDependency(table);
    });

    this.glueDatabaseName = databaseName;
    this.glueTableName = tableName;
    this.workgroupName = workgroupName;
  }
}
