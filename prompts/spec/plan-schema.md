The canonical schema for `wiki/.plan.yaml` — the structured artifact produced
by the orchestrator in Phase 2 and consumed by every writer and verifier
downstream.

This file is a reference, not a prompt. Agents read it when they need to
understand a field's meaning or the invariants a plan must satisfy. The
orchestrator uses it when writing the plan; writers and verifiers use it
when reading the plan.

---

## WHO READS THIS

| Agent                                    | When                                                        |
| ---------------------------------------- | ----------------------------------------------------------- |
| Orchestrator (`../init.md`)            | Phase 2, when writing `wiki/.plan.yaml`                     |
| Writer (`../specialists/technical.md` under orch.) | At the start of each section's writing phase                |
| Writer (`../specialists/product.md` under orch.)   | Same                                                        |
| Verifier (`../specialists/verifier.md`)            | Phase 3d, when checking a draft's claims against the plan   |

If the schema below conflicts with any inline description elsewhere, this
file wins. Update this file first, then update references.

---

## SCHEMA

```yaml
meta:
  product_description: "<one paragraph — from Configuration or inferred>"
  state: bootstrap | growth | maintenance
  repos:
    - name: <string>
      path: <absolute path>
  generated_at: <ISO-8601 date>
  schema_version: "1.1"  # bump on breaking changes to this schema

# Sections correspond to folders under wiki/reference/. Section paths always
# start with wiki/reference/. The orchestrator never plans content under
# wiki/working/ or at the wiki root — those are hand-written.
# A section with has_overview: true produces an OVERVIEW.md at that folder.
# Nesting is arbitrary depth — use it. The scope-to-depth table below forces it.
sections:
  - id: <stable slug, e.g. reference/api/models>
    path: wiki/reference/<slug>/
    parent: <parent section id, or null for top-level>
    owner_agent: technical | product
    has_overview: true | false
    scope_loc_estimate: <integer — sum of source LOC this section documents>
    split_reason: "<why this section is a folder rather than a single page>"  # optional
    scan_summary: |
      <2-5 line structured summary: tech stack, key subsystems, entry points.
      This is what writers receive in lieu of re-scanning the project.>

# Pages are leaf documents. Page paths always start with wiki/reference/.
pages:
  - id: <stable slug, e.g. reference/api/models/user>
    path: wiki/reference/<slug>.md
    section: <section id this page belongs to>
    owner_agent: technical | product
    scope_files: [<glob or file paths relative to project root>]
    scope_loc_estimate: <integer>
    complexity: S | M | L | XL
    links_to: [<page or section ids this page must cross-link>]
    section_parity: strict | suggested | none
    state: new | rewrite | unchanged
    split_allowed: true | false  # may the page worker submit a split_request?

# Execution graph — how the scheduler fans out work.
execution:
  parallel_tracks:
    - <list of section ids that can run concurrently>
  depends_on:
    <section id>: [<section ids that must finish first>]  # usually empty
  stub_first: true  # always; see Phase 3a in ../init.md
```

Field order is free. Every listed field is required unless marked optional.

---

## FIELD SEMANTICS

### `sections[]`

- **id** — stable slug; used as the key when agents reference the section.
  Must match the path structure: `api/models` → `wiki/api/models/`.
- **parent** — the section id one level up. `null` for top-level sections
  (`api`, `client`, `product`).
- **owner_agent** — which specialist writes this section. `technical` maps
  to repo-scoped documentation; `product` maps to feature-scoped.
- **has_overview** — `true` means the section is a folder with an
  `OVERVIEW.md`. `false` means the section is a single leaf page (in which
  case `path` should end in `.md`, not `/`).
- **scope_loc_estimate** — sum of source LOC across all pages in this
  section. Used by the scope-to-depth rule.
- **scan_summary** — short structured summary of the subsystem. Writers use
  this instead of re-scanning the whole project; verifiers do not use it.

### `pages[]`

- **id** — stable slug matching `path` minus `wiki/reference/` and `.md`
  (e.g., `wiki/reference/api/authentication.md` → id `reference/api/authentication`,
  or just `api/authentication` if your project keeps ids unprefixed — pick one
  convention per project and document it).
- **section** — the id of the section this page belongs to. Every page
  belongs to exactly one section. Hand-written root files (`wiki/OVERVIEW.md`,
  `wiki/topics.md`) and the contents of `wiki/working/` are not part of the
  plan; they have no `section` because they are not in `pages[]` at all.
- **scope_files** — list of file paths or globs in the source repo that
  this page documents. The writer reads these; the verifier verifies
  claims against these.
- **scope_loc_estimate** — LOC count over `scope_files`. If the real scope
  exceeds this by a significant margin during the writer's deep scan, that
  is grounds for a `split_request`.
- **complexity** — coarse size bucket used for scheduling and for deciding
  whether a verifier pass is warranted:
  - `S` — 300–800 LOC, simple. Verifier may be skipped on runs where
    verification is selective.
  - `M` — 800–1,500 LOC, standard. Verifier always runs.
  - `L` — 1,500–3,000 LOC, substantial. Verifier always runs; extra weight
    in scheduler priority.
  - `XL` — 3,000+ LOC. Should almost always have been split per the
    scope-to-depth table; flag as a planning error.
- **links_to** — ids of other pages or sections this page must
  cross-reference. The orchestrator's stub-out phase uses this to create
  placeholder targets before any writer runs, so cross-links always
  resolve.
- **section_parity** — whether counterpart pages are required in sibling
  sections:
  - `strict` — must exist in every sibling (e.g., `authentication` must
    appear in api, client, and product).
  - `suggested` — usually worth having but not required.
  - `none` — intentionally one-sided (e.g., client-only accessibility).
