/*
 * Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT-0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { App, Stack } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { getConfig, type AppConfig } from '../../lib/config/index.js';
import { ContentStorage } from '../../lib/constructs/content-storage.js';
import { TEST_ENV, expectedContentBucketName } from './helpers.js';

function cfg(context: Record<string, unknown> = {}): AppConfig {
  const app = new App({ context });
  return { ...getConfig(app), env: TEST_ENV };
}

function synth(opts: {
  retainData?: boolean;
  assetsDir?: string;
  distributionId?: string;
  context?: Record<string, unknown>;
} = {}): Template {
  const app = new App({ context: opts.context });
  const c: AppConfig = { ...getConfig(app), env: TEST_ENV };
  const host = new Stack(app, 'test-storage-host', { env: c.env });
  new ContentStorage(host, 'ContentStorage', {
    prefix: 'geo-demo-dev',
    storage: c.storage,
    retainData: opts.retainData ?? false,
    assetsDir: opts.assetsDir,
    distributionId: opts.distributionId,
  });
  return Template.fromStack(host);
}

describe('ContentStorage construct', () => {
  const template = synth();

  it('creates exactly one bucket with the deterministic name', () => {
    template.resourceCountIs('AWS::S3::Bucket', 1);
    // Assert the COMPUTED name (prefix-content-account-region), not a hard-coded
    // literal, so no copy-pasteable/squattable bucket name lives in the source.
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: expectedContentBucketName('geo-demo-dev', TEST_ENV),
    });
  });

  it('applies secure defaults: S3-managed encryption, block-all-public, versioning', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } },
        ],
      },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      VersioningConfiguration: { Status: 'Enabled' },
      OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerPreferred' }] },
    });
  });

  it('self-logs S3 server access to logs/s3/', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      LoggingConfiguration: { LogFilePrefix: 'logs/s3/' },
    });
  });

  it('enforces TLS-only AND adds the CloudFront OAC read policy (web_application only)', () => {
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Deny',
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          }),
          Match.objectLike({
            Sid: 'AllowCloudFrontOacRead',
            Effect: 'Allow',
            Action: 's3:GetObject',
            Principal: { Service: 'cloudfront.amazonaws.com' },
            Condition: Match.objectLike({
              StringEquals: Match.objectLike({ 'AWS:SourceAccount': Match.anyValue() }),
              ArnLike: Match.objectLike({ 'AWS:SourceArn': Match.anyValue() }),
            }),
          }),
        ]),
      },
    });
  });

  it('scopes the OAC SourceArn to the SPECIFIC distribution when its id is known', () => {
    // Least-privilege: once the distribution id is supplied, the OAC read grant
    // pins to that distribution's ARN rather than an account-wide
    // `distribution/*` wildcard.
    const t = synth({ distributionId: 'E1234567890ABC' });
    t.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'AllowCloudFrontOacRead',
            Condition: Match.objectLike({
              ArnLike: {
                'AWS:SourceArn': {
                  'Fn::Join': Match.arrayWith([
                    Match.arrayWith([Match.stringLikeRegexp('distribution/E1234567890ABC$')]),
                  ]),
                },
              },
            }),
          }),
        ]),
      },
    });
  });

  it('defines the per-prefix lifecycle rules', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({ Id: 'expire-logs', Prefix: 'logs/' }),
          Match.objectLike({ Id: 'expire-athena-results', Prefix: 'logs/athena_logs/' }),
          Match.objectLike({
            Id: 'web-application-ia-transition',
            Prefix: 'web_application/',
            Transitions: Match.arrayWith([Match.objectLike({ StorageClass: 'STANDARD_IA' })]),
          }),
          Match.objectLike({
            Id: 'expire-noncurrent-versions',
            AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
          }),
        ]),
      },
    });
  });

  it('DESTROYS + auto-deletes the bucket when retainData is false (dev default)', () => {
    template.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Delete' });
    template.resourceCountIs('Custom::S3AutoDeleteObjects', 1);
  });
});

describe('ContentStorage with retainData=true', () => {
  it('RETAINS the bucket and provisions no auto-delete handler', () => {
    const template = synth({ retainData: true });
    template.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Retain' });
    template.resourceCountIs('Custom::S3AutoDeleteObjects', 0);
  });
});

describe('ContentStorage honors config overrides', () => {
  it('threads overridden log + content-IA retention into the lifecycle rules', () => {
    const template = synth({ context: { logRetentionDays: 180, contentIaTransitionDays: 45 } });
    template.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({ Prefix: 'logs/', ExpirationInDays: 180 }),
          Match.objectLike({
            Prefix: 'web_application/',
            Transitions: Match.arrayWith([
              Match.objectLike({ StorageClass: 'STANDARD_IA', TransitionInDays: 45 }),
            ]),
          }),
        ]),
      },
    });
  });
});

describe('ContentStorage asset uploads', () => {
  let assetsDir: string;

  beforeAll(() => {
    assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'geo-cs-assets-'));
    for (const [sub, file] of [
      ['web_application', 'index.html'],
      ['code', 'handler.py'],
      ['db', 'schema.sql'],
      ['staging', '.keep'],
      ['logs/cf_logs', 'E2EXAMPLE.gz'],
    ] as const) {
      fs.mkdirSync(path.join(assetsDir, sub), { recursive: true });
      fs.writeFileSync(path.join(assetsDir, sub, file), '// placeholder');
    }
  });

  afterAll(() => {
    fs.rmSync(assetsDir, { recursive: true, force: true });
  });

  it('creates one BucketDeployment per existing asset subdirectory', () => {
    // web_application is split into two deployments (HTML/other + a UTF-8 .txt
    // pass), plus code, db, staging, logs/cf_logs = 6.
    synth({ assetsDir }).resourceCountIs('Custom::CDKBucketDeployment', 6);
  });

  it('serves plain-text web assets (*.txt) as UTF-8 via a dedicated split deployment', () => {
    // The split exists so llms.txt/robots.txt/sitemap.xml are stamped with a
    // charset; without it S3 infers `text/plain` (no charset) and multi-byte
    // glyphs (em-dash, ★) render as mojibake. Assert the INTENT, not just that
    // a sixth deployment exists: the .txt-only pass stamps the UTF-8 content
    // type and carries NO distribution (invalidation lives on the HTML pass).
    synth({ assetsDir }).hasResourceProperties('Custom::CDKBucketDeployment', {
      Exclude: ['*'],
      Include: ['*.txt'],
      SystemMetadata: { 'content-type': 'text/plain; charset=utf-8' },
      DistributionId: Match.absent(),
    });
  });

  it('does NOT invalidate CloudFront when no distributionId is supplied', () => {
    const deployments = synth({ assetsDir }).findResources('Custom::CDKBucketDeployment');
    for (const d of Object.values(deployments)) {
      expect(d.Properties?.DistributionId).toBeUndefined();
    }
  });

  it('auto-invalidates ONLY the SPA (/*) when a distributionId is supplied', () => {
    const template = synth({ assetsDir, distributionId: 'E1234567890ABC' });
    template.hasResourceProperties('Custom::CDKBucketDeployment', {
      DistributionId: 'E1234567890ABC',
      DistributionPaths: ['/*'],
    });
    const withDist = Object.values(
      template.findResources('Custom::CDKBucketDeployment'),
    ).filter((d) => d.Properties?.DistributionId);
    expect(withDist).toHaveLength(1);
  });

  it('skips a BucketDeployment when a source subdirectory is absent', () => {
    const partial = fs.mkdtempSync(path.join(os.tmpdir(), 'geo-cs-partial-'));
    fs.mkdirSync(path.join(partial, 'web_application'), { recursive: true });
    fs.writeFileSync(path.join(partial, 'web_application', 'index.html'), '// placeholder');
    // web_application alone still yields two deployments: the main upload plus
    // the UTF-8 .txt split pass.
    synth({ assetsDir: partial }).resourceCountIs('Custom::CDKBucketDeployment', 2);
    fs.rmSync(partial, { recursive: true, force: true });
  });
});

/** Silence unused-helper lint if cfg() ends up unreferenced in a refactor. */
void cfg;
