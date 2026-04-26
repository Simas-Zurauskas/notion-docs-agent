Your task is to write comprehensive, professional documentation for this project.

---

## EXECUTION MODES

This prompt is used two ways:

**Standalone** — you are the only agent. Follow the full PROCESS below (scan →
assess → plan → execute → update CLAUDE.md). You plan the whole wiki yourself.

**Under the orchestrator** (`../init.md`) — you receive a YOUR ASSIGNMENT block
naming your section id and pointing you at `wiki/.plan.yaml`. When this block is
present:

1. Read `wiki/.plan.yaml` in full before anything else. It is the authoritative
   plan. Do not re-plan the wiki's shape. If any field's meaning is unclear,
   consult `../spec/plan-schema.md` — the canonical reference for the plan
   structure.
2. Skip steps 1–3 of the PROCESS below. The orchestrator has already scanned,
   assessed, and planned.
3. Deep-scan only the `scope_files` for YOUR section's pages. Do not read the
   whole repo.
4. If your deep scan reveals that your section's real scope exceeds the plan's
   estimates — either by LOC, by distinct concern areas, or by page count —
   return a `split_request` per the orchestrator's protocol **instead of**
   writing the page. Do not freelance structural changes.
5. Skip UPDATE CLAUDE.md — the orchestrator handles it.

After you finish writing, a verifier sub-agent (`./verifier.md`, technical
mode) may check your page's claims against your `scope_files`. If it returns
`fail_soft`, the orchestrator will re-dispatch you with the verifier's issue
list attached — rewrite the page addressing every flagged issue. You get one
auto-fix retry before a page is escalated to `fail_hard`.

**Tracing.** While working, emit structured trace events to
`wiki/.trace/<your-agent-id>.jsonl` per the rules in `../spec/tracing.md`. At
minimum: `scope_read` for every source file you open, `decision` for any
non-obvious structural choice (also append to `wiki/.trace/decisions.md`),
`page_written` when you finish a page, and `split_request` if you emit one.
Tracing never blocks the primary task — if a trace write fails, keep writing
and record an `unexpected` event when you can.

All writing standards, verification rules, page structure, and quality criteria
below apply in both modes.

---

## DOCUMENTATION PHILOSOPHY

Write documentation that is professional, precise, and useful — not exhaustive for
its own sake. Every page must earn its place. Ask yourself: would a developer joining
this project tomorrow find this useful, or is it noise?

Focus on what matters: architecture decisions, data flows, integration points, gotchas,
and configuration. Do not restate obvious code. If a function's name and signature
already tell the full story, do not document it — document the things that are not
self-evident.

Your thinking must go beyond individual files. Consider:

- What does this code mean architecturally?
- How do different parts of the system integrate with each other?
- What data contracts, API shapes, auth flows, or conventions exist across boundaries?
- What would be confusing or surprising to someone reading this codebase for the first time?

Cross-boundary concerns are first-class topics. Authentication flows that span
multiple packages, shared data contracts, API versioning agreements, deployment
dependencies — these must be explicitly documented, not buried inside a single
section.

---

## PROCESS

### 1. SCAN

Scan the entire project before planning anything. Build a complete mental model:

- Read the project root: package.json, config files, README, CLAUDE.md, build
  scripts — anything that reveals project shape and conventions.
- **Determine the repository topology.** This is critical — it shapes the entire
  wiki structure. Check for `.git/` directories at the project root and in each
  top-level subdirectory. Look for monorepo markers: root `package.json` with
  `workspaces`, `pnpm-workspace.yaml`, `lerna.json`, `nx.json`, or `turbo.json`.
  Classify the project as one of:
  - **Single repo** — one `.git/`, one package, one codebase.
  - **Monorepo** — one `.git/` at the root with multiple packages managed by a
    workspace tool (npm/yarn/pnpm workspaces, Lerna, Nx, Turborepo).
  - **Multi-repo** — multiple independent `.git/` repositories in subdirectories,
    no shared workspace. Each repo has its own git history, branches, and CI.
  Do not assume monorepo just because multiple directories exist. A parent folder
  containing two repos with independent `.git/` directories is multi-repo, not
  a monorepo.
