import { App } from 'aws-cdk-lib';
import { getConfig, NETWORK_DEFAULTS } from '../../lib/config/index.js';

/** Build an App carrying the given context, then resolve config from it. */
function configWith(context: Record<string, unknown> = {}) {
  return getConfig(new App({ context }));
}

describe('getConfig — defaults', () => {
  it('resolves the single dev environment', () => {
    const config = configWith();
    expect(config.envName).toBe('dev');
    expect(config.prefix).toBe('geo-blog-dev');
    expect(config.retainData).toBe(false);
  });

  it('applies the standard project tags', () => {
    const { tags } = configWith();
    expect(tags).toMatchObject({ Project: 'geo-blog', Environment: 'dev', ManagedBy: 'cdk' });
  });

  it('uses the centralized network defaults when no overrides are given', () => {
    expect(configWith().network).toEqual(NETWORK_DEFAULTS);
  });

  it('works with no context source at all', () => {
    expect(getConfig().network.cidr).toBe(NETWORK_DEFAULTS.cidr);
  });
});

describe('getConfig — context overrides', () => {
  it('overrides the CIDR', () => {
    expect(configWith({ cidr: '10.42.0.0/16' }).network.cidr).toBe('10.42.0.0/16');
  });

  it('overrides numeric values', () => {
    const net = configWith({ maxAzs: 3, natGateways: 2, subnetCidrMask: 20 }).network;
    expect(net.maxAzs).toBe(3);
    expect(net.natGateways).toBe(2);
    expect(net.subnetCidrMask).toBe(20);
  });

  it('accepts retainData override', () => {
    expect(configWith({ retainData: true }).retainData).toBe(true);
  });
});

describe('getConfig — validation', () => {
  it('rejects a malformed CIDR', () => {
    expect(() => configWith({ cidr: 'not-a-cidr' })).toThrow(/valid IPv4 CIDR/);
  });

  it('rejects a CIDR octet > 255', () => {
    expect(() => configWith({ cidr: '10.300.0.0/16' })).toThrow(/octet > 255/);
  });

  it('rejects a CIDR mask outside /16../28', () => {
    expect(() => configWith({ cidr: '10.0.0.0/8' })).toThrow(/mask must be between/);
  });

  it('rejects a non-integer maxAzs', () => {
    expect(() => configWith({ maxAzs: '2.5' })).toThrow(/must be an integer/);
  });

  it('rejects natGateways greater than maxAzs', () => {
    expect(() => configWith({ maxAzs: 2, natGateways: 3 })).toThrow(/must be between/);
  });

  it('rejects a databasePort out of range', () => {
    expect(() => configWith({ databasePort: 70000 })).toThrow(/must be between/);
  });
});
