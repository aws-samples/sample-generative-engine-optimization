/*
 * Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT-0
 */

import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { getConfig, type AppConfig } from '../../lib/config/index.js';
import { StorageStack, AnalyticsStack } from '../../lib/stacks/index.js';
import { TEST_ENV } from './helpers.js';

function synth(context: Record<string, unknown> = {}): Template {
  const app = new App({ context });
  const config: AppConfig = { ...getConfig(app), env: TEST_ENV };
  const storage = new StorageStack(app, 'test-storage', { env: config.env, config });
  const analytics = new AnalyticsStack(app, 'test-analytics', {
    env: config.env,
    config,
    contentBucketName: storage.bucket.bucketName,
  });
  return Template.fromStack(analytics);
}

describe('AnalyticsStack (Glue + Athena)', () => {
  const template = synth();

  it('creates a single Glue database with the expected name', () => {
    template.resourceCountIs('AWS::Glue::Database', 1);
    template.hasResourceProperties('AWS::Glue::Database', {
      DatabaseInput: Match.objectLike({ Name: 'geo_demo_dev_logs' }),
    });
  });

  it('creates the cloudfront_logs table with 33 columns and the LazySimpleSerDe', () => {
    template.hasResourceProperties('AWS::Glue::Table', {
      TableInput: Match.objectLike({
        Name: 'cloudfront_logs',
        TableType: 'EXTERNAL_TABLE',
        Parameters: Match.objectLike({ 'skip.header.line.count': '2' }),
        StorageDescriptor: Match.objectLike({
          SerdeInfo: Match.objectLike({
            SerializationLibrary: 'org.apache.hadoop.hive.serde2.lazy.LazySimpleSerDe',
          }),
        }),
      }),
    });

    const tables = template.findResources('AWS::Glue::Table');
    const cols = Object.values(tables)[0].Properties.TableInput.StorageDescriptor.Columns;
    // The enumerated CloudFront standard-log schema has 33 fields.
    expect(cols).toHaveLength(33);
    expect(cols[0]).toMatchObject({ Name: 'date', Type: 'date' });
    expect(cols[cols.length - 1]).toMatchObject({ Name: 'sc_range_end', Type: 'bigint' });
  });

  it('creates the Athena workgroup with the expected name and config', () => {
    template.resourceCountIs('AWS::Athena::WorkGroup', 1);
    template.hasResourceProperties('AWS::Athena::WorkGroup', {
      Name: 'geo-demo-dev-analytics',
      RecursiveDeleteOption: true,
      WorkGroupConfiguration: Match.objectLike({
        EnforceWorkGroupConfiguration: true,
        PublishCloudWatchMetricsEnabled: true,
        EngineVersion: Match.objectLike({ SelectedEngineVersion: 'AUTO' }),
      }),
    });
  });

  it('points the Athena output location at logs/athena_logs/', () => {
    // The bucket name is a CloudFormation token, so OutputLocation is an
    // Fn::Join; assert its trailing literal keeps the athena_logs prefix.
    const workgroups = template.findResources('AWS::Athena::WorkGroup');
    const outputLocation = Object.values(workgroups)[0].Properties.WorkGroupConfiguration
      .ResultConfiguration.OutputLocation as { 'Fn::Join': [string, unknown[]] };
    const parts = outputLocation['Fn::Join'][1];
    expect(parts[parts.length - 1]).toBe('/logs/athena_logs/');
  });

  it('saves the four AI-crawler detection queries as named queries', () => {
    template.resourceCountIs('AWS::Athena::NamedQuery', 4);
    for (const name of [
      'geo-demo-dev-ai-crawler-daily-summary',
      'geo-demo-dev-ai-crawler-top-pages',
      'geo-demo-dev-ai-crawler-discoverability-gap',
      'geo-demo-dev-ai-crawler-weekly-trend',
    ]) {
      template.hasResourceProperties('AWS::Athena::NamedQuery', {
        Name: name,
        Database: 'geo_demo_dev_logs',
        WorkGroup: 'geo-demo-dev-analytics',
      });
    }
    // The queries target the cloudfront_logs table and detect known AI bots.
    const queries = template.findResources('AWS::Athena::NamedQuery');
    for (const q of Object.values(queries)) {
      expect(q.Properties.QueryString).toContain('cloudfront_logs');
    }
  });
});