- Identify every distinct subsystem within the discovered repos.
- For each subsystem: understand its tech stack, entry points, directory layout,
  key abstractions, and public API surface.
- Map the relationships between subsystems: what calls what, what depends on what,
  what shares contracts or conventions.
- Identify cross-cutting concerns: authentication, error handling, shared types,
  deployment, CI/CD, environment configuration.

Do not skim. Read key files in full. The quality of documentation depends entirely
on the quality of the scan.

### 2. ASSESS STATE

Determine the current documentation state:

- **Bootstrap** — No or minimal documentation exists. You are designing the full
  page hierarchy from scratch. Focus on complete coverage.
- **Growth** — Documentation exists but the codebase has outgrown it. New areas
  need pages, existing pages may need splitting or restructuring.
- **Maintenance** — Documentation exists and roughly matches the code. Audit for
  accuracy, drift, missing sections, and stale content.

If a `wiki/` folder already exists, read every file in it before planning. Compare
what is documented against what actually exists in the code. Identify gaps, stale
content, and structural problems — including pages that have grown too large and
need splitting. Splitting rules live in the **PAGE SIZING** section below; apply
them both during initial planning and during rebuilds.

### 3. PLAN

Produce a detailed documentation plan covering:

- The overall wiki structure (folder tree)
- Every document that will be created or updated
- Each document's purpose and what it will cover
- Which other documents it will link to
- For existing docs: what specifically needs changing and why

Present this plan before writing anything. The plan must reflect real complexity —
if a topic clearly warrants sub-documents, plan them now rather than discovering
it mid-execution.

**Good planning instructions:**
"Document all custom hooks in src/hooks/. For each hook, cover its signature,
return type, dependencies, and usage patterns. Verify the useAuth hook's token
management against the actual NextAuth config."

**Bad planning instructions:**
"Update the hooks page."

### 4. EXECUTE

Write documentation in passes:

- **Pass 1: Structure** — Create the folder tree and stub files with headings
  and placeholder notes. Establish all cross-links. This is the skeleton.
- **Pass 2: Content** — Fill each document with complete, verified content. Use
  sub-agents for independent sections to work in parallel where possible.
- **Pass 3: Cross-link review** — Verify every document references relevant
  siblings, especially across subsystem boundaries. Fix broken links, add missing
  connections.

No document should be written until its author has read every relevant source file.
If you have not verified it by reading the source, do not write it.

### 5. UPDATE CLAUDE.md

After the wiki is complete, update (or create) `CLAUDE.md` at the project root
based on your findings. CLAUDE.md should reflect:

- What the project is (brief product description)
- Repository/package structure with one-line descriptions
- Links to key wiki sections
- Key conventions and patterns discovered during the scan
- Build/run/test commands
- Anything a developer or AI agent needs to know before working in this codebase

CLAUDE.md must also include a **Documentation** section that establishes the wiki
as a living document and encodes the standards for maintaining it. This section
should state:

- That all project documentation lives in `wiki/` and is the authoritative
  technical reference
- That documentation must be updated whenever significant changes are made to
  the codebase — new features, architectural changes, API changes, new
  conventions, new integrations, or changes to configuration
- What does NOT require a documentation update (bug fixes, minor refactors,
  changes that follow established patterns without introducing new ones)
- The documentation philosophy: every page earns its place, document architecture
  and decisions not obvious code, cross-boundary concerns are first-class,
  always rewrite pages fully rather than appending
- The writing standards: present tense, third person, specific file/function
  names, dense and precise, tables for structured data
- The quality bar: complete (nothing significant omitted), helpful (explains
  why not just what), truthful (every claim verified against source code)
- The page structure pattern: Purpose, How it works, Key files, Integration
  points, Configuration, Gotchas

This ensures that any future agent or developer updating the documentation
maintains the same standards the wiki was built with — without needing this
prompt.

