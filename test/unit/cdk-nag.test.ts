/*
 * Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT-0
 */

import { App, Aspects, Stack } from 'aws-cdk-lib';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import { getConfig, type AppConfig } from '../../lib/config/index.js';
import {
  NetworkStack,
  StorageStack,
  DatabaseStack,
  ComputeStack,
  AiStack,
  AnalyticsStack,
  EdgeStack,
  MonitoringStack,
  WorkflowStack,
  ConciergeChatStack,
} from '../../lib/stacks/index.js';
import { TEST_ENV } from './helpers.js';

/**
 * cdk-nag compliance BASELINE.
 *
 * `bin/app.ts` applies `AwsSolutionsChecks` to the whole app at synth. This
 * test reproduces the full stack graph (the same cross-stack references
 * bin/app.ts wires), applies the same Aspect, and asserts that EVERY stack has
 * zero UNSUPPRESSED AwsSolutions findings — both Errors and Warnings.
 *
 * Why this matters: every current finding is either resolved or carries a
 * documented NagSuppression. This test locks that posture in, so a future
 * change that introduces a new violation (or removes a justified suppression)
 * fails loudly here instead of surfacing at deploy time.
 *
 * NOTE: this mirrors bin/app.ts by hand. If you add a stack there, add it here
 * too — a stack that isn't instantiated can't be nag-checked.
 */
function buildAppStacks(): { app: App; stacks: Stack[] } {
  const app = new App();
  const config: AppConfig = { ...getConfig(app), env: TEST_ENV };
  const base = { env: config.env, config };

  const network = new NetworkStack(app, 'geo-demo-dev-network', base);
  const storage = new StorageStack(app, 'geo-demo-dev-storage', { ...base });
  const database = new DatabaseStack(app, 'geo-demo-dev-database', {
    ...base,
    vpc: network.vpc,
    lambdaSecurityGroup: network.lambdaSecurityGroup,
    contentBucketName: storage.bucket.bucketName,
  });
  const compute = new ComputeStack(app, 'geo-demo-dev-compute', {
    ...base,
    vpc: network.vpc,
    lambdaSecurityGroup: network.lambdaSecurityGroup,
    contentBucket: storage.bucket,
    clusterArn: database.clusterArn,
    dbSecretArn: database.secret.secretArn,
  });
  const ai = new AiStack(app, 'geo-demo-dev-ai', {
    ...base,
    restApiId: compute.restApiId,
    apiStageName: compute.apiStageName,
  });
  const analytics = new AnalyticsStack(app, 'geo-demo-dev-analytics', {
    ...base,
    contentBucketName: storage.bucket.bucketName,
  });
  analytics.addStackDependency(storage);
  const edge = new EdgeStack(app, 'geo-demo-dev-edge', {
    ...base,
    contentBucketName: storage.bucket.bucketName,
    apiOriginDomain: compute.apiOriginDomain,
    apiStageName: compute.apiStageName,
  });
  const concierge = new ConciergeChatStack(app, 'geo-demo-dev-concierge-chat', {
    ...base,
    harnessArn: ai.harnessArn,
    cloudFrontDomainName: edge.domainName,
    chatCodeDir: 'assets/code/chat-endpoint',
    contentBucketName: storage.bucket.bucketName,
    distributionId: edge.distributionId,
  });
  const workflow = new WorkflowStack(app, 'geo-demo-dev-workflow', {
    ...base,
    citationTracker: compute.citationTracker,
    patchApplier: compute.patchApplier,
    promoter: compute.promoter,
  });
  const monitoring = new MonitoringStack(app, 'geo-demo-dev-monitoring', {
    ...base,
    vpc: network.vpc,
    logBucketName: storage.bucket.bucketName,
  });

  Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

  return {
    app,
    stacks: [
      network,
      storage,
      database,
      compute,
      ai,
      analytics,
      edge,
      concierge,
      workflow,
      monitoring,
    ],
  };
}

describe('cdk-nag AwsSolutions baseline', () => {
  const { stacks } = buildAppStacks();

  it.each(stacks.map((s) => [s.stackName, s] as const))(
    '%s has no unsuppressed AwsSolutions ERRORS',
    (_name, stack) => {
      const errors = Annotations.fromStack(stack).findError(
        '*',
        Match.stringLikeRegexp('AwsSolutions-.*'),
      );
      // Surface the offending rules in the failure message for fast triage.
      const detail = errors
        .map((e) => (typeof e.entry.data === 'string' ? e.entry.data : JSON.stringify(e.entry.data)))
        .join('\n');
      expect(detail === '' ? [] : errors).toHaveLength(0);
    },
  );

  it.each(stacks.map((s) => [s.stackName, s] as const))(
    '%s has no unsuppressed AwsSolutions WARNINGS',
    (_name, stack) => {
      const warnings = Annotations.fromStack(stack).findWarning(
        '*',
        Match.stringLikeRegexp('AwsSolutions-.*'),
      );
      const detail = warnings
        .map((w) => (typeof w.entry.data === 'string' ? w.entry.data : JSON.stringify(w.entry.data)))
        .join('\n');
      expect(detail === '' ? [] : warnings).toHaveLength(0);
    },
  );
});
