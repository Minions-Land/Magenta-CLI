# Magenta model catalog

These files are **generated**; do not edit them by hand. They are produced by
`scripts/generate-public-model-catalog.mjs` in the Magenta source repository
from the model data compiled into the released `magenta` binary, and contain
no model data beyond what that binary already ships.

| Path | Content |
|---|---|
| `catalog/v1/models.json` | The whole catalog: `{ schemaVersion, generatedAt, digest, providers: { <provider>: [models] } }` |
| `catalog/v1/providers/<provider>.json` | One provider: `{ schemaVersion, generatedAt, digest, provider, models }` |
| `catalog/v1/schema.json` | JSON Schema for both documents |

`digest` is `sha256:` followed by the SHA-256 of `JSON.stringify` of the parsed
`providers` (whole catalog) or `models` (one provider). `generatedAt` is the
generation time of the model data the files were made from.

Magenta reads `providers/<provider>.json` in the background for providers you
have signed in to or configured, at most every four hours. It verifies the
schema version, provider and digest, and applies the entries only when they are
newer than the data built into your binary and use a request route (API and
base URL) that the built-in provider already uses. It never waits for this at
startup, keeps the last good copy in `models-store.json`, falls back to the
built-in catalog when the files cannot be read, does not follow redirects,
refuses documents over 2 MiB, and makes no request with `--offline` or
`PI_OFFLINE=1`.
