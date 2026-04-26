# notion-docs-agent

Reusable GitHub workflow and scripts that keep a Notion-hosted knowledge base in sync with one or more source repositories. **Notion is the durable doc store** — page content lives there, not in any git repo. CI bridges the two stores: on every push to a consumer repo, it computes the diff, verifies the corresponding Notion pages against the changed source files, regenerates pages that have drifted, and pushes the new content back to Notion.

Bootstrap (skill-driven, manual one-time) and steady-state CI (per push, automated) are deliberately separated. CI handles the steady stream; the skill handles full audits and structural changes.

## Two stores, three actors

| Store | Holds | Mutated by |
| --- | --- | --- |
| **Git** (consumer repos) | Source code; small `.notion-docs/` config (plan + notion-map). | Engineers (code), bootstrap step (config). |
| **Notion** | Documentation page content. | Bootstrap upload (initial), CI (per-push regens). |

Three actors:
1. **The wiki-system Claude Code skill** — runs locally in the project root, generates the unified `wiki/` covering all repos.
2. **The bootstrap upload** — manual: push wiki/ markdown to Notion, capture page-id mappings, commit a small `.notion-docs/` config to each consumer repo.
3. **CI** — runs in each consumer repo; reads diff, talks to Notion, no git commits for documentation.

## Bootstrap (one-time, per project)

1. **Generate the wiki locally.** In your project root (the directory that contains all consumer repos as subdirectories), run the wiki-system Claude Code skill — its `init.md` orchestrator. Produces `wiki/` with `.plan.yaml`, `reference/`, and `working/`.

2. **Manually upload to Notion.** Create a Notion page tree mirroring `wiki/reference/`. Use `scripts/notion-tool.js create` for CLI-driven creation, or do it via the Notion UI. Capture each page's Notion page id.

3. **Create `wiki/.notion-map.json` locally** mapping each plan page id (e.g. `api/architecture`) to its Notion page id.

4. **Commit `.notion-docs/` to each consumer repo.** For every repo that should receive CI updates:
   ```sh
   mkdir -p <consumer-repo>/.notion-docs
   cp wiki/.plan.yaml          <consumer-repo>/.notion-docs/plan.yaml
   cp wiki/.notion-map.json    <consumer-repo>/.notion-docs/notion-map.json
   ```
   Both files are project-wide (the same plan and map across consumers); each consumer's CI filters to its own slice via `consumer_repo_name`.

5. **Add the workflow** to each consumer repo at `.github/workflows/wiki-sync.yml`:
   ```yaml
   name: "Wiki Sync"
   on:
     push:
       branches: [main]   # or master
     workflow_dispatch:
   jobs:
     sync:
       uses: Simas-Zurauskas/notion-docs-agent/.github/workflows/wiki-sync.yml@master
       secrets: inherit
   ```
   `consumer_repo_name` defaults to the calling repo's GitHub name; override only if your plan's path prefixes differ from your repo's name.

6. **Set secrets** in each consumer repo (Settings → Secrets → Actions):
   - `ANTHROPIC_API_KEY` — for the verifier and writer sub-agents.
   - `NOTION_API_KEY` — for Notion read and rewrite.

7. **Push.** The workflow runs the verify-first sync.

## What CI does on every push

1. **Phase 0 — validation gates.** Load `.notion-docs/plan.yaml` and `.notion-docs/notion-map.json`. Walk every plan page's `scope_files`; flag pages where the consumer's slice (paths starting with `consumer_repo_name/`) matches nothing on disk (plan rot — skip these).
2. **Phase 1 — affected pages.** Take `git diff` between the previous and current commit. Prefix each path with `<consumer_repo_name>/` and intersect against `scope_files`. The result is the set of pages whose source code changed in this push.
3. **Phase 2 — verify.** For each affected page, fetch the current markdown from Notion, dispatch a verifier sub-agent that reads `scope_files` and judges drift. Verdicts: `pass`, `fail_soft` (1–3 improvements, no critical), `fail_hard` (4+ improvements OR any critical).
4. **Phase 3 — regenerate, re-verify, push.** For each non-pass page: dispatch a writer sub-agent producing new markdown. Re-verify against the new markdown (one auto-fix retry; persistent fail_soft escalates to fail_hard). Pages that pass re-verification are pushed to Notion. Pages that don't are NOT pushed — the previous Notion content stands.
5. **Narrative report.** A per-phase prose summary (header, summary table, Notable findings with one-sentence whys pulled from verifier/writer reasoning, Anomalies for fail_hard / plan rot / unmapped / errors, ripples) is appended to `$GITHUB_STEP_SUMMARY` so it renders on the workflow run page. For local runs it goes to stdout.
6. **Telemetry.** Per-run JSON report uploaded as a workflow artifact (30-day retention).

CI never commits to git. CI never modifies any consumer repo's source code. CI only reads from git (diff, source files); only writes to Notion (regenerated pages).

## What CI does NOT do

CI is **diff-driven by design**. It can't see:
- **Coverage gaps** — new source files no plan page covers.
- **Page thinning** — pages whose source has grown 2× the planned estimate.
- **Plan drift across many pages** — gradual structural staleness.

