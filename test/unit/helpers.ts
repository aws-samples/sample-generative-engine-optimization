/*
 * Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { App } from 'aws-cdk-lib';
import { getConfig, type AppConfig } from '../../lib/config/index.js';

/** A fixed synth environment so tests are deterministic and region-agnostic. */
export const TEST_ENV = { account: '123456789012', region: 'us-east-1' };

/**
 * Build a fresh App + config for a single test case.
 *
 * Pass `context` to simulate deploy-time overrides (`-c key=value`), e.g.
 *   testAppConfig({ cidr: '10.42.0.0/16', natGateways: 2 })
 */
export function testAppConfig(context: Record<string, unknown> = {}): {
  app: App;
  config: AppConfig;
} {
  const app = new App({ context });
  const config: AppConfig = { ...getConfig(app), env: TEST_ENV };
  return { app, config };
}

/**
 * The content bucket name the ContentStorage construct produces, derived from
 * the same inputs the construct uses (`${prefix}-content-${account}-${region}`).
 *
 * Tests assert against this COMPUTED value rather than a hard-coded literal, so
 * no copy-pasteable, squattable bucket name appears in the source (per the AWS
 * "example bucket naming" convention). Defaults to the TEST_ENV account/region.
 */
export function expectedContentBucketName(
  prefix = 'geo-demo-dev',
  env: { account?: string; region?: string } = TEST_ENV,
): string {
  return `${prefix}-content-${env.account}-${env.region}`;
}
