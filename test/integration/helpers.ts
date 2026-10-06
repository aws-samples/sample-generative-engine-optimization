/*
 * Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared helpers for integration tests that run against deployed AWS resources.
 *
 * The suite is organized around the blog's business scenario — a traveler asks
 * an AI assistant to "find a pet-friendly hotel in Denver this weekend under
 * $200 and book it" — exercising the two discoverability layers (be cited,
 * be called) plus the measurement loop against the live Octank Hospitality
 * deployment.
 */

/** Read a required env var, or return undefined so a test can self-skip. */
export function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

/** True when an env flag is set to a truthy value (1/true/yes). */
export function envFlag(name: string): boolean {
  const v = (process.env[name] || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
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

/**
 * Strip a trailing slash so we can safely append paths.
 *
 * Null-safe: a skipped `describeIfDeployed` block still *evaluates* its callback
 * body (Jest registers nested `describe.skip`s), so this may be called with an
 * undefined URL when the gating env var is absent. Returning '' in that case
 * keeps the suite skipping cleanly instead of throwing at load time.
 */
export function trimSlash(url: string | undefined): string {
  return (url ?? '').replace(/\/+$/, '');
}

/**
 * Resolve the base URL of the Octank Hospitality REST API.
 *
 * Precedence:
 *   1. API_URL — a direct API Gateway invoke URL incl. stage, e.g.
 *      https://xxxx.execute-api.us-east-1.amazonaws.com/prod
 *   2. BLOG_URL + /api — the API reached through CloudFront's `/api/*` behavior.
 *
 * NOTE on paths: through CloudFront the resource path is `/api/<resource>`
 * (the ApiPathRewrite function strips `/api` and forwards to the stage). The
 * direct API Gateway URL already includes the stage, so callers append just
 * `/<resource>` to the value returned here. Both forms resolve to the same
 * api-handler Lambda. Returns undefined when neither env var is set.
 */
export function apiBase(): string | undefined {
  const direct = optionalEnv('API_URL');
  if (direct) return trimSlash(direct);
  const blog = optionalEnv('BLOG_URL');
  if (blog) return `${trimSlash(blog)}/api`;
  return undefined;
}

/** True when an API base can be resolved (API_URL or BLOG_URL present). */
export function hasApiBase(): boolean {
  return apiBase() !== undefined;
}

export interface JsonResponse<T = unknown> {
  status: number;
  headers: Headers;
  body: T;
}

/** GET a URL and parse the JSON body, returning status + headers + parsed body. */
export async function getJson<T = unknown>(url: string): Promise<JsonResponse<T>> {
  const res = await fetch(url);
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text; // surface non-JSON bodies (e.g. an HTML error page) for assertions
  }
  return { status: res.status, headers: res.headers, body: body as T };
}

/** POST a JSON body and parse the JSON response. */
export async function postJson<T = unknown>(
  url: string,
  payload: unknown,
): Promise<JsonResponse<T>> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  return { status: res.status, headers: res.headers, body: body as T };
}

/** Fetch raw text (for llms.txt, robots.txt, sitemap.xml, HTML pages). */
export async function getText(
  url: string,
): Promise<{ status: number; headers: Headers; text: string }> {
  const res = await fetch(url);
  const text = await res.text();
  return { status: res.status, headers: res.headers, text };
}

/**
 * Extract the first schema.org JSON-LD block from an HTML page and parse it.
 * Returns undefined if no `<script type="application/ld+json">` block is found.
 */
export function extractJsonLd(html: string): Record<string, unknown> | undefined {
  const m = html.match(
    /<script type="application\/ld\+json">\s*(\{[\s\S]*?\})\s*<\/script>/,
  );
  if (!m) return undefined;
  try {
    return JSON.parse(m[1]) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/* --------------------------------------------------------------------------
 * AWS CLI helper (measurement layer)
 * --------------------------------------------------------------------------
 * The measurement-layer tests inspect Athena, Step Functions, and S3. Rather
 * than add AWS SDK packages to this CDK project, they shell out to the AWS CLI
 * (already installed and credentialed for the deploy). This keeps the test
 * suite dependency-free and the CDK package.json untouched.
 * ------------------------------------------------------------------------ */

import { execFileSync } from 'node:child_process';

/** AWS region for CLI calls — AWS_REGION, else AWS_DEFAULT_REGION, else us-east-1. */
export function awsRegion(): string {
  return optionalEnv('AWS_REGION') || optionalEnv('AWS_DEFAULT_REGION') || 'us-east-1';
}

/**
 * Run an AWS CLI command (array of args, no shell) and return stdout as a
 * string. `--region` is injected automatically. Throws on non-zero exit, with
 * stderr surfaced for a readable assertion failure.
 */
export function aws(args: string[]): string {
  try {
    return execFileSync('aws', [...args, '--region', awsRegion()], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message?: string };
    const detail = err.stderr ? err.stderr.toString() : err.message;
    throw new Error(`aws ${args.join(' ')} failed: ${detail}`);
  }
}

/** Run an AWS CLI command and JSON-parse stdout. */
export function awsJson<T = unknown>(args: string[]): T {
  return JSON.parse(aws(args)) as T;
}

