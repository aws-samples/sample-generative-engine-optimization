import { App } from 'aws-cdk-lib';
import { getConfig, type AppConfig } from '../../lib/config/index.js';

/** A fixed synth environment so tests are deterministic and region-agnostic. */
export const TEST_ENV = { account: '123456789012', region: 'us-east-1' };

/**
 * Build a fresh App + config for a single test case.
 *
 * Pass `context` to simulate deploy-time overrides (`-c key=value`), e.g.
 *   testAppConfig({ cidr: '10.42.0.0/16', natGateways: 2 })
 */
export function testAppConfig(context: Record<string, unknown> = {}): {
  app: App;
  config: AppConfig;
} {
  const app = new App({ context });
  const config: AppConfig = { ...getConfig(app), env: TEST_ENV };
  return { app, config };
}
