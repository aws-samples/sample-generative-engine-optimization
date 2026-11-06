/*
 * Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT-0
 */

import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { getConfig, type AppConfig } from '../../lib/config/index.js';
import { StorageStack, EdgeStack } from '../../lib/stacks/index.js';
import { TEST_ENV } from './helpers.js';

const API_DOMAIN = 'abc123.execute-api.us-east-1.amazonaws.com';

function synth(context: Record<string, unknown> = {}): Template {
  const app = new App({ context });
  const config: AppConfig = { ...getConfig(app), env: TEST_ENV };
  const storage = new StorageStack(app, 'test-storage', { env: config.env, config });
  const edge = new EdgeStack(app, 'test-edge', {
    env: config.env,
    config,
    contentBucketName: storage.bucket.bucketName,
    apiOriginDomain: API_DOMAIN,
    apiStageName: 'prod',
  });
  return Template.fromStack(edge);
}

describe('EdgeStack (CloudFront)', () => {
  const template = synth();

  it('creates a single distribution with index.html root', () => {
    template.resourceCountIs('AWS::CloudFront::Distribution', 1);
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({ DefaultRootObject: 'index.html' }),
    });
  });

  it('has an S3 origin with OAC and the web_application origin path', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Origins: Match.arrayWith([
          Match.objectLike({
            OriginPath: '/web_application',
            OriginAccessControlId: Match.anyValue(),
          }),
        ]),
      }),
    });
    template.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
  });

  it('has an API origin routed by the /api/* behavior', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Origins: Match.arrayWith([
          Match.objectLike({ DomainName: API_DOMAIN, OriginPath: '/prod' }),
        ]),
        CacheBehaviors: Match.arrayWith([
          Match.objectLike({ PathPattern: '/api/*' }),
        ]),
      }),
    });
  });

  it('redirects viewers to HTTPS on the default behavior', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultCacheBehavior: Match.objectLike({
          ViewerProtocolPolicy: 'redirect-to-https',
        }),
      }),
    });
  });

  it('enables standard access logging to logs/cf_logs/', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Logging: Match.objectLike({ Prefix: 'logs/cf_logs/' }),
      }),
    });
  });

  it('exports the distribution id and domain name', () => {
    template.hasOutput('DistributionId', {});
    template.hasOutput('DistributionDomainName', {});
  });

  it('attaches CloudFront Functions: the /api prefix strip and the pretty-URL rewrite', () => {
    // Two viewer-request functions now: the /api-prefix strip (API behavior)
    // and the pretty-URL .html rewrite (SPA default behavior).
    template.resourceCountIs('AWS::CloudFront::Function', 2);
    const codes = Object.values(template.findResources('AWS::CloudFront::Function')).map(
      (f) => f.Properties.FunctionCode as string,
    );
    // /api prefix strip
    expect(codes.some((c) => c.includes("var prefix = '/api'"))).toBe(true);
    // pretty-URL rewrite: appends .html to extensionless, non-root paths
    expect(codes.some((c) => c.includes(".html") && c.includes("lastIndexOf('/')"))).toBe(true);
  });
});

describe('EdgeStack honors context overrides', () => {
  it('applies an overridden price class', () => {
    synth({ priceClass: '100' }).hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({ PriceClass: 'PriceClass_100' }),
    });
  });
});
