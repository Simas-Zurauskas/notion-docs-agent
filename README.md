# strive2-ci

Shared CI workflows and scripts for the Strive2 platform. Used by [api](https://github.com/Simas-Zurauskas/strive2-api) and [client](https://github.com/Simas-Zurauskas/strive2-client) repos via GitHub reusable workflows.

## What It Does

On every push to master, two Notion documentation syncs run automatically:

1. **Technical sync** — Updates [Technical](https://www.notion.so/336c2628ef9581bf8806d8b738a2d8eb) pages with code-level detail (architecture, schemas, endpoints, conventions)
2. **Product sync** — Updates [How Strive Works](https://www.notion.so/338c2628ef9581c1afd6de5c29af8bd1) pages with product-level descriptions (user flows, business logic, feature mechanics)

Both use Claude Sonnet to assess the diff, decide which pages need updating, and generate the content in the appropriate style. Technical docs reference code directly; product docs never mention file paths, function names, or endpoints.

## Workflows

| Workflow             | Trigger         | Purpose                                                   |
| -------------------- | --------------- | --------------------------------------------------------- |
| `notion-sync.yml`    | Push to master  | Runs both technical + product syncs sequentially          |
| `notion-rebuild.yml` | Manual dispatch | Full technical docs rebuild via multi-agent orchestration |

## Usage

In consumer repos, add thin caller workflows:

```yaml
# .github/workflows/notion-sync.yml
name: "Knowledge Base: Sync"
on:
  push:
    branches: [master]
  workflow_dispatch:

jobs:
  sync:
    uses: Simas-Zurauskas/strive2-ci/.github/workflows/notion-sync.yml@master
    secrets: inherit
```

```yaml
# .github/workflows/notion-rebuild.yml
name: "Knowledge Base: Rebuild"
on:
  workflow_dispatch:

jobs:
  rebuild:
    uses: Simas-Zurauskas/strive2-ci/.github/workflows/notion-rebuild.yml@master
    secrets: inherit
```

## Required Secrets (set in consumer repos)

| Secret                     | Used by                  | Value                                                             |
| -------------------------- | ------------------------ | ----------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`        | Both syncs + rebuild     | Anthropic API key                                                 |
| `NOTION_API_KEY`           | Both syncs + rebuild     | Notion integration token                                          |
| `NOTION_TECHNICAL_ROOT_ID` | Technical sync + rebuild | Technical page ID (`336c2628-ef95-81bf-8806-d8b738a2d8eb`)        |
| `NOTION_PRODUCT_ROOT_ID`   | Product sync             | How Strive Works page ID (`338c2628-ef95-81c1-afd6-de5c29af8bd1`) |
| `SKIP_TECHNICAL_PAGE_IDS`  | Technical sync + rebuild | Comma-separated page IDs to skip (pages owned by the other repo)  |

## Scripts

All scripts live in `scripts/` and are checked out at runtime by the reusable workflows.

### Sync (incremental, per push)

| Script                       | Purpose                                                                             |
| ---------------------------- | ----------------------------------------------------------------------------------- |
| `notion-sync-technical.js`   | AI-driven technical doc sync — assesses diff, rewrites/creates Technical pages      |
| `notion-sync-product.js`     | AI-driven product doc sync — assesses diff, rewrites/creates How Strive Works pages |
| `doc-standards-technical.js` | Writing standards for technical docs (code references, file paths, schemas)         |
| `doc-standards-product.js`   | Writing standards for product docs (no code references, accessible language)        |

### Rebuild (full, manual dispatch)

| Script                      | Purpose                                                     |
| --------------------------- | ----------------------------------------------------------- |
| `rebuild-docs-technical.js` | Multi-agent full technical documentation rebuild            |
| `fetch-notion-docs.js`      | Fetches existing Notion pages as markdown (used by rebuild) |

### Shared

| Script           | Purpose                                                          |
| ---------------- | ---------------------------------------------------------------- |
| `notion-tool.js` | CLI for Notion CRUD operations (rewrite, create, delete, rename) |