- **state** — lifecycle for this page:
  - `new` — did not exist in the prior plan.
  - `rewrite` — exists but source has drifted; must be re-written.
  - `unchanged` — source is unchanged since last generation; may be skipped.
- **split_allowed** — if `true`, the writer may return a `split_request`
  when the page's real scope exceeds the plan. If `false`, the page must
  remain flat (used for cross-repo integration summaries that should not
  fragment).

### `execution`

- **parallel_tracks** — lists of section ids that may be scheduled
  concurrently. Empty nested lists mean no explicit constraint; the
  scheduler fills its pool freely.
- **depends_on** — mapping from a section id to the set of section ids
  that must complete before it starts. Usually empty. Use it only when a
  section's content materially depends on another section having been
  written first (rare — cross-links use stub-first instead).
- **stub_first** — always `true`. Kept as a field so a future variant
  could disable stubbing for experimental runs.

---

## SCOPE-TO-DEPTH TABLE (CANONICAL)

The orchestrator applies this table before finalizing `sections` and
`pages`. Writers apply it recursively when evaluating whether to return a
`split_request`. Verifiers reference it when judging whether the plan was
correctly shaped. This table is authoritative for technical docs; the
product specialist uses a feature-based variant (see `../specialists/product.md`).

| Source scope                              | Required structure                                                                 |
| ----------------------------------------- | ---------------------------------------------------------------------------------- |
| < 300 LOC or < 5 files                    | Fold into parent section; do not create a dedicated page                           |
| 300–1,500 LOC                             | Single `topic.md` page                                                             |
| 1,500–5,000 LOC across ≥2 concern areas   | Folder `topic/` with `OVERVIEW.md` + 2–5 child pages                               |
| 5,000+ LOC, or ≥3 distinct concern areas  | Folder `topic/` with `OVERVIEW.md` + children; children may themselves be folders  |

The rule applies recursively. A 5,000-LOC subsystem split into children of
1,800 LOC each that themselves cover multiple concern areas must split
again. Depth is not capped — structure matches the code.

---

## VERIFIER REPORT SCHEMA

Each verifier sub-agent writes a YAML report to
`wiki/.verification/<page-id>.yaml`. The shape:

```yaml
page_id: <stable slug — same id as in wiki/.plan.yaml pages[]>
page_path: wiki/reference/<slug>.md
mode: technical | product
verified_at: <ISO-8601 timestamp>
verdict: pass | fail_soft | fail_hard

stats:
  total_claims: <integer>      # all claims considered, including resolved
  resolved: <integer>          # claims successfully verified against source — calibration
  consideration: <integer>     # minor; does NOT contribute to verdict
  improvement: <integer>       # material; 1–3 → fail_soft, 4+ → fail_hard
  critical: <integer>          # contradicted or central-unverified; any → fail_hard
  code_refs: <integer>         # product mode only; counted within `critical`

issues:
  - id: <integer>
    status: unverified | contradicted | code_reference | scope_gap
    severity: consideration | improvement | critical
    claim: "<exact quote or paraphrase>"
    page_location: "<line number, heading, or 'throughout'>"
    evidence: "<file:line, symbol, or 'not found in scope_files'>"
    recommendation: "<actionable instruction to the writer>"

scope_coverage:
  files_read: <integer>
  files_total: <integer>       # from scope_files
  files_skipped: []            # any files not read, with reason
```

**Verdict computation rules** (deterministic — must match what
`../specialists/verifier.md` § Step 5 specifies):

- `pass` — `critical == 0` AND `improvement == 0`. Any number of
  `consideration` items is tolerated.
- `fail_soft` — `critical == 0` AND `1 ≤ improvement ≤ 3`.
- `fail_hard` — `critical ≥ 1` OR `improvement ≥ 4`.

Consumers (the CI sync flow, the orchestrator's auto-fix step, the Notion
sync filter) read this YAML. The `stats.resolved` field is calibration
signal — a clean `pass` with `resolved: 0` is suspicious (verifier didn't
extract any claims), distinguishable from `pass` with `resolved: 12`
(verifier did real work and found nothing wrong).

The `issues` list contains only non-`resolved` items. Resolved claims are
summarized by `stats.resolved` alone; do not enumerate them as issues.

---

## INVARIANTS

A valid `wiki/.plan.yaml` must satisfy all of:

1. Every `sections[].path` starts with `wiki/reference/`. Every `pages[].path`
   starts with `wiki/reference/` and ends with `.md`. Pages outside
   `wiki/reference/` are not part of the auto-gen plan and must not appear.
2. Every page's `section` refers to an existing section id.
3. Every section's `parent` refers to an existing section id or `null`.
4. Every id in any `links_to` list refers to an existing page or section.
5. No two pages share the same `path`.
6. No section with `has_overview: true` has a `path` ending in `.md`.
7. No section with `has_overview: false` has child pages (it's a leaf —
   it should be a page, not a section).
8. For every section with `scope_loc_estimate ≥ 1,500`,
   `has_overview: true` (per the scope-to-depth table).
9. For every page with `section_parity: strict`, a counterpart page
   exists in each sibling section where parity is meaningful.
10. `meta.schema_version` matches the version this file documents (`1.1`).

The orchestrator validates these in Phase 2 before writing the plan and
in Quality Gates at the end of Phase 3e.

---

## EVOLUTION

When the schema changes in a breaking way, bump `meta.schema_version` and
update this file. Non-breaking additions (new optional fields) do not
require a version bump.

The plan is intentionally minimal. Resist adding fields that could be
computed from source code or filesystem state at run time — the plan is a
coordination spec, not a cache.
