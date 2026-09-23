import { RemovalPolicy } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import type { NetworkConfig } from '../config/index.js';

/** Names for the VPC subnet groups, reused across the construct. */
const SUBNET_GROUP = {
  public: 'public',
  privateEgress: 'private-egress',
  isolated: 'isolated',
} as const;

/** Props for {@link BlogNetwork}. */
export interface BlogNetworkProps {
  /** Resource-name prefix (e.g. `geo-blog-dev`). */
  readonly prefix: string;
  /** Networking settings resolved from the environment config. */
  readonly network: NetworkConfig;
  /**
   * When false, the VPC flow-log group is destroyed with the stack.
   * Drives the flow-log group removal policy (retain in prod).
   */
  readonly retainData: boolean;
}

/**
 * BlogNetwork — the VPC and network wiring for the blog platform.
 *
 * Topology (per AZ, across `network.maxAzs` AZs):
 *  - public            : hosts the NAT gateway(s); routes to the IGW
 *  - private-egress     : hosts the Lambda API; egress via NAT + VPC endpoints
 *  - isolated           : hosts Aurora; no internet route, VPC-local only
 *
 * Connectivity:
 *  - S3            : Gateway endpoint (free, route-table based)
 *  - Secrets Mgr   : Interface endpoint (Lambda fetches DB credentials)
 *  - Bedrock       : Interface endpoints (agent + runtime) for AI features
 *  - CloudWatch    : Interface endpoints so log delivery avoids NAT
 *
 * Security groups:
 *  - lambdaSecurityGroup   : attached to Lambda; no inbound, egress allowed
 *  - endpointSecurityGroup : interface endpoints; inbound 443 from Lambda SG
 *
 * The Aurora security group is owned by the DatabaseStack (not here) to keep
 * cross-stack references one-directional and avoid a dependency cycle; it
 * references `lambdaSecurityGroup` for its ingress rule.
 */
export class BlogNetwork extends Construct {
  /** The VPC hosting compute and data tiers. */
  public readonly vpc: ec2.Vpc;
  /** Security group for the Lambda API functions. */
  public readonly lambdaSecurityGroup: ec2.SecurityGroup;
  /** Security group shared by the interface VPC endpoints. */
  public readonly endpointSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: BlogNetworkProps) {
    super(scope, id);

    const { prefix, network, retainData } = props;

    // --- VPC + subnets -----------------------------------------------------
    this.vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName: `${prefix}-vpc`,
      ipAddresses: ec2.IpAddresses.cidr(network.cidr),
      maxAzs: network.maxAzs,
      natGateways: network.natGateways,
      // Required for interface-endpoint private DNS to resolve.
      enableDnsSupport: true,
      enableDnsHostnames: true,
      subnetConfiguration: [
        {
          name: SUBNET_GROUP.public,
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: network.subnetCidrMask,
        },
        {
          name: SUBNET_GROUP.privateEgress,
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: network.subnetCidrMask,
        },
        {
          name: SUBNET_GROUP.isolated,
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: network.subnetCidrMask,
        },
      ],
    });

    // --- Security groups ---------------------------------------------------
    this.lambdaSecurityGroup = new ec2.SecurityGroup(this, 'LambdaSg', {
      vpc: this.vpc,
      securityGroupName: `${prefix}-lambda-sg`,
      description: 'Blog Lambda API functions; outbound only.',
      allowAllOutbound: true,
    });

    this.endpointSecurityGroup = new ec2.SecurityGroup(this, 'EndpointSg', {
      vpc: this.vpc,
      securityGroupName: `${prefix}-endpoint-sg`,
      description: 'Interface VPC endpoints; inbound 443 from Lambda.',
      allowAllOutbound: false,
    });

    // Note: the Aurora security group is intentionally owned by the
    // DatabaseStack (the stack that owns the cluster). Creating it here and
    // attaching it to a resource in another stack produces a cross-stack
    // dependency cycle. The DatabaseStack references `lambdaSecurityGroup`
    // (exposed below) for its ingress rule, keeping references one-directional.

    // Interface endpoints accept HTTPS from the Lambda tier.
    this.endpointSecurityGroup.addIngressRule(
      this.lambdaSecurityGroup,
      ec2.Port.tcp(443),
      'Allow HTTPS from the Lambda API to interface endpoints',
    );

    // --- VPC endpoints -----------------------------------------------------
    // S3: gateway endpoint (free). Routed from private + isolated subnets so
    // both Lambda and any data-tier access to S3 stays on the AWS network.
    this.vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
      subnets: [
        { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      ],
    });

    // Interface endpoints live in the private-egress subnets (where Lambda
    // runs) and share one security group.
    const interfaceEndpoints: Record<string, ec2.InterfaceVpcEndpointAwsService> = {
      SecretsManager: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
      // RDS Data API — lets VPC Lambdas query Aurora over the Data API privately.
      RdsData: ec2.InterfaceVpcEndpointAwsService.RDS_DATA,
      Bedrock: ec2.InterfaceVpcEndpointAwsService.BEDROCK,
      BedrockRuntime: ec2.InterfaceVpcEndpointAwsService.BEDROCK_RUNTIME,
      BedrockAgentRuntime: ec2.InterfaceVpcEndpointAwsService.BEDROCK_AGENT_RUNTIME,
      CloudWatchLogs: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
    };

    for (const [name, service] of Object.entries(interfaceEndpoints)) {
      this.vpc.addInterfaceEndpoint(`${name}Endpoint`, {
        service,
        privateDnsEnabled: true,
        securityGroups: [this.endpointSecurityGroup],
        subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      });
    }

    // --- VPC flow logs -----------------------------------------------------
    const flowLogGroup = new logs.LogGroup(this, 'FlowLogGroup', {
      logGroupName: `/${prefix}/vpc/flow-logs`,
      retention: retainData
        ? logs.RetentionDays.ONE_YEAR
        : logs.RetentionDays.ONE_MONTH,
      removalPolicy: retainData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    this.vpc.addFlowLog('FlowLog', {
      destination: ec2.FlowLogDestination.toCloudWatchLogs(flowLogGroup),
      trafficType: ec2.FlowLogTrafficType.ALL,
    });
  }

  /** Isolated subnet selection for the data tier (Aurora). */
  public get isolatedSubnets(): ec2.SelectedSubnets {
    return this.vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_ISOLATED });
  }

  /** Private-with-egress subnet selection for the compute tier (Lambda). */
  public get privateEgressSubnets(): ec2.SelectedSubnets {
    return this.vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS });
  }
}
