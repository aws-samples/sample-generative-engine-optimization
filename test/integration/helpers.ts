/*
 * Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared helpers for integration tests that run against deployed AWS resources.
 */

/** Read a required env var, or return undefined so a test can self-skip. */
export function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

/**
 * Guard for integration tests. Returns a `describe`-compatible function that
 * skips the block when any required env var is missing, keeping the suite green
 * in environments without a live deployment.
 *
 *   describeIfDeployed(['BLOG_URL'])('CloudFront', () => { ... });
 */
export function describeIfDeployed(requiredEnv: string[]): jest.Describe {
  const missing = requiredEnv.filter((name) => !optionalEnv(name));
  if (missing.length > 0) {
    return ((name: string, fn: () => void) => {
      // eslint-disable-next-line no-console
      console.warn(
        `[integration] skipping "${name}" — missing env: ${missing.join(', ')}`,
      );
      return describe.skip(name, fn);
    }) as unknown as jest.Describe;
  }
  return describe as jest.Describe;
}