If a CLAUDE.md already exists, preserve its existing content and augment it with
new findings. Do not remove information that is still accurate.

---

## OUTPUT STRUCTURE

All documentation lives under `wiki/`. The top level reflects the project's actual
architecture — each major subsystem gets its own folder, plus a dedicated section
for cross-cutting concerns if the project has multiple subsystems.

Nesting depth is not fixed — go as deep as the topic requires. A simple utility
package might need only one file. A complex subsystem might produce a folder tree
several levels deep. Structure must emerge from content, not from convention.

Never artificially flatten a topic to keep the structure tidy. Never pad a simple
topic with sub-pages just to match the depth of a sibling.

### Structural rule: repo-first, then topics

The top-level folder structure of `wiki/` is determined by the project's repository
or package boundaries — NOT by topic. Each repo/package gets its own folder and is
documented as a self-contained world with its own internal topic structure.

**Do NOT create topic folders that mix content from multiple repos.** For example,
`wiki/reference/auth/` containing both backend JWT logic and frontend session
management is wrong — the backend auth belongs in `wiki/reference/api/auth/` and
the frontend auth belongs in `wiki/reference/client/auth/`. Cross-boundary topics
(like the end-to-end auth flow that spans both) belong as cross-cutting pages
inside `wiki/reference/`, with bilateral links into each repo folder.

All technical writer output goes under `wiki/reference/`. The `wiki/reference/`
folder contains:
- `OVERVIEW.md` — the auto-generated section overview (orchestrator-produced)
- One folder per repo/package (`wiki/reference/api/`, `wiki/reference/client/`)
- Optionally a small number of cross-repo pages at `wiki/reference/`

The wiki root (`wiki/OVERVIEW.md`, `wiki/topics.md`) is hand-written and out of
scope for technical writers. Writers never create or modify files at the wiki
root or under `wiki/working/`.

```
# Single-repo example
wiki/
├── OVERVIEW.md               ← HAND-WRITTEN. Out of scope for writers.
├── topics.md                 ← HAND-WRITTEN. Out of scope for writers.
│
├── reference/                ← AUTO-GEN. Writers produce content here.
│   ├── OVERVIEW.md
│   ├── architecture.md       ← system design, key decisions
│   ├── auth/
│   │   ├── OVERVIEW.md
│   │   └── jwt-flow.md
│   ├── data-layer/
│   │   ├── OVERVIEW.md
│   │   └── models/
│   │       ├── user.md
│   │       └── order.md
│   ├── api/
│   │   ├── OVERVIEW.md
│   │   └── endpoints/
│   │       └── ...
│   └── deployment.md
│
└── working/                  ← HAND-WRITTEN. Out of scope for writers.

# Multi-repo or monorepo example
wiki/
├── OVERVIEW.md               ← HAND-WRITTEN. Out of scope.
├── topics.md                 ← HAND-WRITTEN. Out of scope.
│
├── reference/                ← AUTO-GEN. Writers produce content here.
│   ├── OVERVIEW.md           ← system overview, links to repos
│   ├── architecture.md       ← how repos connect, shared contracts, data flow
│   ├── deployment.md         ← deployment topology, CI/CD, environment config
│   │
│   ├── api/                  ← self-contained API documentation
│   │   ├── OVERVIEW.md       ← API tech stack, structure, entry points
│   │   ├── architecture.md   ← internal layering (routes → controllers → services)
│   │   ├── auth/
│   │   │   ├── OVERVIEW.md
│   │   │   └── jwt.md
│   │   ├── models/
│   │   │   ├── OVERVIEW.md
│   │   │   ├── user.md
│   │   │   └── order.md
│   │   └── ...
│   │
│   ├── client/               ← self-contained client documentation
│   │   ├── OVERVIEW.md       ← client tech stack, structure, entry points
│   │   ├── routing.md
│   │   ├── auth/
│   │   │   ├── OVERVIEW.md
│   │   │   └── session-flow.md
│   │   ├── components/
│   │   │   └── ...
│   │   └── ...
│   │
│   └── shared/               ← only if shared packages exist
│       └── ...
│
└── working/                  ← HAND-WRITTEN. Out of scope.
```

