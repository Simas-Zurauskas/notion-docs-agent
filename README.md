# strive2-ci

Shared CI workflows and scripts for the Strive2 platform. Used by [api](https://github.com/Simas-Zurauskas/strive2-api) and [client](https://github.com/Simas-Zurauskas/strive2-client) repos via GitHub reusable workflows.

## Workflows

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `notion-sync.yml` | `workflow_call` | Incremental Notion docs sync on each push to master |
| `notion-rebuild.yml` | `workflow_call` | Full Notion docs rebuild (manual dispatch) |

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

| Secret | Used by |
|--------|---------|
| `ANTHROPIC_API_KEY` | Both |
| `NOTION_API_KEY` | Both |
| `NOTION_TECHNICAL_ROOT_ID` | Both |
| `SKIP_PAGE_IDS` | Rebuild only |

## Scripts

All scripts live in `scripts/` and are checked out at runtime by the reusable workflows.

| Script | Purpose |
|--------|---------|
| `notion-sync.js` | AI-driven incremental doc sync from code diffs |
| `rebuild-docs.js` | Multi-agent full documentation rebuild |
| `fetch-notion-docs.js` | Fetches existing Notion pages as markdown |
| `notion-tool.js` | CLI for Notion CRUD operations (rewrite, create, delete, rename) |
| `doc-standards.js` | Shared documentation quality standards |
