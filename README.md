# <img alt="Data FAIR logo" src="https://cdn.jsdelivr.net/gh/data-fair/data-fair@master/ui/public/assets/logo.svg" width="30"> @data-fair/processing-ods

Plugin for [data-fair/processings](https://github.com/data-fair/processings) to import datasets from an OpenDataSoft portal into Data-Fair.

## Features

- **Dataset import** — import datasets from an OpenDataSoft portal into your Data-Fair instance
- **Metadata preservation** — transfers dataset metadata including title, description, keywords, license, and themes
- **Parallel processing** — handles multiple datasets concurrently for efficient imports
- **Field mapping** — preserves field definitions from the original ODS datasets
- **Federated datasets** — optionally import datasets federated from partner ODS portals (via the shared catalog), with provenance pointing to their source portal

## Configuration

| Tab | Field | Description |
| --- | ----- | ----------- |
| General | `url` | OpenDataSoft portal URL (e.g., `https://data.example.com`) |
| Parameters | `includeFederated` | Also list and import datasets federated from partner ODS portals (default: off) |

## Release

Publishing is handled automatically by CI: the plugin is pushed to the data-fair registry (`@data-fair/registry`), not to the public npm registry — there is no manual `npm publish`. A push to `main`/`master` publishes to the staging registry; pushing a `v*` tag publishes to production:

```bash
npm version minor       # version bump + v* tag
git push --follow-tags  # CI publishes to the production registry
```
