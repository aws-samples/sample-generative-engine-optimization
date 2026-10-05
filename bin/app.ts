#!/usr/bin/env node
/*
 * Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import 'source-map-support/register.js';
import * as path from 'node:path';
import { App, Aspects, Tags } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { getConfig } from '../lib/config/index.js';
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
} from '../lib/stacks/index.js';

const app = new App();

// Resolve config from centralized defaults, with per-value overrides supplied
// via CDK context, e.g.  -c cidr=10.42.0.0/16 -c natGateways=2
const config = getConfig(app);

const { prefix, env } = config;
const baseProps = { env, config };

// Repo `assets/` directory. The CDK app is always invoked from the repo root
// (via `cdk` using the `app` command in cdk.json), so cwd is the repo root.
const assetsDir = path.resolve(process.cwd(), 'assets');

// --- Stacks (stack-per-concern) -------------------------------------------
// Dependencies are expressed by passing outputs between stacks as each one is
// fleshed out. For now they are independent placeholders.

const network = new NetworkStack(app, `${prefix}-network`, baseProps);

const storage = new StorageStack(app, `${prefix}-storage`, { ...baseProps, assetsDir });

const database = new DatabaseStack(app, `${prefix}-database`, {
  ...baseProps,
  vpc: network.vpc,
  lambdaSecurityGroup: network.lambdaSecurityGroup,
  // The schema-loader reads the SQL script the StorageStack uploads to code/db/.
  contentBucketName: storage.bucket.bucketName,
});
// Note: dependencies on network + storage are implicit — passing vpc/SG and the
// bucket name above already makes CDK order these stacks correctly.

const compute = new ComputeStack(app, `${prefix}-compute`, {
  ...baseProps,
  vpc: network.vpc,
  lambdaSecurityGroup: network.lambdaSecurityGroup,
  contentBucket: storage.bucket,
  clusterArn: database.clusterArn,
  dbSecretArn: database.secret.secretArn,
  // CloudFront distribution id for the promoter to invalidate. Supplied via
  // context to avoid a Compute<->Edge cycle (Edge needs Compute's API origin,
  // and the promoter needs Edge's distribution id). After the first deploy,
  // pass the EdgeStack's DistributionId output back in:
  //   -c distributionId=E2HKAT79V522DO
  distributionId: app.node.tryGetContext('distributionId') as string | undefined,
});
// Dependencies on network + database + storage are implicit via the references
// passed above (vpc, clusterArn, secret, bucket).

// AiStack fronts the ComputeStack's REST API as MCP tools, so it must be
// created after compute. Passing restApiId/apiStageName makes the dependency
// on compute implicit — no explicit addStackDependency needed.
const ai = new AiStack(app, `${prefix}-ai`, {
  ...baseProps,
  restApiId: compute.restApiId,
  apiStageName: compute.apiStageName,
});

const analytics = new AnalyticsStack(app, `${prefix}-analytics`, {
  ...baseProps,
  // Pass the bucket NAME (used only to build Glue/Athena S3 location strings)
  // rather than the live construct, to avoid a Storage<->Analytics cycle.
  contentBucketName: storage.bucket.bucketName,
});
// The bucket name is a plain string, not a construct ref, so keep the explicit
// dependency for sensible deploy ordering.
analytics.addStackDependency(storage);

// These stacks are instantiated for their side effect (registration with the
// app); their dependencies are implicit via the references passed in, so no
// local variable is kept.
const edge = new EdgeStack(app, `${prefix}-edge`, {
  ...baseProps,
  // Pass the bucket NAME (imported read-only in EdgeStack) rather than the live
  // construct, to avoid a Storage<->Edge dependency cycle from the OAC policy.
  contentBucketName: storage.bucket.bucketName,
  apiOriginDomain: compute.apiOriginDomain,
  apiStageName: compute.apiStageName,
});

// ConciergeChatStack — the public on-site chat behind an async submit/poll
// API Gateway REST API (POST /chat -> 202 {jobId}; GET /chat/{jobId}), backed
// by a worker Lambda + DynamoDB job store. (Lambda Function URLs are blocked by
// an account guardrail, and the ~49s agent loop exceeds API Gateway's 29s
// integration timeout, hence the async split.) It sits strictly downstream of
// both ai (harness ARN) and edge (CloudFront domain for the CORS origin).
// Reading `ai.harnessArn` and `edge.domainName` makes those dependencies
// implicit; neither reads back from this stack, so no cycle.
new ConciergeChatStack(app, `${prefix}-concierge-chat`, {
  ...baseProps,
  harnessArn: ai.harnessArn,
  cloudFrontDomainName: edge.domainName,
  chatCodeDir: path.join(assetsDir, 'code', 'chat-endpoint'),
  // The bucket NAME (string) lets this stack write the widget's runtime
  // chat-config.json into web_application/ without a Storage<->Chat cycle.
  contentBucketName: storage.bucket.bucketName,
});

new WorkflowStack(app, `${prefix}-workflow`, {
  ...baseProps,
  citationTracker: compute.citationTracker,
  patchApplier: compute.patchApplier,
  promoter: compute.promoter,
});

new MonitoringStack(app, `${prefix}-monitoring`, {
  ...baseProps,
  vpc: network.vpc,
  logBucketName: storage.bucket.bucketName,
});
// Dependencies on network (vpc) + storage (bucket name) are implicit.

// --- Cross-cutting ---------------------------------------------------------
// Apply tags to everything in the app.
for (const [key, value] of Object.entries(config.tags)) {
  Tags.of(app).add(key, value);
}

// Security/compliance checks at synth time. Comment out while iterating fast.
Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

app.synth();
