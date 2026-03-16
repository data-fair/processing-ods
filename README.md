# <img alt="Data FAIR logo" src="https://cdn.jsdelivr.net/gh/data-fair/data-fair@master/ui/public/assets/logo.svg" width="30"> @data-fair/processing-ods

Plugin for [data-fair/processings](https://github.com/data-fair/processings) to import datasets from an OpenDataSoft portal into Data-Fair.

## Features

- **Dataset import** — import datasets from an OpenDataSoft portal into your Data-Fair instance
- **Metadata preservation** — transfers dataset metadata including title, description, keywords, license, and themes
- **Parallel processing** — handles multiple datasets concurrently for efficient imports
- **Field mapping** — preserves field definitions from the original ODS datasets

## Configuration

| Tab | Field | Description |
| --- | ----- | ----------- |
| General | `url` | OpenDataSoft portal URL (e.g., `https://data.example.com`) |

## Release

Processing plugins are fetched from the npm registry with a filter on keyword "data-fair-processings-plugin". So publishing a plugin is as simple as publishing the npm package:

```bash
npm version minor
npm publish
git push --follow-tags
```
