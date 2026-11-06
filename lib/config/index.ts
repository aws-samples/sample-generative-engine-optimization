/*
 * Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT-0
 */

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
 * Object-key prefixes within the single storage bucket. Consumers reference
 * these constants rather than hard-coding strings, so the layout stays
 * consistent across stacks.
 */
export const STORAGE_PREFIXES = {
  /** Single-page web application served via CloudFront (OAC origin path). */
  webApplication: 'web_application/',
  /** Deploy artifacts: Lambda code, OpenAPI import spec, DB DDL/seed (NOT served). */
  code: 'code/',
  /** All logs. */
  logs: 'logs/',
  /** CloudFront standard access logs. */
  cloudFrontLogs: 'logs/cf_logs/',
  /** Athena query results / logs. */
  athenaResults: 'logs/athena_logs/',
  /** S3 server access logs (the bucket logs to itself under this prefix). */
  s3AccessLogs: 'logs/s3/',
  /** VPC Flow Logs delivered to S3. */
  vpcFlowLogs: 'logs/vpc_flow/',
  /** Feedback-loop staging area: agent corrections awaiting review/promotion. */
  staging: 'staging/',
} as const;

/**
 * Storage configuration for the {@link StorageStack} / ContentStorage construct.
 * A single bucket holds the content/, logs/ and code/ prefixes; the values here
 * tune lifecycle behavior. Every value has a default (see
 * {@link STORAGE_DEFAULTS}) and can be overridden via CDK context.
 */
export interface StorageConfig {
  /** Expire objects under logs/ after this many days. */
  readonly logRetentionDays: number;
  /** Expire Athena query results (logs/athena/) after this many days. */
  readonly queryResultRetentionDays: number;
  /** Transition content/ objects to Infrequent Access after this many days. */
  readonly contentIaTransitionDays: number;
  /** Expire noncurrent object versions after this many days. */
  readonly noncurrentVersionRetentionDays: number;
}

/**
 * Compute configuration for the {@link ComputeStack} / BlogApi construct.
 * Every value has a default (see {@link COMPUTE_DEFAULTS}) and can be overridden
 * at deploy time via CDK context.
 */
export interface ComputeConfig {
  /** Lambda memory (MB), applied to all functions. */
  readonly lambdaMemoryMb: number;
  /** api-handler timeout (seconds). */
  readonly apiTimeoutSeconds: number;
  /** citation-tracker timeout (seconds). */
  readonly citationTimeoutSeconds: number;
  /** patch-applier / promoter timeout (seconds). */
  readonly workerTimeoutSeconds: number;
  /** API Gateway stage name. */
  readonly apiStageName: string;
  /** API Gateway throttling: steady-state requests/sec. */
  readonly apiThrottleRateLimit: number;
  /** API Gateway throttling: burst requests. */
  readonly apiThrottleBurstLimit: number;
  /** CloudWatch metrics namespace used by the workers. */
  readonly metricsNamespace: string;
  /** Bedrock model id used by the citation tracker. */
  readonly bedrockModelId: string;
  /**
   * Citation-tracker scoring mode: 'brand_mention' (cold training-recall
   * baseline) or 'grounded' (score how well the model answers from the
   * property's JSON-LD; mirrors retrieval/RAG and lets a staged fix show a
   * real improvement). Default 'grounded'.
   */
  readonly citationScoreMode: string;
}

/**
 * Edge configuration for the {@link EdgeStack} / BlogDistribution construct.
 * Every value has a default (see {@link EDGE_DEFAULTS}) and can be overridden
 * at deploy time via CDK context.
 */
export interface EdgeConfig {
  /** CloudFront price class: 'all' | '200' | '100'. */
  readonly priceClass: 'all' | '200' | '100';
  /** Default root object served for the SPA. */
  readonly defaultRootObject: string;
  /** Path pattern routed to the API origin. */
  readonly apiPathPattern: string;
}

/**
 * Monitoring / logging configuration for the {@link MonitoringStack} /
 * BlogObservability construct. Every value has a default (see
 * {@link MONITORING_DEFAULTS}) and can be overridden via CDK context.
 */
export interface MonitoringConfig {
  /** VPC Flow Log traffic to capture: 'ALL' | 'ACCEPT' | 'REJECT'. */
  readonly flowLogTrafficType: 'ALL' | 'ACCEPT' | 'REJECT';
}