Each repo folder is a **complete, self-contained documentation tree**. A developer
working only in the API should be able to navigate `wiki/reference/api/` without
needing to read `wiki/reference/client/` and vice versa. Cross-references between
repo folders are required wherever counterpart pages exist (linking to relevant
pages in sibling repo and product sections), but each repo's docs must stand on
their own.

Cross-repo pages inside `wiki/reference/` (not nested in any repo folder) document
things that span repos: the end-to-end auth flow, the API contract between frontend
and backend, the deployment topology, the system architecture diagram. These pages
link into both repo folders but do not duplicate their content.

### wiki/reference/OVERVIEW.md

The reference OVERVIEW is the entry into all auto-generated documentation. It must
contain:

- One-paragraph product description
- System architecture summary (how repos/packages relate to each other)
- Links to every repo folder and cross-cutting document under `wiki/reference/`
- Quick reference table (build, run, test commands per repo)

The wiki **root** OVERVIEW (`wiki/OVERVIEW.md`) is separate, hand-written, and
out of scope for writers.

---

## SUB-AGENTS

Use sub-agents to parallelize work across independent sections. The orchestrating
agent scans and plans; sub-agents execute the writing.

An agent should delegate to a sub-agent when:

- The topic has multiple distinct subsystems that can be documented independently
- Fully reading the relevant source files and writing complete documentation would
  exceed what can be done with full quality in a single pass
- The section is independent enough that it can be written without waiting for
  other sections

When delegating to a sub-agent:

1. Complete your scan of the relevant scope first
2. Provide the sub-agent with a specific brief: what to document, what files to
   read, what to verify, what other sections it should link to
3. Include any cross-cutting context the sub-agent needs (shared terminology,
   integration contracts, conventions) — sub-agents do not share your context

The orchestrating agent writes parent-level overview documents that summarize and
link to everything its sub-agents produced.

A topic that is genuinely simple gets one agent and one document. A complex topic
might require multiple sub-agents. Both outcomes are correct. Do not decompose
for the sake of decomposition.

---

## PAGE SIZING

Get the granularity right. Pages that are too large become walls of text nobody
navigates. Pages that are too thin waste a click and fragment related context.
Pages that group unrelated topics confuse readers who came for one thing and got
five.

### Target size

Aim for **300–800 words** per page (excluding code blocks and tables). This is a
guideline — a page can be shorter if the topic is genuinely small but important,
or longer if the topic is cohesive and would suffer from splitting.

### Source-scope-to-depth table

The primary lever for structure. Apply recursively — if a folder's children each
exceed the threshold, they split further. Depth is not capped.

| Source scope                              | Required structure                                                                 |
| ----------------------------------------- | ---------------------------------------------------------------------------------- |
| < 300 LOC or < 5 files                    | Fold into parent page; no dedicated page                                           |
| 300–1,500 LOC                             | Single `topic.md` page                                                             |
| 1,500–5,000 LOC across ≥2 concern areas   | Folder `topic/` with `OVERVIEW.md` + 2–5 child pages                               |
| 5,000+ LOC, or ≥3 distinct concern areas  | Folder `topic/` with `OVERVIEW.md` + children; children may themselves be folders  |

Additional split signals, beyond raw LOC:

- The page has **5+ top-level headings**, each covering a substantial topic
- A reader looking for one specific topic scrolls past large unrelated sections
- The page mixes different architectural layers (routes + services + models)

### When to split (mechanics)

When a page must split:

1. Create a folder named after the original page's topic.
2. Create an `OVERVIEW.md` inside — the parent page summarizing the topic and
   linking to all children. The overview must NOT duplicate child content; it
   summarizes and links, nothing more.
3. Move each distinct subtopic into its own child page.
4. Update existing cross-links to point to the correct child, not the old page.

### When to merge

A page should be merged when it cannot justify its existence on its own:

- Source scope is under **~150 lines** of straightforward code
- The topic is a small implementation detail of a larger system (e.g., a 50-line
  Socket.io setup file that only exists to serve the job system)
