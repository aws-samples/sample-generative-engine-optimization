/*
 * Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { App } from 'aws-cdk-lib';
import { getConfig } from '../../lib/config/index.js';

/**
 * Invalid-config FAIL-FAST tests.
 *
 * The config layer promises "validated, fail-fast": a bad `-c key=value`
 * override must throw at config-resolution (synth) time, not silently coerce or
 * surface at deploy. The existing config.test.ts covers VALID overrides; this
 * file covers the rejection paths — one assertion per validation branch.
 *
 * Each case builds an App with the bad context and expects getConfig() to throw
 * with a message that names the offending key.
 */
function resolve(context: Record<string, unknown>): () => unknown {
  return () => getConfig(new App({ context }));
}

describe('config fail-fast — network', () => {
  it('rejects a non-integer maxAzs', () => {
    expect(resolve({ maxAzs: 'two' })).toThrow(/maxAzs.*must be an integer/);
  });

  it('rejects natGateways greater than maxAzs (out of range)', () => {
    // natGateways is bounded to [0, maxAzs]; 5 with the default maxAzs=2 fails.
    expect(resolve({ natGateways: 5 })).toThrow(/natGateways.*must be between/);
  });

  it('rejects a malformed CIDR', () => {
    expect(resolve({ cidr: 'not-a-cidr' })).toThrow(/cidr.*valid IPv4 CIDR/);
  });

  it('rejects a CIDR octet greater than 255', () => {
    expect(resolve({ cidr: '10.0.300.0/16' })).toThrow(/cidr.*octet > 255|valid IPv4 CIDR/);
  });

  it('rejects a CIDR mask outside /16../28', () => {
    expect(resolve({ cidr: '10.0.0.0/8' })).toThrow(/cidr.*mask must be between/);
  });
});

describe('config fail-fast — database', () => {
  it('rejects a non-number minAcu', () => {
    expect(resolve({ minAcu: 'half' })).toThrow(/minAcu.*must be a number/);
  });

  it('rejects maxAcu < minAcu', () => {
    expect(resolve({ minAcu: 4, maxAcu: 2 })).toThrow(/maxAcu.*must be >=.*minAcu/);
  });

  it('rejects a malformed engineVersion', () => {
    expect(resolve({ engineVersion: '16' })).toThrow(/engineVersion.*major\.minor/);
  });
});

describe('config fail-fast — edge & monitoring', () => {
  it('rejects an unknown priceClass', () => {
    expect(resolve({ priceClass: '300' })).toThrow(/priceClass.*one of all\|200\|100/);
  });

  it('rejects an unknown flowLogTrafficType', () => {
    expect(resolve({ flowLogTrafficType: 'EVERYTHING' })).toThrow(
      /flowLogTrafficType.*one of ALL\|ACCEPT\|REJECT/,
    );
  });
});

describe('config fail-fast — boolean coercion', () => {
  it('rejects a non-boolean workflowSchedule', () => {
    expect(resolve({ workflowSchedule: 'maybe' })).toThrow(/workflowSchedule.*must be true or false/);
  });
});