/**
 * Workflow configuration for the {@link WorkflowStack} / BlogWorkflow construct
 * (the GEO feedback-loop Step Function). Every value has a default (see
 * {@link WORKFLOW_DEFAULTS}) and can be overridden via CDK context.
 */
export interface WorkflowConfig {
  /** Enable CloudWatch logging for the state machine executions. */
  readonly enableLogging: boolean;
  /**
   * Enable the EventBridge Scheduler schedule that triggers the feedback-loop
   * state machine on a recurring cadence.
   */
  readonly enableSchedule: boolean;
  /**
   * Schedule expression for the recurring trigger (EventBridge Scheduler
   * syntax, e.g. `rate(7 days)` or `cron(...)`).
   */
  readonly scheduleExpression: string;
  /** IANA timezone the schedule expression is evaluated in (e.g. America/Chicago). */
  readonly scheduleTimezone: string;
}

/**
 * Analytics configuration for the {@link AnalyticsStack} (Athena over the
 * CloudFront access logs in S3). Every value has a default (see
 * {@link ANALYTICS_DEFAULTS}) and can be overridden via CDK context.
 */
export interface AnalyticsConfig {
  /** Glue database name holding the log table(s). */
  readonly databaseName: string;
  /** Glue table name over the CloudFront logs. */
  readonly tableName: string;
  /** Athena workgroup name. */
  readonly workgroupName: string;
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
  /** Storage settings (single S3 bucket lifecycle tuning). */
  readonly storage: StorageConfig;
  /** Compute settings (Lambdas + API Gateway). */
  readonly compute: ComputeConfig;
  /** Edge settings (CloudFront distribution). */
  readonly edge: EdgeConfig;
  /** Monitoring / logging settings. */
  readonly monitoring: MonitoringConfig;
  /** Workflow (Step Function feedback loop) settings. */
  readonly workflow: WorkflowConfig;
  /** Analytics (Athena + Glue over CloudFront logs) settings. */
  readonly analytics: AnalyticsConfig;
}

const APP_NAME = 'geo-demo';
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
  dbName: 'geo_db',
  engineVersion: '16.13',
  minAcu: 0.5,
  maxAcu: 2,
  readers: 0,
  enableProxy: false,
  enableRotation: false,
};

/**
 * Centralized storage defaults. Lifecycle windows for the single bucket's
 * prefixes. Override any of these via CDK context.
 */
export const STORAGE_DEFAULTS: StorageConfig = {
  logRetentionDays: 90,
  queryResultRetentionDays: 30,
  contentIaTransitionDays: 90,
  noncurrentVersionRetentionDays: 30,
};

/**
 * Centralized compute defaults. Per-function timeouts mirror the discovered
 * live functions (api 30s, citation 300s, workers 3s). Override via context.
 */
export const COMPUTE_DEFAULTS: ComputeConfig = {
  lambdaMemoryMb: 128,
  apiTimeoutSeconds: 30,
  citationTimeoutSeconds: 300,
  workerTimeoutSeconds: 3,
  apiStageName: 'prod',
  apiThrottleRateLimit: 50,
  apiThrottleBurstLimit: 100,
  metricsNamespace: 'GEO/CitationTracker',
  bedrockModelId: 'global.anthropic.claude-sonnet-4-6',
  citationScoreMode: 'grounded',
};

/**
 * Centralized edge defaults. Mirrors the reference distribution (PriceClass_All,
 * index.html root). Override via context.
 */
export const EDGE_DEFAULTS: EdgeConfig = {
  priceClass: 'all',
  defaultRootObject: 'index.html',
  apiPathPattern: '/api/*',
};

/** Centralized monitoring/logging defaults. Override via context. */
export const MONITORING_DEFAULTS: MonitoringConfig = {
  flowLogTrafficType: 'ALL',
};

/** Centralized workflow defaults. Override via context. */
export const WORKFLOW_DEFAULTS: WorkflowConfig = {
  enableLogging: true,
  // Mirrors the live geo-feedback-loop-weekly schedule in us-east-1.
  enableSchedule: true,
  scheduleExpression: 'rate(7 days)',
  scheduleTimezone: 'America/Chicago',
};

/**
 * Centralized analytics defaults. Names match the default `geo-demo-dev` prefix
 * (Glue DB name underscored, workgroup `${prefix}-analytics`). Override via
 * context.
 */
