import type { App, Environment } from 'aws-cdk-lib';

/**
 * Deployment environment name. Currently a single `dev` environment; the shape
 * is kept so additional environments can be added later without a rewrite.
 */
export type EnvName = 'dev';

/**
 * Networking configuration for the {@link NetworkStack} / BlogNetwork construct.
 * Every value has a default (see {@link NETWORK_DEFAULTS}) and can be overridden
 * at deploy time via CDK context.
 */
export interface NetworkConfig {
  /** VPC IPv4 CIDR block. */
  readonly cidr: string;
  /** Number of Availability Zones to span. */
  readonly maxAzs: number;
  /**
   * Number of NAT gateways. 1 = single regional NAT (cost-efficient; egress is
   * interrupted if that AZ fails). Set to maxAzs for full HA.
   */
  readonly natGateways: number;
  /** Prefix length (netmask) for each subnet CIDR (e.g. 24 => /24). */
  readonly subnetCidrMask: number;
  /** Port the database listens on (PostgreSQL = 5432). */
  readonly databasePort: number;
}

/**
 * Central configuration for the blog platform. This is the single source of
 * truth; every stack derives names, sizing, and policies from it.
 */
export interface AppConfig {
  /** Logical environment name. */
  readonly envName: EnvName;
  /** Target AWS account + region. Falls back to CLI/CDK default env if unset. */
  readonly env: Environment;
  /** Prefix applied to resource names / stack IDs for uniqueness and clarity. */
  readonly prefix: string;
  /** Tags applied to every resource in the app. */
  readonly tags: Record<string, string>;
  /**
   * When true, stateful resources (S3, Aurora, logs) are retained on stack
   * deletion. Defaults to false for the dev environment.
   */
  readonly retainData: boolean;
  /** Networking settings (VPC, subnets, NAT, endpoints). */
  readonly network: NetworkConfig;
}

const APP_NAME = 'geo-blog';
const DEFAULT_ENV: EnvName = 'dev';

/**
 * Centralized default values. Change a default here to change it everywhere; a
 * user can override any of these per-deploy via CDK context (see getConfig).
 */
export const NETWORK_DEFAULTS: NetworkConfig = {
  cidr: '10.0.0.0/16',
  maxAzs: 2,
  natGateways: 1,
  subnetCidrMask: 24,
  databasePort: 5432,
};

/** Whether stateful data is retained on stack deletion, by default. */
export const DEFAULT_RETAIN_DATA = false;

// --- Context override helpers ---------------------------------------------

/** Minimal shape needed to read CDK context, so the resolver is testable. */
export interface ContextSource {
  node: { tryGetContext(key: string): unknown };
}

function readContext(source: ContextSource | undefined, key: string): unknown {
  return source?.node.tryGetContext(key);
}

/** Parse a positive integer from context, validating the range. */
function intOverride(
  raw: unknown,
  fallback: number,
  key: string,
  { min = 1, max = Number.MAX_SAFE_INTEGER }: { min?: number; max?: number } = {},
): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(value)) {
    throw new Error(`Context "${key}" must be an integer, got "${String(raw)}".`);
  }
  if (value < min || value > max) {
    throw new Error(`Context "${key}" must be between ${min} and ${max}, got ${value}.`);
  }
  return value;
}

/** IPv4 CIDR validation (e.g. 10.0.0.0/16). */
const CIDR_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;

function cidrOverride(raw: unknown, fallback: string, key: string): string {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = String(raw);
  const m = CIDR_RE.exec(value);
  if (!m) {
    throw new Error(`Context "${key}" must be a valid IPv4 CIDR (e.g. 10.0.0.0/16), got "${value}".`);
  }
  const octets = [m[1], m[2], m[3], m[4]].map(Number);
  if (octets.some((o) => o > 255)) {
    throw new Error(`Context "${key}" has an octet > 255: "${value}".`);
  }
  const mask = Number(m[5]);
  if (mask < 16 || mask > 28) {
    throw new Error(`Context "${key}" mask must be between /16 and /28, got "/${mask}".`);
  }
  return value;
}

/**
 * Resolve the account/region. Prefer explicit values via env vars, otherwise
 * fall back to the ambient CDK CLI environment (account/region of the caller).
 */
function resolveEnv(): Environment {
  return {
    account: process.env.CDK_DEPLOY_ACCOUNT ?? process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEPLOY_REGION ?? process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  };
}

/**
 * Resolve networking config: start from {@link NETWORK_DEFAULTS}, then apply any
 * per-value overrides supplied via CDK context, validating each one.
 *
 * Supported context keys (all optional):
 *   -c cidr=10.42.0.0/16
 *   -c maxAzs=3
 *   -c natGateways=2
 *   -c subnetCidrMask=20
 *   -c databasePort=5432
 */
function resolveNetwork(source?: ContextSource): NetworkConfig {
  const maxAzs = intOverride(readContext(source, 'maxAzs'), NETWORK_DEFAULTS.maxAzs, 'maxAzs', {
    min: 1,
    max: 6,
  });
  return {
    cidr: cidrOverride(readContext(source, 'cidr'), NETWORK_DEFAULTS.cidr, 'cidr'),
    maxAzs,
    natGateways: intOverride(
      readContext(source, 'natGateways'),
      NETWORK_DEFAULTS.natGateways,
      'natGateways',
      { min: 0, max: maxAzs },
    ),
    subnetCidrMask: intOverride(
      readContext(source, 'subnetCidrMask'),
      NETWORK_DEFAULTS.subnetCidrMask,
      'subnetCidrMask',
      { min: 16, max: 28 },
    ),
    databasePort: intOverride(
      readContext(source, 'databasePort'),
      NETWORK_DEFAULTS.databasePort,
      'databasePort',
      { min: 1, max: 65535 },
    ),
  };
}

/**
 * Build the active {@link AppConfig}.
 *
 * @param source  The CDK `App` (or anything exposing `node.tryGetContext`) so
 *                users can override defaults with `-c key=value` at deploy time.
 *                Optional so unit tests can call it with no context.
 *
 * All defaults are centralized above; overrides are read from context and
 * validated, so a bad value fails fast at synth with a clear message.
 */
export function getConfig(source?: App | ContextSource): AppConfig {
  const envName = DEFAULT_ENV;
  const retainData = Boolean(readContext(source, 'retainData')) || DEFAULT_RETAIN_DATA;

  return {
    envName,
    env: resolveEnv(),
    prefix: `${APP_NAME}-${envName}`,
    tags: {
      Project: APP_NAME,
      Environment: envName,
      ManagedBy: 'cdk',
    },
    retainData,
    network: resolveNetwork(source),
  };
}