These are the gaps the skill's `recheck.md` covers. **Run the wiki-system skill's recheck mode locally every 2–4 weeks** (or before any major release). It performs a full breadth audit, surfaces coverage gaps for human review, and refreshes anything CI missed.

CI + periodic recheck is the intended workflow. CI alone is not sufficient for long-term documentation health.

## Reusable prompt files

The `.md` files in `prompts/` are byte-identical copies of the corresponding files in the `wiki-system` Claude Code skill (`specialists/`, `spec/`). When the skill changes meaningfully, re-copy these.

| Prompt | Role |
| --- | --- |
| `specialists/technical.md` | Technical writer for engineering reference pages. |
| `specialists/product.md`   | Product writer (zero code references). |
| `specialists/verifier.md`  | Verifier — read-only, emits structured verdict. |
| `spec/plan-schema.md`      | Plan and verifier-report schema reference. |
| `spec/tracing.md`          | Event-log format reference. |

## Workflow

| Workflow | Trigger | Purpose |
| --- | --- | --- |
| `wiki-sync.yml` | `workflow_call` from each consumer's push to default branch | Verify-first incremental Notion sync; regen-on-fail; push only verified content. |

## Workflow inputs

| Input | Default | Purpose |
| --- | --- | --- |
| `consumer_repo_name` | `${{ github.event.repository.name }}` | The path prefix used in `plan.yaml`'s `scope_files` for this consumer (e.g. `"api"`). Override only if the repo's GitHub name differs from the prefix. |
| `regen_disabled` | `false` | Kill switch — skip verify+regen entirely. Useful during Anthropic API outages. |

## Required secrets (per consumer repo)

| Secret | Used by | Value |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | Verifier + writer sub-agents | Anthropic API key |
| `NOTION_API_KEY` | Notion read + rewrite | Notion integration token with write access on the doc tree |

## Scripts

| Script | Purpose |
| --- | --- |
| `wiki-sync.js` | The orchestrator. Implements the verify-first → regen-on-fail → push-on-pass flow. |
| `notion-tool.js` | Notion CRUD CLI — `read` (Notion → markdown), `rewrite`, `append`, `create`, `delete`, `rename`, `list`. Used during bootstrap and at runtime by the orchestrator. |

### Library

| Module | Purpose |
| --- | --- |
| `lib/agent.js` | Claude Agent SDK wrapper with retry/backoff for transient errors. |
| `lib/plan.js` | Load + validate `.notion-docs/plan.yaml`. |
| `lib/affected-pages.js` | `git diff` ∩ `scope_files`, with consumer-prefix logic. |
| `lib/scope-validator.js` | Plan-rot detection, scoped to the current consumer's slice. |
| `lib/verify-existing.js` | Verifier dispatch — fetches page from Notion, runs verifier sub-agent, returns verdict. |
| `lib/regen.js` | Writer dispatch — generates new markdown for failed pages. Does not write to disk; orchestrator decides whether to push. |
| `lib/wiki-to-notion.js` | Notion read (`fetchPageMarkdown`) and write (`pushPageMarkdown`) with retry. |
| `lib/telemetry.js` | Per-run JSON report → workflow artifact. |
| `lib/narrative.js` | Per-run prose summary builder + emitter for `$GITHUB_STEP_SUMMARY` (stdout fallback). |
| `lib/log-helpers.js` | Console formatting. |

## Reliability notes

- **Race between two consumer pushes**: the workflow uses `concurrency: wiki-sync-${{ github.repository }}` so a same-repo push waits for the prior run. Cross-consumer races are fine — Notion's last-write-wins is per-page and pages are independent.
- **Anthropic API flakiness**: agents retry on 429/5xx with exponential backoff (3 attempts).
- **Notion API flakiness**: read and write paths each have independent retry layers (3 attempts, exponential backoff).
- **Stateless run model**: nothing persists between runs except what's already in git (the plan + notion-map) and Notion (page content). Each run is independent and idempotent for unchanged pages.
- **Hand-edit zones**: `<!-- AUTOREGEN_SKIP_BEGIN/END -->` markers don't survive Notion's markdown→blocks→markdown round-trip. They work in the local skill flow (markdown on disk) but are effectively no-ops in the Notion-mediated CI flow. Document edits made directly in Notion will be overwritten on the next regen of that page.
- **fail_hard pages**: regenerated content that fails re-verification is NOT pushed to Notion. The previous content stands. Surfaced as a workflow alert and listed under **Anomalies** in the run's Step Summary narrative with the verifier's reasoning excerpt — that's the primary place to triage them.

## Development

```sh
cd scripts
npm install
# Run locally against a consumer repo:
CONSUMER_REPO_ROOT=/path/to/consumer \
CONSUMER_REPO_NAME=api \
ANTHROPIC_API_KEY=... \
NOTION_API_KEY=... \
BASE_SHA=$(git -C /path/to/consumer rev-parse HEAD~1) \
HEAD_SHA=$(git -C /path/to/consumer rev-parse HEAD) \
node wiki-sync.js
```