export const ANALYTICS_DEFAULTS: AnalyticsConfig = {
  databaseName: 'geo_demo_dev_logs',
  tableName: 'cloudfront_logs',
  workgroupName: 'geo-demo-dev-analytics',
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
 * Resolve storage config: start from {@link STORAGE_DEFAULTS}, then apply any
 * per-value overrides supplied via CDK context, validating each one.
 *
 * Supported context keys (all optional):
 *   -c logRetentionDays=180
 *   -c queryResultRetentionDays=14
 *   -c contentIaTransitionDays=120
 *   -c noncurrentVersionRetentionDays=60
 */
function resolveStorage(source?: ContextSource): StorageConfig {
  const dayRange = { min: 1, max: 3650 };
  return {
    logRetentionDays: intOverride(
      readContext(source, 'logRetentionDays'),
      STORAGE_DEFAULTS.logRetentionDays,
      'logRetentionDays',
      dayRange,
    ),
    queryResultRetentionDays: intOverride(
      readContext(source, 'queryResultRetentionDays'),
      STORAGE_DEFAULTS.queryResultRetentionDays,
      'queryResultRetentionDays',
      dayRange,
    ),
    contentIaTransitionDays: intOverride(
      readContext(source, 'contentIaTransitionDays'),
      STORAGE_DEFAULTS.contentIaTransitionDays,
      'contentIaTransitionDays',
      dayRange,
    ),
    noncurrentVersionRetentionDays: intOverride(
      readContext(source, 'noncurrentVersionRetentionDays'),
      STORAGE_DEFAULTS.noncurrentVersionRetentionDays,
      'noncurrentVersionRetentionDays',
      dayRange,
    ),
  };
}

/**
 * Resolve compute config: start from {@link COMPUTE_DEFAULTS}, then apply any
 * per-value overrides supplied via CDK context, validating each one.
 *
 * Supported context keys (all optional):
 *   -c lambdaMemoryMb=256
 *   -c apiTimeoutSeconds=30
 *   -c citationTimeoutSeconds=300
 *   -c workerTimeoutSeconds=10
 *   -c apiStageName=prod
 *   -c apiThrottleRateLimit=100
 *   -c apiThrottleBurstLimit=200
 *   -c metricsNamespace=GEO/CitationTracker
 *   -c bedrockModelId=global.anthropic.claude-sonnet-4-6
 */
function resolveCompute(source?: ContextSource): ComputeConfig {
  const timeoutRange = { min: 1, max: 900 };
  return {
    lambdaMemoryMb: intOverride(
      readContext(source, 'lambdaMemoryMb'),
      COMPUTE_DEFAULTS.lambdaMemoryMb,
      'lambdaMemoryMb',
      { min: 128, max: 10240 },
    ),
    apiTimeoutSeconds: intOverride(
      readContext(source, 'apiTimeoutSeconds'),
      COMPUTE_DEFAULTS.apiTimeoutSeconds,
      'apiTimeoutSeconds',
      timeoutRange,
    ),
    citationTimeoutSeconds: intOverride(
      readContext(source, 'citationTimeoutSeconds'),
      COMPUTE_DEFAULTS.citationTimeoutSeconds,
      'citationTimeoutSeconds',
      timeoutRange,
    ),
    workerTimeoutSeconds: intOverride(
      readContext(source, 'workerTimeoutSeconds'),
      COMPUTE_DEFAULTS.workerTimeoutSeconds,
      'workerTimeoutSeconds',
      timeoutRange,
    ),
    apiStageName: String(readContext(source, 'apiStageName') ?? COMPUTE_DEFAULTS.apiStageName),
    apiThrottleRateLimit: intOverride(
      readContext(source, 'apiThrottleRateLimit'),
      COMPUTE_DEFAULTS.apiThrottleRateLimit,
      'apiThrottleRateLimit',
      { min: 1, max: 10000 },
    ),
    apiThrottleBurstLimit: intOverride(
      readContext(source, 'apiThrottleBurstLimit'),
      COMPUTE_DEFAULTS.apiThrottleBurstLimit,
      'apiThrottleBurstLimit',
      { min: 1, max: 10000 },
    ),
    metricsNamespace: String(
      readContext(source, 'metricsNamespace') ?? COMPUTE_DEFAULTS.metricsNamespace,
    ),
    bedrockModelId: String(
      readContext(source, 'bedrockModelId') ?? COMPUTE_DEFAULTS.bedrockModelId,
    ),
    citationScoreMode: String(
      readContext(source, 'citationScoreMode') ?? COMPUTE_DEFAULTS.citationScoreMode,
    ),
  };
}

/**
 * Resolve edge config: start from {@link EDGE_DEFAULTS}, then apply any
 * per-value overrides supplied via CDK context, validating each one.
 *
 * Supported context keys (all optional):
 *   -c priceClass=100        (one of: all, 200, 100)
 *   -c defaultRootObject=index.html
 *   -c apiPathPattern=/api/*
 */
function resolveEdge(source?: ContextSource): EdgeConfig {
  const rawPrice = readContext(source, 'priceClass');
  const priceClass = rawPrice === undefined || rawPrice === '' ? EDGE_DEFAULTS.priceClass : String(rawPrice);
  if (!['all', '200', '100'].includes(priceClass)) {
    throw new Error(`Context "priceClass" must be one of all|200|100, got "${priceClass}".`);
  }
  return {
    priceClass: priceClass as EdgeConfig['priceClass'],
    defaultRootObject: String(
      readContext(source, 'defaultRootObject') ?? EDGE_DEFAULTS.defaultRootObject,
    ),
    apiPathPattern: String(readContext(source, 'apiPathPattern') ?? EDGE_DEFAULTS.apiPathPattern),
  };
}

/**
 * Resolve monitoring config: start from {@link MONITORING_DEFAULTS}, then apply
 * any per-value overrides supplied via CDK context, validating each one.
 *
 * Supported context keys (all optional):
 *   -c flowLogTrafficType=REJECT   (one of: ALL, ACCEPT, REJECT)
 */
function resolveMonitoring(source?: ContextSource): MonitoringConfig {
  const raw = readContext(source, 'flowLogTrafficType');
  const flowLogTrafficType =
    raw === undefined || raw === '' ? MONITORING_DEFAULTS.flowLogTrafficType : String(raw).toUpperCase();
  if (!['ALL', 'ACCEPT', 'REJECT'].includes(flowLogTrafficType)) {
    throw new Error(
      `Context "flowLogTrafficType" must be one of ALL|ACCEPT|REJECT, got "${flowLogTrafficType}".`,
    );
  }
  return { flowLogTrafficType: flowLogTrafficType as MonitoringConfig['flowLogTrafficType'] };
}

/**
 * Resolve workflow config: start from {@link WORKFLOW_DEFAULTS}, then apply any
 * per-value overrides supplied via CDK context.
 *
 * Supported context keys (all optional):
 *   -c workflowLogging=false
 *   -c workflowSchedule=false
 *   -c workflowScheduleExpression="cron(0 12 ? * MON *)"
 *   -c workflowScheduleTimezone=UTC
 */
function resolveWorkflow(source?: ContextSource): WorkflowConfig {
  return {
    enableLogging: boolOverride(
      readContext(source, 'workflowLogging'),
      WORKFLOW_DEFAULTS.enableLogging,
      'workflowLogging',
    ),
    enableSchedule: boolOverride(
      readContext(source, 'workflowSchedule'),
      WORKFLOW_DEFAULTS.enableSchedule,
      'workflowSchedule',
    ),
    scheduleExpression: String(
      readContext(source, 'workflowScheduleExpression') ?? WORKFLOW_DEFAULTS.scheduleExpression,
    ),
    scheduleTimezone: String(
      readContext(source, 'workflowScheduleTimezone') ?? WORKFLOW_DEFAULTS.scheduleTimezone,
    ),
  };
}

/**
 * Resolve analytics config: start from {@link ANALYTICS_DEFAULTS}, then apply
 * any per-value overrides supplied via CDK context.
 *
 * Supported context keys (all optional):
 *   -c analyticsDatabaseName=geo_demo_dev_logs
 *   -c analyticsTableName=cloudfront_logs
 *   -c analyticsWorkgroupName=geo-demo-dev-analytics
 */
function resolveAnalytics(source?: ContextSource): AnalyticsConfig {
  return {
    databaseName: String(
      readContext(source, 'analyticsDatabaseName') ?? ANALYTICS_DEFAULTS.databaseName,
    ),
    tableName: String(readContext(source, 'analyticsTableName') ?? ANALYTICS_DEFAULTS.tableName),
    workgroupName: String(
      readContext(source, 'analyticsWorkgroupName') ?? ANALYTICS_DEFAULTS.workgroupName,
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
    storage: resolveStorage(source),
    compute: resolveCompute(source),
    edge: resolveEdge(source),
    monitoring: resolveMonitoring(source),
    workflow: resolveWorkflow(source),
    analytics: resolveAnalytics(source),
  };
}
