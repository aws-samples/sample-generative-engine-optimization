import { Stack } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { BaseStackProps } from './stack-props.js';

/**
 * AiStack — Amazon Bedrock agent for the blog platform.
 *
 * Responsibility: generative AI features (content assistance, summarization,
 * semantic Q&A over blog content) via a Bedrock agent, optionally backed by a
 * knowledge base.
 *
 * TODO (flesh out later):
 *  - Bedrock agent (foundation model, instruction, action groups)
 *  - Action-group Lambda(s) bridging the agent to the blog API
 *  - Optional Knowledge Base over the S3 data-lake / content bucket
 *  - Guardrails, agent alias, and IAM execution role
 *
 * Depends on: StorageStack (KB source), ComputeStack (action-group Lambdas).
 *
 * Note: L2 support for Bedrock is limited — expect L1 (Cfn*) constructs and/or
 * the aws-cdk generative-ai constructs library here.
 */
// Placeholder: no extra props yet. A type alias (not an empty interface) keeps
// the named type for future extension without tripping no-empty-object-type.
export type AiStackProps = BaseStackProps;

export class AiStack extends Stack {
  // public readonly agentId: string;
  // public readonly agentAliasId: string;

  constructor(scope: Construct, id: string, props: AiStackProps) {
    super(scope, id, props);

    // Placeholder — Bedrock agent will be added here.
    void props.config;
  }
}
