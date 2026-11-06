/*
 * Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT-0
 */

import { Construct } from 'constructs';

/**
 * Props for {@link BlogBedrockAgent}.
 * TODO: add foundationModel, instruction, knowledgeBaseBucket, action groups.
 */
export interface BlogBedrockAgentProps {
  readonly prefix: string;
}

/**
 * BlogBedrockAgent — Amazon Bedrock agent for AI blog features.
 *
 * TODO (flesh out later):
 *  - Bedrock agent (foundation model + instruction) and an agent alias
 *  - Action group(s) backed by Lambda bridging to the blog API
 *  - Optional Knowledge Base over the S3 content/data-lake bucket
 *  - Guardrails + IAM execution role
 *
 * Note: expect L1 (Cfn*) constructs or the aws-cdk generative-ai constructs.
 */
export class BlogBedrockAgent extends Construct {
  // public readonly agentId: string;
  // public readonly agentAliasId: string;

  constructor(scope: Construct, id: string, _props: BlogBedrockAgentProps) {
    super(scope, id);
    // Placeholder.
  }
}
