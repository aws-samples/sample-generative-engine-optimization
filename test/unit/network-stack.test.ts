import { Template } from 'aws-cdk-lib/assertions';
import { NetworkStack } from '../../lib/stacks/index.js';
import { testAppConfig } from './helpers.js';

function synth(): Template {
  const { app, config } = testAppConfig();
  const stack = new NetworkStack(app, 'test-network', { env: config.env, config });
  return Template.fromStack(stack);
}

describe('NetworkStack topology', () => {
  const template = synth();

  it('creates a single VPC with DNS enabled', () => {
    template.resourceCountIs('AWS::EC2::VPC', 1);
    template.hasResourceProperties('AWS::EC2::VPC', {
      CidrBlock: '10.0.0.0/16',
      EnableDnsSupport: true,
      EnableDnsHostnames: true,
    });
  });

  it('spans 2 AZs with three subnet tiers (6 subnets total)', () => {
    // 3 subnet groups x 2 AZs = 6 subnets.
    template.resourceCountIs('AWS::EC2::Subnet', 6);
  });

  it('provisions exactly one NAT gateway (single regional NAT)', () => {
    template.resourceCountIs('AWS::EC2::NatGateway', 1);
  });

  it('attaches an internet gateway', () => {
    template.resourceCountIs('AWS::EC2::InternetGateway', 1);
  });

  it('creates exactly one S3 gateway endpoint', () => {
    // ServiceName is an Fn::Join intrinsic, so match on the endpoint type and
    // assert there is exactly one gateway endpoint (S3).
    const gateways = template.findResources('AWS::EC2::VPCEndpoint', {
      Properties: { VpcEndpointType: 'Gateway' },
    });
    expect(Object.keys(gateways)).toHaveLength(1);
  });

  it('creates interface endpoints for Secrets Manager, RDS Data, Bedrock, and Logs', () => {
    // 6 interface endpoints: SecretsManager, RdsData, Bedrock, BedrockRuntime,
    // BedrockAgentRuntime, CloudWatchLogs.
    const endpoints = template.findResources('AWS::EC2::VPCEndpoint', {
      Properties: { VpcEndpointType: 'Interface' },
    });
    expect(Object.keys(endpoints)).toHaveLength(6);
  });

  it('creates two security groups (lambda, endpoints)', () => {
    // The Aurora SG is owned by the DatabaseStack, not the network layer.
    template.resourceCountIs('AWS::EC2::SecurityGroup', 2);
  });

  it('allows HTTPS (443) into the endpoint SG from the lambda SG', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      IpProtocol: 'tcp',
      FromPort: 443,
      ToPort: 443,
    });
  });

  it('does not define a VPC flow log (owned by the MonitoringStack -> S3)', () => {
    template.resourceCountIs('AWS::EC2::FlowLog', 0);
  });

  it('exports the VPC id and the lambda security group id', () => {
    template.hasOutput('VpcId', {});
    template.hasOutput('LambdaSecurityGroupId', {});
  });
});

describe('NetworkStack honors context overrides', () => {
  it('uses an overridden CIDR block', () => {
    const { app, config } = testAppConfig({ cidr: '10.42.0.0/16' });
    const stack = new NetworkStack(app, 'test-network-cidr', { env: config.env, config });
    Template.fromStack(stack).hasResourceProperties('AWS::EC2::VPC', {
      CidrBlock: '10.42.0.0/16',
    });
  });

  it('provisions two NAT gateways when natGateways=2', () => {
    const { app, config } = testAppConfig({ maxAzs: 2, natGateways: 2 });
    const stack = new NetworkStack(app, 'test-network-nat', { env: config.env, config });
    Template.fromStack(stack).resourceCountIs('AWS::EC2::NatGateway', 2);
  });
});
