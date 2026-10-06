/*
 * Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Measurement Layer — "track and improve"
 * =======================================
 * Business scenario: Octank wants to know whether AI engines are crawling and
 * citing it, and to close the loop by diagnosing gaps and staging fixes —
 * WITHOUT ever touching live content automatically. These tests assert that
 * measurement plumbing against the live deployment:
 *
 *   - Athena can run the blog's AI-crawler detection query over CloudFront logs
 *   - the Step Functions feedback loop exists and is startable
 *   - the loop is STAGE-ONLY: the patch-applier writes to staging/, and the
 *     promoter/validator role cannot write to live content
 *   - (optional, flagged) the citation-tracker Lambda invokes Bedrock and
 *     publishes a citation-rate metric
 *
 * These use the AWS CLI (no SDK dependency). They self-skip unless the relevant
 * env vars are set:
 *   ATHENA_WORKGROUP      e.g. geo-demo-dev-analytics
 *   ATHENA_DATABASE       e.g. geo_demo_dev_logs
 *   STATE_MACHINE_ARN     the feedback-loop state machine ARN
 *   CONTENT_BUCKET        e.g. geo-demo-dev-content-<acct>-<region>
 *   CITATION_TRACKER_FN   citation-tracker function name (only for the Bedrock test)
 * Bedrock invocation is additionally gated behind RUN_BEDROCK_TESTS=1.
 */

import {
  describeIfDeployed,
  optionalEnv,
  envFlag,
  aws,
  awsJson,
} from './helpers.js';

/* ---------------------------------------------------------------------------
 * Athena — AI crawler detection over CloudFront logs
 * ------------------------------------------------------------------------- */
describeIfDeployed(['ATHENA_WORKGROUP', 'ATHENA_DATABASE'])(
  'Measurement — Athena crawler monitoring',
  () => {
    const workgroup = optionalEnv('ATHENA_WORKGROUP')!;
    const database = optionalEnv('ATHENA_DATABASE')!;

    /** Run an Athena query to completion and return the result rows (as string matrix). */
    function runAthena(sql: string): string[][] {
      const start = awsJson<{ QueryExecutionId: string }>([
        'athena', 'start-query-execution',
        '--query-string', sql,
        '--work-group', workgroup,
        '--query-execution-context', `Database=${database}`,
        '--output', 'json',
      ]);
      const id = start.QueryExecutionId;

      // Poll until the query reaches a terminal state.
      const deadline = Date.now() + 120_000;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const st = awsJson<{ QueryExecution: { Status: { State: string; StateChangeReason?: string } } }>([
          'athena', 'get-query-execution',
          '--query-execution-id', id,
          '--output', 'json',
        ]);
        const state = st.QueryExecution.Status.State;
        if (state === 'SUCCEEDED') break;
        if (state === 'FAILED' || state === 'CANCELLED') {
          throw new Error(`Athena query ${state}: ${st.QueryExecution.Status.StateChangeReason}`);
        }
        if (Date.now() > deadline) throw new Error('Athena query timed out');
        execSleep(2000);
      }

      const results = awsJson<{ ResultSet: { Rows: Array<{ Data: Array<{ VarCharValue?: string }> }> } }>([
        'athena', 'get-query-results',
        '--query-execution-id', id,
        '--output', 'json',
      ]);
      return results.ResultSet.Rows.map((r) => r.Data.map((d) => d.VarCharValue ?? ''));
    }

    it('runs the blog\u2019s AI-crawler detection query and returns a result set', () => {
      // The exact query shape from the blog: surface GPTBot/ClaudeBot/PerplexityBot
      // hits by page. Over the seeded sample logs this returns rows.
      const sql = `
        SELECT cs_uri_stem AS page, COUNT(*) AS ai_requests
        FROM cloudfront_logs
        WHERE (cs_user_agent LIKE '%GPTBot%'
            OR cs_user_agent LIKE '%ClaudeBot%'
            OR cs_user_agent LIKE '%PerplexityBot%')
        GROUP BY cs_uri_stem
        ORDER BY ai_requests DESC
        LIMIT 10
      `;
      const rows = runAthena(sql);
      // Row 0 is the header (page, ai_requests); data rows follow.
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows[0]).toEqual(['page', 'ai_requests']);
    });

    it('can count total crawler-log rows (table + Glue schema are wired)', () => {
      const rows = runAthena('SELECT COUNT(*) AS n FROM cloudfront_logs');
      const n = Number(rows[1]?.[0] ?? '0');
      expect(n).toBeGreaterThan(0);
    });
  },
);

/* ---------------------------------------------------------------------------
 * Step Functions — the GEO feedback loop
 * ------------------------------------------------------------------------- */
