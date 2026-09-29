import { Template } from 'aws-cdk-lib/assertions';
import { NetworkStack } from '../../lib/stacks/index.js';
import { testAppConfig } from './helpers.js';

/**
 * Cross-stack smoke tests for *implemented* stacks.
 *
 * Only stacks that create at least one resource are asserted here — an empty
 * placeholder stack is not a valid CloudFormation template and cannot be
 * synthesized or deployed, so it is intentionally excluded until it has real
 * resources.
 *
 * As each remaining stack is fleshed out, give it a dedicated test file (see
 * network-stack.test.ts as the template) and add it to the list below.
 */
describe('implemented stack synthesis', () => {
  it('NetworkStack synthesizes with resources', () => {
    const { app, config } = testAppConfig();
    const stack = new NetworkStack(app, 'test-network', { env: config.env, config });
    const template = Template.fromStack(stack);
    expect(Object.keys(template.toJSON().Resources ?? {}).length).toBeGreaterThan(0);
  });
});
