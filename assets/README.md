# Deploy assets

Source content uploaded into the storage bucket by CDK (`StorageStack` →
`ContentStorage` `BucketDeployment`). The directory layout maps to bucket
prefixes:

| Local path              | Bucket destination     | Served? |
| ----------------------- | ---------------------- | ------- |
| `assets/web_application/` | `web_application/`    | ✅ via CloudFront (OAC) |
| `assets/code/`          | `code/`                | ❌ deploy artifacts |
| `assets/db/`            | `code/db/`             | ❌ DDL + seed schema |

These are **placeholder** files to wire the deployment end-to-end. Replace them
with the real single-page app, Lambda handlers, OpenAPI specs, and hotel
booking DDL/seed data as those land (e.g. synced from the app GitHub repo).

Notes:
- `web_application/openapi.json` is the CLEAN spec served to agents.
- `code/openapi-apigw-import.json` is the AUGMENTED spec (has
  `x-amazon-apigateway-*`) imported into API Gateway.
- Lambda source folders (`api-handler/`, `citation-tracker/`, `patch-applier/`,
  `promoter/`) are uploaded as-is for now; when the ComputeStack is built they
  may instead be packaged as Lambda assets directly.
