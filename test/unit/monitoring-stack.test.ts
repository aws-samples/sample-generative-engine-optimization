import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { getConfig, type AppConfig } from '../../lib/config/index.js';
import { NetworkStack, StorageStack, MonitoringStack } from '../../lib/stacks/index.js';
import { TEST_ENV } from './helpers.js';

function synth(context: Record<string, unknown> = {}): Template {
  const app = new App({ context });
  const config: AppConfig = { ...getConfig(app), env: TEST_ENV };
  const network = new NetworkStack(app, 'test-network', { env: config.env, config });
  const storage = new StorageStack(app, 'test-storage', { env: config.env, config });
  const monitoring = new MonitoringStack(app, 'test-monitoring', {
    env: config.env,
    config,
    vpc: network.vpc,
    logBucketName: storage.bucket.bucketName,
  });
  return Template.fromStack(monitoring);
}

describe('MonitoringStack (logging module)', () => {
  const template = synth();

  it('creates a VPC flow log delivered to S3', () => {
    template.resourceCountIs('AWS::EC2::FlowLog', 1);
    template.hasResourceProperties('AWS::EC2::FlowLog', {
      ResourceType: 'VPC',
      TrafficType: 'ALL',
      LogDestinationType: 's3',
    });
  });

  it('targets the logs/vpc_flow/ prefix in the content bucket', () => {
    template.hasResourceProperties('AWS::EC2::FlowLog', {
      LogDestination: Match.objectLike({
        'Fn::Join': Match.arrayWith([
          Match.arrayWith([Match.stringLikeRegexp('/logs/vpc_flow/')]),
        ]),
      }),
    });
  });
});

describe('MonitoringStack honors context overrides', () => {
  it('captures only REJECT traffic when overridden', () => {
    synth({ flowLogTrafficType: 'REJECT' }).hasResourceProperties('AWS::EC2::FlowLog', {
      TrafficType: 'REJECT',
    });
  });
});
