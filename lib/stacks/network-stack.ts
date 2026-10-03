/*
 * Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { CfnOutput, Stack } from 'aws-cdk-lib';
import type * as ec2 from 'aws-cdk-lib/aws-ec2';
import { NagSuppressions } from 'cdk-nag';
import type { Construct } from 'constructs';
import { BlogNetwork } from '../constructs/blog-network.js';
import type { BaseStackProps } from './stack-props.js';

/**
 * NetworkStack — foundational networking for the blog platform.
 *
 * Owns the VPC, subnets, NAT gateway, VPC endpoints, security groups, and flow
 * logs via the {@link BlogNetwork} construct. Downstream stacks (Database,
 * Compute) consume the exposed VPC and security groups.
 */
export class NetworkStack extends Stack {
  private readonly blogNetwork: BlogNetwork;

  constructor(scope: Construct, id: string, props: BaseStackProps) {
    super(scope, id, props);

    const { config } = props;

    this.blogNetwork = new BlogNetwork(this, 'Network', {
      prefix: config.prefix,
      network: config.network,
    });

    // Outputs for cross-stack reference / debugging.
    new CfnOutput(this, 'VpcId', {
      value: this.blogNetwork.vpc.vpcId,
      description: 'VPC id for the blog platform',
      exportName: `${config.prefix}-vpc-id`,
    });

    new CfnOutput(this, 'LambdaSecurityGroupId', {
      value: this.blogNetwork.lambdaSecurityGroup.securityGroupId,
      description: 'Security group id for the Lambda API tier',
      exportName: `${config.prefix}-lambda-sg-id`,
    });

    // cdk-nag AwsSolutions-EC23 cannot evaluate the ingress rule that CDK
    // auto-adds to interface endpoints (it allows HTTPS from the VPC CIDR, a
    // resolved intrinsic Fn::GetAtt, not 0.0.0.0/0). The rule is intra-VPC and
    // safe; suppress the un-evaluatable validation failure with a reason.
    NagSuppressions.addStackSuppressions(this, [
      {
        id: 'CdkNagValidationFailure',
        reason:
          'AwsSolutions-EC23 cannot resolve the VPC-CIDR intrinsic on the ' +
          'CDK-managed interface-endpoint ingress rule. The rule permits HTTPS ' +
          'only from within the VPC, not the public internet.',
        appliesTo: [
          'AwsSolutions-EC23',
        ],
      },
      {
        id: 'AwsSolutions-VPC7',
        reason:
          'The VPC does have a flow log — it is defined in the MonitoringStack ' +
          '(the logging module) and delivered to S3 at logs/vpc_flow/. cdk-nag ' +
          'only sees resources in this stack, so it cannot observe it here.',
      },
    ]);
  }

  /** The VPC hosting the compute and data tiers. */
  public get vpc(): ec2.IVpc {
    return this.blogNetwork.vpc;
  }

  /** Security group to attach to the Lambda API functions. */
  public get lambdaSecurityGroup(): ec2.ISecurityGroup {
    return this.blogNetwork.lambdaSecurityGroup;
  }
}
