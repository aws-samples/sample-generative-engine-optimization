#!/usr/bin/env node
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
});
database.addDependency(network);

const ai = new AiStack(app, `${prefix}-ai`, baseProps);
ai.addDependency(storage);

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
compute.addDependency(network);
compute.addDependency(database);
compute.addDependency(storage);

const analytics = new AnalyticsStack(app, `${prefix}-analytics`, baseProps);
analytics.addDependency(storage);

const edge = new EdgeStack(app, `${prefix}-edge`, {
  ...baseProps,
  // Pass the bucket NAME (imported read-only in EdgeStack) rather than the live
  // construct, to avoid a Storage<->Edge dependency cycle from the OAC policy.
  contentBucketName: storage.bucket.bucketName,
  apiOriginDomain: compute.apiOriginDomain,
  apiStageName: compute.apiStageName,
});
edge.addDependency(storage);
edge.addDependency(compute);

const monitoring = new MonitoringStack(app, `${prefix}-monitoring`, {
  ...baseProps,
  vpc: network.vpc,
  logBucketName: storage.bucket.bucketName,
});
monitoring.addDependency(network);
monitoring.addDependency(storage);

// --- Cross-cutting ---------------------------------------------------------
// Apply tags to everything in the app.
for (const [key, value] of Object.entries(config.tags)) {
  Tags.of(app).add(key, value);
}

// Security/compliance checks at synth time. Comment out while iterating fast.
Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

app.synth();
