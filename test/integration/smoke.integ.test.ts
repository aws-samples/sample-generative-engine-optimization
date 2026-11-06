/*
 * Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT-0
 */

import { describeIfDeployed, optionalEnv } from './helpers.js';

/**
 * Example integration test template.
 *
 * This block runs only when BLOG_URL is set (i.e. after a deploy); otherwise it
 * self-skips so the suite stays green in CI without a live environment.
 *
 * Set BLOG_URL to the CloudFront distribution domain once the EdgeStack is
 * implemented, e.g.:  $env:BLOG_URL = "https://dxxxx.cloudfront.net"
 */
describeIfDeployed(['BLOG_URL'])('blog edge (CloudFront)', () => {
  it('serves the site over HTTPS with a 2xx/3xx response', async () => {
    const url = optionalEnv('BLOG_URL')!;
    const res = await fetch(url);
    expect(res.status).toBeLessThan(400);
  });
});

// Keep Jest happy when every block above is skipped.
describe('integration harness', () => {
  it('is wired up', () => {
    expect(typeof fetch).toBe('function');
  });
});
