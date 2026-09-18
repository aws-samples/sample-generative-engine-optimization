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
 * Database configuration for the {@link DatabaseStack} / BlogDatabase construct.
 * Every value has a default (see {@link DATABASE_DEFAULTS}) and can be
 * overridden at deploy time via CDK context.
 */
export interface DatabaseConfig {
  /** Initial database name created in the cluster. */
  readonly dbName: string;
  /** Aurora PostgreSQL engine version, as a "major.minor" string (e.g. "16.13"). */
  readonly engineVersion: string;
  /** Serverless v2 minimum capacity in ACUs. */
  readonly minAcu: number;
  /** Serverless v2 maximum capacity in ACUs. */
  readonly maxAcu: number;
  /** Number of reader instances (0 = writer only). */
  readonly readers: number;
  /** Provision an RDS Proxy in front of the cluster for connection pooling. */
  readonly enableProxy: boolean;
  /** Enable Secrets Manager rotation for the master credentials. */
  readonly enableRotation: boolean;
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
  /** Database settings (Aurora Serverless v2, credentials, proxy, rotation). */
  readonly database: DatabaseConfig;
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

/**
 * Centralized database defaults. Aurora PostgreSQL Serverless v2, writer-only,
 * proxy + rotation off (config-gated). Override any of these via CDK context.
 */
export const DATABASE_DEFAULTS: DatabaseConfig = {
  dbName: 'blog',
  engineVersion: '16.13',
  minAcu: 0.5,
  maxAcu: 2,
  readers: 0,
  enableProxy: false,
  enableRotation: false,
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

/** Parse a number (possibly fractional) from context, validating the range. */
function numberOverride(
  raw: unknown,
  fallback: number,
  key: string,
  { min = 0, max = Number.MAX_SAFE_INTEGER }: { min?: number; max?: number } = {},
): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`Context "${key}" must be a number, got "${String(raw)}".`);
  }
  if (value < min || value > max) {
    throw new Error(`Context "${key}" must be between ${min} and ${max}, got ${value}.`);
  }
  return value;
}

/** Parse a boolean from context (accepts booleans and "true"/"false" strings). */
function boolOverride(raw: unknown, fallback: boolean, key: string): boolean {
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (typeof raw === 'boolean') return raw;
  const value = String(raw).toLowerCase();
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`Context "${key}" must be true or false, got "${String(raw)}".`);
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

/** Aurora PostgreSQL Serverless v2 ACU range (0.5 min supported; 256 max). */
const ACU_MIN = 0.5;
const ACU_MAX = 256;

/**
 * Resolve database config: start from {@link DATABASE_DEFAULTS}, then apply any
 * per-value overrides supplied via CDK context, validating each one.
 *
 * Supported context keys (all optional):
 *   -c dbName=blog
 *   -c engineVersion=16.13
 *   -c minAcu=0.5
 *   -c maxAcu=2
 *   -c readers=1
 *   -c enableProxy=true
 *   -c enableRotation=true
 */
function resolveDatabase(source?: ContextSource): DatabaseConfig {
  const minAcu = numberOverride(readContext(source, 'minAcu'), DATABASE_DEFAULTS.minAcu, 'minAcu', {
    min: ACU_MIN,
    max: ACU_MAX,
  });
  const maxAcu = numberOverride(readContext(source, 'maxAcu'), DATABASE_DEFAULTS.maxAcu, 'maxAcu', {
    min: ACU_MIN,
    max: ACU_MAX,
  });
  if (maxAcu < minAcu) {
    throw new Error(`Context "maxAcu" (${maxAcu}) must be >= "minAcu" (${minAcu}).`);
  }

  const engineVersion = String(
    readContext(source, 'engineVersion') ?? DATABASE_DEFAULTS.engineVersion,
  );
  if (!/^\d+\.\d+$/.test(engineVersion)) {
    throw new Error(
      `Context "engineVersion" must be "major.minor" (e.g. 16.13), got "${engineVersion}".`,
    );
  }

  return {
    dbName: String(readContext(source, 'dbName') ?? DATABASE_DEFAULTS.dbName),
    engineVersion,
    minAcu,
    maxAcu,
    readers: intOverride(readContext(source, 'readers'), DATABASE_DEFAULTS.readers, 'readers', {
      min: 0,
      max: 15,
    }),
    enableProxy: boolOverride(
      readContext(source, 'enableProxy'),
      DATABASE_DEFAULTS.enableProxy,
      'enableProxy',
    ),
    enableRotation: boolOverride(
      readContext(source, 'enableRotation'),
      DATABASE_DEFAULTS.enableRotation,
      'enableRotation',
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
    database: resolveDatabase(source),
  };
}
