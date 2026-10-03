# Deploy assets

Source content uploaded into the storage bucket by CDK (`StorageStack` →
`ContentStorage` `BucketDeployment`). The directory layout maps to bucket
prefixes:

| Local path              | Bucket destination     | Served? |
| ----------------------- | ---------------------- | ------- |
| `assets/web_application/` | `web_application/`    | ✅ via CloudFront (OAC) |
| `assets/code/`          | `code/`                | ❌ deploy artifacts |
| `assets/db/`            | `code/db/`             | ❌ schema + seed SQL |

This is the **real** demo content, not placeholders: the Octank Hospitality SPA
(property pages, `llms.txt`, `openapi.json`, `robots.txt`, `sitemap.xml`), the
Python Lambda handlers, the OpenAPI specs, and the full hotel-booking schema +
sample data.

Notes:

- `web_application/openapi.json` is the CLEAN spec served to agents.
- `code/openapi-apigw-import.json` is the AUGMENTED spec (has
  `x-amazon-apigateway-*`) imported into API Gateway.
- `db/geo_demo_full.sql` is the self-contained, re-runnable hotel-booking schema
  + sample data. The DatabaseStack's `db-loader` custom resource reads it from
  `code/db/geo_demo_full.sql` and applies it to Aurora via the RDS Data API.
- Lambda source folders under `code/` are packaged as Lambda assets by the
  stacks that own them:
  - `api-handler/`, `citation-tracker/`, `patch-applier/`, `promoter/` — the
    ComputeStack functions. `citation-tracker/` also carries `prompts.json`.
  - `db-loader/` — the DatabaseStack schema-loader custom resource.
  - `chat-endpoint/` (worker), `chat-submit/`, `chat-poll/` — the
    ConciergeChatStack async submit/poll chat functions.
