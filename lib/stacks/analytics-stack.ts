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

    this.glueDatabaseName = databaseName;
    this.glueTableName = tableName;
    this.workgroupName = workgroupName;
  }
}