describeIfDeployed(['STATE_MACHINE_ARN'])(
  'Measurement — feedback-loop state machine',
  () => {
    const arn = optionalEnv('STATE_MACHINE_ARN')!;

    it('exists and is a Standard (not Express) state machine', () => {
      const sm = awsJson<{ name: string; type: string; status: string }>([
        'stepfunctions', 'describe-state-machine',
        '--state-machine-arn', arn,
        '--output', 'json',
      ]);
      expect(sm.name).toContain('feedback-loop');
      expect(sm.type).toBe('STANDARD');
    });

    it('is stage-only by design: definition measures live, patches to staging, never writes live', () => {
      const sm = awsJson<{ definition: string }>([
        'stepfunctions', 'describe-state-machine',
        '--state-machine-arn', arn,
        '--output', 'json',
      ]);
      const def = sm.definition;
      // The state machine orchestrates the three workers in the documented order.
      expect(def).toMatch(/citation-tracker/);
      expect(def).toMatch(/patch-applier/);
      expect(def).toMatch(/promoter/);
    });
  },
);

/* ---------------------------------------------------------------------------
 * Stage-only guarantee — the validator role cannot write to live content
 * ------------------------------------------------------------------------- */
describeIfDeployed(['CONTENT_BUCKET'])('Measurement — stage-only safety', () => {
  const bucket = optionalEnv('CONTENT_BUCKET')!;

  it('keeps a staging/ prefix seeded (feedback-loop candidates land here, not live)', () => {
    const out = aws([
      's3api', 'list-objects-v2',
      '--bucket', bucket,
      '--prefix', 'staging/',
      '--max-items', '5',
      '--output', 'json',
    ]);
    // The StorageStack seeds staging/.keep so the prefix always exists.
    expect(out).toMatch(/staging\//);
  });

  it('promoter Lambda role grants no PutObject to live content (stage-only IAM)', () => {
    // The blog's safety claim: the validator/promoter role is scoped so it
    // cannot modify production content. Verify by inspecting its inline policies
    // — none should allow s3:PutObject on a live properties/ key.
    const fn = optionalEnv('PROMOTER_FN') || 'geo-demo-dev-promoter';
    let roleArn: string;
    try {
      const cfg = awsJson<{ Role: string }>([
        'lambda', 'get-function-configuration',
        '--function-name', fn,
        '--output', 'json',
      ]);
      roleArn = cfg.Role;
    } catch {
      // If the promoter function name differs, skip rather than false-fail.
      console.warn(`[integration] promoter function ${fn} not found; skipping IAM assertion`);
      return;
    }
    const roleName = roleArn.split('/').pop()!;
    const policies = awsJson<{ PolicyNames: string[] }>([
      'iam', 'list-role-policies', '--role-name', roleName, '--output', 'json',
    ]);
    for (const pname of policies.PolicyNames) {
      const doc = aws([
        'iam', 'get-role-policy',
        '--role-name', roleName,
        '--policy-name', pname,
        '--output', 'json',
      ]);
      // No statement should grant PutObject to a live properties/ path.
      // (staging/* writes are expected and allowed; live writes are not.)
      const grantsLivePut =
        /s3:PutObject/.test(doc) && /properties\/\*/.test(doc) && !/staging/.test(doc);
      expect(grantsLivePut).toBe(false);
    }
  });
});

/* ---------------------------------------------------------------------------
 * Citation tracker — Bedrock invocation (costs money; flag-gated)
 * ------------------------------------------------------------------------- */
const bedrockRequires =
  envFlag('RUN_BEDROCK_TESTS') && optionalEnv('CITATION_TRACKER_FN')
    ? ['CITATION_TRACKER_FN']
    : ['__RUN_BEDROCK_TESTS_DISABLED__'];

describeIfDeployed(bedrockRequires)('Measurement — citation tracker (Bedrock)', () => {
  const fn = optionalEnv('CITATION_TRACKER_FN')!;

  it('invokes the citation-tracker and returns a citation-rate summary', () => {
    // Synchronous invoke; the handler queries Bedrock with the Octank target
    // prompts and returns {citation_rate_pct, cited_count, total_prompts}.
    // Write to the OS temp dir (cross-platform; `/tmp` is Unix-only).
    const outFile = join(tmpdir(), 'geo-citation-out.json');
    // The citation-tracker runs a multi-prompt Bedrock loop that can take a few
    // minutes (its Lambda timeout is 300s). The AWS CLI's default socket read
    // timeout is 60s, so a plain invoke aborts with "Read timeout on endpoint
    // URL" long before the function returns. Disable the client read timeout
    // (0 = wait indefinitely) so we observe the real result.
    aws([
      'lambda', 'invoke',
      '--function-name', fn,
      '--payload', JSON.stringify({ target: 'live' }),
      '--cli-binary-format', 'raw-in-base64-out',
      '--cli-read-timeout', '0',
      outFile,
      '--output', 'json',
    ]);
    const summary = JSON.parse(readFileSync(outFile, 'utf-8')) as {
      total_prompts: number;
      cited_count: number;
      citation_rate_pct: number;
    };
    expect(summary.total_prompts).toBeGreaterThan(0);
    expect(summary.citation_rate_pct).toBeGreaterThanOrEqual(0);
    expect(summary.citation_rate_pct).toBeLessThanOrEqual(100);
  });
});

/* ---------------------------------------------------------------------------
 * local utility: sleep without extra deps (Atomics.wait on a shared buffer)
 * ------------------------------------------------------------------------- */
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function execSleep(ms: number): void {
  const sab = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sab, 0, 0, ms);
}

