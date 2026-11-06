/*
 * Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT-0
 */

import { App, Stack } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { getConfig, type AppConfig, type MonitoringConfig } from '../../lib/config/index.js';
import { NetworkStack, StorageStack } from '../../lib/stacks/index.js';
import { BlogObservability } from '../../lib/constructs/blog-observability.js';
import { TEST_ENV } from './helpers.js';

/**
 * BlogObservability is the logging module: it routes VPC Flow Logs to the
 * shared content bucket under logs/vpc_flow/. It needs a VPC (network layer)
 * and the log bucket (storage layer). We build those, then the construct in a
 * host stack, and assert on THAT stack's template.
 */
function synth(opts: { monitoring?: MonitoringConfig } = {}): Template {
  const app = new App();
  const config: AppConfig = { ...getConfig(app), env: TEST_ENV };
  const network = new NetworkStack(app, 'test-network', { env: config.env, config });
  const storage = new StorageStack(app, 'test-storage', { env: config.env, config });
  const host = new Stack(app, 'test-obs-host', { env: config.env });
  new BlogObservability(host, 'Observability', {
    prefix: 'geo-demo-dev',
    monitoring: opts.monitoring ?? config.monitoring,
    vpc: network.vpc,
    logBucket: storage.bucket,
  });
  return Template.fromStack(host);
}

describe('BlogObservability construct', () => {
  const template = synth();

  it('creates exactly one VPC Flow Log', () => {
    template.resourceCountIs('AWS::EC2::FlowLog', 1);
  });

  it('captures ALL traffic by default and targets the VPC', () => {
    template.hasResourceProperties('AWS::EC2::FlowLog', {
      ResourceType: 'VPC',
      TrafficType: 'ALL',
    });
  });

  it('delivers flow logs to S3 under the logs/vpc_flow/ prefix', () => {
    template.hasResourceProperties('AWS::EC2::FlowLog', {
      LogDestinationType: 's3',
      LogDestination: Match.anyValue(),
    });
    // The destination path includes the vpc_flow prefix (as part of an
    // Fn::Join with the bucket ARN).
    const flowLogs = template.findResources('AWS::EC2::FlowLog');
    const serialized = JSON.stringify(Object.values(flowLogs)[0].Properties.LogDestination);
    expect(serialized).toContain('logs/vpc_flow/');
  });
});

describe('BlogObservability honors the traffic-type override', () => {
  it('captures only REJECT traffic when configured', () => {
    const template = synth({ monitoring: { flowLogTrafficType: 'REJECT' } });
    template.hasResourceProperties('AWS::EC2::FlowLog', { TrafficType: 'REJECT' });
  });
});