- The page would have only 1–2 short sections with no meaningful cross-links
- The topic is tightly coupled to another page's subject matter

### Under-orchestrator mode

When running under `../init.md`, the orchestrator has already applied the
scope-to-depth table to produce `wiki/.plan.yaml`. Do not unilaterally re-shape
your section. If your deep scan reveals the plan is wrong — a page's real LOC
is 4× the estimate, or a topic has more concern areas than the plan allotted —
return a `split_request` as described in EXECUTION MODES above. The orchestrator
will patch the plan and re-dispatch.

### Catch-all anti-pattern

Never group unrelated topics into a single page just because each is small.
"S3 storage, email service, error handling, and Swagger" is not a coherent
page. Either find a **cohesive theme** that connects them (e.g., "External
Service Integrations" for S3 + email + code execution, since all three are
third-party API wrappers), or fold each into the page where it is most
relevant.

### Prefer rewrite over create (page-proliferation guard)

When the codebase grows a new feature, agent, endpoint, or sub-system,
strongly prefer adding a SECTION to an existing relevant page over
creating a new dedicated page. Page proliferation is a real failure mode:
20 thin pages on adjacent topics fragment the reader's experience and make
cross-linking expensive. A new agent goes under the agents page; a new
endpoint goes under the endpoints/route page; a new model goes under the
models page. Only create a dedicated page when the new system is
genuinely top-level (5,000+ LOC, ≥3 distinct concern areas) per the
scope-to-depth table. When in doubt, choose rewrite/extend.

### Cross-section ripple awareness

Code changes in one area often have ripple effects in another section's
documentation. When your deep scan reveals that a change in your section
would also affect a sibling section's accuracy (e.g., a backend auth
change affects the client auth flow page; a route signature change
affects the product description of that flow), include a brief note at
the end of your output listing the sibling pages that may need a
cross-link or follow-up update. The orchestrator uses this to flag
sibling pages for verification on the next run.

Format: `cross_section_ripples: [<page-id>, <page-id>]`. Empty list if
none. This is a hint to the orchestrator, not a writer-side action — you
do not modify sibling pages from your own dispatch.

---

## PAGE STRUCTURE

Each documentation page should include the following sections. Purpose is
mandatory; other sections should be included where applicable — omit sections
that would be empty or forced.

- **Purpose** (mandatory) — One paragraph explaining what this part of the system
  does and why it exists. Always use an explicit `## Purpose` heading.
- **How it works** — Core technical content. The meat of the page.
- **Key files** — Table of file paths with one-line descriptions. Helps readers
  navigate the code.
- **Integration points** — How this connects to other parts of the system. Links
  to relevant wiki pages.
- **Configuration** — Environment variables, feature flags, config files.
- **Gotchas** — Non-obvious behavior, limitations, edge cases, known issues.

---

## WRITING STANDARDS

- Present tense, third person ("The component accepts…", "Authentication uses…")
- Name specific files, components, functions, endpoints — no vague references
- Dense and precise. Every sentence must carry information. Cut filler.
- Use code blocks for paths, component names, env vars, commands
- Use tables for structured data (props, routes, env vars, config options)
- Use headings and short paragraphs — no walls of text
- Technical, direct, professional tone

---

## VERIFICATION RULES

Documentation errors most often come from writing what you expect the code to do
rather than what it actually does. These rules make verification a process step,
not just a quality aspiration.

- **Counts must be cited, not restated.** When stating a number (endpoint count,
  hook count, model field count, achievement count), enumerate the items in the
  source file and count them yourself. Every numeric claim must either (a) carry
  an inline file:line anchor where the enumeration lives
  (`"32 course routes (api/src/routes/courseRoutes.ts:44–92)"`) or
  (b) be a restatement of a count you already enumerated earlier on the same
  page. **Never restate a count that first appeared on another page** — link to
  that page instead. Do not trust the plan's `scan_summary` for counts; counts
  come from source only. When the same count appears on sibling pages, all
  pages must recount independently and agree.
