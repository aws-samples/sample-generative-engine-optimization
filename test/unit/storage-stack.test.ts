/*
 * Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { getConfig, type AppConfig } from '../../lib/config/index.js';
import { StorageStack } from '../../lib/stacks/index.js';
import { TEST_ENV, testAppConfig } from './helpers.js';

function synth(context: Record<string, unknown> = {}): Template {
  const { app, config } = testAppConfig(context);
  const stack = new StorageStack(app, 'test-storage', { env: config.env, config });
  return Template.fromStack(stack);
}

describe('StorageStack (single S3 bucket)', () => {
  const template = synth();

  it('creates exactly one bucket', () => {
    template.resourceCountIs('AWS::S3::Bucket', 1);
  });

  it('uses a collision-safe deterministic name (geo-demo-content-<account>-<region>)', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: 'geo-demo-dev-content-123456789012-us-east-1',
    });
  });

  it('uses S3-managed encryption', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } },
        ],
      },
    });
  });

  it('blocks all public access', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  it('enables versioning', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      VersioningConfiguration: { Status: 'Enabled' },
    });
  });

  it('enables bucket ACLs (BucketOwnerPreferred) for CloudFront logging', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      OwnershipControls: {
        Rules: [{ ObjectOwnership: 'BucketOwnerPreferred' }],
      },
    });
  });

  it('enables S3 server access logging to logs/s3/ (self-logging)', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      LoggingConfiguration: { LogFilePrefix: 'logs/s3/' },
    });
  });

  it('enforces TLS-only access via bucket policy', () => {
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Deny',
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          }),
        ]),
      },
    });
  });

  it('defines lifecycle rules for logs, athena results, web_application, and versions', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({ Prefix: 'logs/', ExpirationInDays: 90 }),
          Match.objectLike({ Prefix: 'logs/athena_logs/', ExpirationInDays: 30 }),
          Match.objectLike({
            Prefix: 'web_application/',
            Transitions: Match.arrayWith([
              Match.objectLike({ StorageClass: 'STANDARD_IA', TransitionInDays: 90 }),
            ]),
          }),
        ]),
      },
    });
  });

  it('destroys the bucket on deletion when retainData is false (dev default)', () => {
    template.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Delete' });
  });

  it('exports the bucket name and ARN', () => {
    template.hasOutput('BucketName', {});
    template.hasOutput('BucketArn', {});
  });
});

describe('StorageStack honors context overrides', () => {
  it('applies overridden log + athena retention', () => {
    synth({ logRetentionDays: 180, queryResultRetentionDays: 14 }).hasResourceProperties(
      'AWS::S3::Bucket',
      {
        LifecycleConfiguration: {
          Rules: Match.arrayWith([
            Match.objectLike({ Prefix: 'logs/', ExpirationInDays: 180 }),
            Match.objectLike({ Prefix: 'logs/athena_logs/', ExpirationInDays: 14 }),
          ]),
        },
      },
    );
  });

  it('retains the bucket when retainData=true', () => {
    synth({ retainData: true }).hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Retain' });
  });
});

describe('StorageStack uploads source assets when assetsDir is provided', () => {
  let assetsDir: string;

  beforeAll(() => {
    // Build a minimal temp assets tree so BucketDeployment has real sources.
    assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'geo-assets-'));
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

  it('creates a BucketDeployment custom resource per asset subdirectory', () => {
    const app = new App();
    const config: AppConfig = { ...getConfig(app), env: TEST_ENV };
    const stack = new StorageStack(app, 'test-storage-assets', {
      env: config.env,
      config,
      assetsDir,
    });
    const template = Template.fromStack(stack);
    // web_application, code, db, staging, and logs/cf_logs -> 5 BucketDeployment resources.
    template.resourceCountIs('Custom::CDKBucketDeployment', 5);
  });
});
