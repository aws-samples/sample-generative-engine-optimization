# Documentation

Technical documentation for the **Octank Hospitality** GEO CDK app. Start with
the [project README](../README.md) for a high-level overview, then dive in:

| Document | What's inside |
| -------- | ------------- |
| [LAYERS.md](LAYERS.md) | Per-layer technical deep-dive — Network, Storage, Database, Compute, Edge, Workflow, Logging, Analytics, and the synth-only AI + Chat layers. |
| [ADR.md](ADR.md) | Architecture decision records — the significant decisions (stack-per-concern, RDS Data API, single NAT, stage-only loop, one-direction cross-stack refs, async chat, two-tier tests). |
| [ARCHITECTURE.md](ARCHITECTURE.md) | System overview, stack-by-stack detail, request + feedback-loop flows, cross-stack references and dependency-cycle avoidance, deploy order. |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Prerequisites, bootstrap, build/test/synth, deploy order, the two-phase `distributionId` step, verification, log locations, teardown, and troubleshooting. |
| [CONFIGURATION.md](CONFIGURATION.md) | Complete config reference — every context key, default, and validation rule; how resolution and overrides work; storage prefixes. |
| [SECURITY.md](SECURITY.md) | Network isolation, per-Lambda IAM least-privilege, encryption, secrets, the cdk-nag baseline with every suppression justified, and prototype trade-offs. |
| [GEO Blog - LLM specific Production Hardening Guide.md](GEO%20Blog%20-%20LLM%20specific%20Production%20Hardening%20Guide.md) | Pre-production checklist for the public concierge chat — the LLM/public-endpoint risks (prompt injection, denial-of-wallet, excessive agency, info disclosure) that code scanners miss, what to do about each, and what the sample already handles. |
| [ADAPTING.md](ADAPTING.md) | What you keep vs. what you adapt for your own business — the exact code slots to change (`_FIX_KEYWORDS`, page resolution, `FIX_MAP`, prompts), config-only knobs, and notes on the sample data. |

## Quick links

- **Config source of truth:** [`lib/config/index.ts`](../lib/config/index.ts)
- **App entry point / stack wiring:** [`bin/app.ts`](../bin/app.ts)
- **Stacks:** [`lib/stacks/`](../lib/stacks/)
- **Reusable constructs:** [`lib/constructs/`](../lib/constructs/) (see its
  [README](../lib/constructs/README.md) for the construct→stack mapping)
- **Deploy assets** (uploaded to S3): [`assets/`](../assets/) (see its
  [README](../assets/README.md))

## Status

All ten stacks are wired in `bin/app.ts`: Network, Storage, Database, Compute,
Ai, Analytics, Edge, ConciergeChat, Workflow, and Monitoring (logging module).
Network, Storage, Database, Compute, Edge, Workflow, Monitoring, and Analytics
are implemented and verified by unit/synth tests. `AiStack` (AgentCore Gateway +
managed Harness concierge) and `ConciergeChatStack` (async submit/poll chat API)
build and `cdk synth` clean but are the newest, least-exercised stacks and have
not yet been verified against a live deploy — see
[DEPLOYMENT.md](DEPLOYMENT.md).