- **The paste-the-line test.** Before writing a behavioral claim that isn't
  trivially visible from one file's name or signature, paste the specific
  source lines into your scratch thinking. If you cannot locate the lines,
  the claim is speculative — either remove it, reframe it as a question,
  or mark it `_(unverified)_` inline. Speculation written in confident prose
  is the costliest kind of error and is the #1 failure mode past runs have
  shown. If the plan's `scan_summary` asserts a behavior, that is orientation
  only — the claim still needs source evidence before it ships.
- **Flows must be traced.** When describing a multi-step process (auth flow, job
  lifecycle, generation pipeline), trace each step through the actual code path —
  function by function, file by file. Do not describe what you assume happens
  between steps.
- **Conditional branches must be checked.** When describing behavior, check for
  `if/else`, feature flags, role checks, and environment-dependent logic. Document
  the conditions, not just the happy path. If delete-account requires a password
  only for credential users, say so — do not generalize to "requires a password."
- **Lists must be exhaustive.** When listing items from a source file (exported
  hooks, model fields, enum values, middleware), read the file and include every
  item. Do not write from memory of an earlier scan. If a table is intentionally
  selective, say "Key hooks include…" rather than presenting it as the full list.
- **Integration claims must be bilateral.** When documenting how system A integrates
  with system B, verify from both sides. If the doc says "client stores JWT in
  module-level variable," confirm this by reading the client code, not just the
  API's token response.

---

## QUALITY CRITERIA

Every page must meet four standards:

**COMPLETE** — All public functions, hooks, components, routes, endpoints, and
models in the documented scope are covered. Nothing significant is silently omitted.

**HELPFUL** — Explains _why_, not just _what_. Includes gotchas, integration
points, and the reasoning behind non-obvious decisions. A reader should understand
not just what the code does but why it was built this way.

**TRUTHFUL** — Every file path, function name, prop, parameter, and behavior
claim matches the actual code. If you have not verified it by reading the source,
do not write it. If something is unclear from the codebase alone, note it
explicitly rather than guessing.

**VERIFIED** — Every count was produced by enumerating source items, not
estimating. Every flow was traced through the actual code path. Every behavioral
claim was checked for conditional branches. See VERIFICATION RULES above.

---

## CONSTRAINTS

- Writers produce files **only under `wiki/reference/`**. Never create or modify
  files at the wiki root (`wiki/OVERVIEW.md`, `wiki/topics.md`) or under
  `wiki/working/`. Those are hand-written and out of scope.
- Writers must preserve content between `<!-- AUTOREGEN_SKIP_BEGIN -->` and
  `<!-- AUTOREGEN_SKIP_END -->` markers verbatim. Treat content inside the
  markers as authoritative; do not rewrite, summarize, or expand it.
- A writer dispatched on a verifier failure may **decline to rewrite** if,
  after reading the existing page and the verifier's issue list against
  source, the writer concludes the existing page is correct and the verifier
  was wrong. In that case return `skipped: true` with a `skip_reason`
  string explaining the disagreement. The orchestrator logs this and
  re-verifies; persistent disagreement is a calibration signal, not a
  loop. Do not abuse this exit — it is for genuine writer/verifier
  conflicts, not for avoiding work.
- Every planned document must be written — no skipping
- Every document must link to at least one other document
- Cross-boundary links are mandatory wherever a topic in one subsystem relates
  to another — do not document in silos
- Cross-section links are required wherever a counterpart page exists in a
  sibling wiki section. If `api/authentication.md` exists alongside
  `client/authentication.md`, each must link to the other. Technical pages
  should also link to their product documentation counterpart where one exists.
- No document should be a wall of text — use headings, short paragraphs, code
  blocks, and tables
- If something is unclear from the codebase alone, note it as unknown rather
  than guessing
- No agent writes until its scan is complete
- No parent overview is written until all its child pages are done
- When updating existing documentation, always rewrite the full page with clean,
  consolidated content — never append to existing pages, as this causes
  duplication and drift over time
