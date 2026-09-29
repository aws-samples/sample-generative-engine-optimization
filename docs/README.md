# Documentation

Technical documentation for the **Octank Hospitality** GEO CDK app. Start with
the [project README](../README.md) for a high-level overview, then dive in:

| Document | What's inside |
| -------- | ------------- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | System overview, stack-by-stack detail, request + feedback-loop flows, cross-stack references and dependency-cycle avoidance, deploy order. |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Prerequisites, bootstrap, build/test/synth, deploy order, the two-phase `distributionId` step, verification, log locations, teardown, and troubleshooting. |
| [CONFIGURATION.md](CONFIGURATION.md) | Complete config reference — every context key, default, and validation rule; how resolution and overrides work; storage prefixes. |
| [SECURITY.md](SECURITY.md) | Network isolation, per-Lambda IAM least-privilege, encryption, secrets, the cdk-nag baseline with every suppression justified, and prototype trade-offs. |

## Quick links

- **Config source of truth:** [`lib/config/index.ts`](../lib/config/index.ts)
- **App entry point / stack wiring:** [`bin/app.ts`](../bin/app.ts)
- **Stacks:** [`lib/stacks/`](../lib/stacks/)
- **Reusable constructs:** [`lib/constructs/`](../lib/constructs/) (see its
  [README](../lib/constructs/README.md) for the construct→stack mapping)
- **Deploy assets** (uploaded to S3): [`assets/`](../assets/) (see its
  [README](../assets/README.md))

## Status

Six of eight stacks are implemented: Network, Storage, Database, Compute, Edge,
and Monitoring (logging module). `AiStack` (Bedrock agent) and `AnalyticsStack`
(Athena) remain as documented placeholders.
