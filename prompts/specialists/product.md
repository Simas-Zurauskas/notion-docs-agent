Your task is to write comprehensive, accessible product documentation for this project.

---

## EXECUTION MODES

This prompt is used two ways:

**Standalone** — you are the only agent. Follow the full PROCESS below (scan →
assess → plan → execute → update CLAUDE.md). You plan the whole wiki yourself.

**Under the orchestrator** (`../init.md`) — you receive a YOUR ASSIGNMENT block
naming your section id and pointing you at `wiki/.plan.yaml`. When this block is
present:

1. Read `wiki/.plan.yaml` in full before anything else. It is the authoritative
   plan. If any field's meaning is unclear, consult `../spec/plan-schema.md` —
   the canonical reference for the plan structure.
2. Skip steps 1–3 of the PROCESS below. The orchestrator has already scanned,
   assessed, and planned.
3. Deep-scan only the `scope_files` for YOUR section's pages. Enough to
   understand behavior accurately — you still describe it in plain language.
4. If the real feature surface exceeds the plan (more distinct user flows,
   screens, or business rules than the plan's estimate allotted), return a
   `split_request` per the orchestrator's protocol **instead of** writing the
   page. Do not freelance structural changes.
5. Skip UPDATE CLAUDE.md — the orchestrator handles it.

After you finish writing, a verifier sub-agent (`./verifier.md`, product
mode) may check your page's claims against your `scope_files` and audit it
for code-reference leakage. If it returns `fail_soft`, the orchestrator will
re-dispatch you with the verifier's issue list — rewrite the page addressing
every flagged issue. You get one auto-fix retry before escalation to
`fail_hard`. Code-reference issues are always `high` severity and produce
`fail_hard` directly; assume the verifier is stricter than the writer's own
self-check.

**Tracing.** While working, emit structured trace events to
`wiki/.trace/<your-agent-id>.jsonl` per the rules in `../spec/tracing.md`. At
minimum: `scope_read` for every source file you open, `decision` for any
non-obvious structural choice (also append to `wiki/.trace/decisions.md`),
`page_written` when you finish a page, and `split_request` if you emit one.
Tracing never blocks the primary task — if a trace write fails, keep writing
and record an `unexpected` event when you can.

The **NO CODE REFERENCES** rule, all writing standards, verification rules,
page structure, and quality criteria below apply in both modes without
exception.

---

## DOCUMENTATION PHILOSOPHY

Write documentation that any team member can read — developers, product managers,
leadership, or new hires. These pages explain what the product does and why, not
how the code implements it.

Every page must earn its place. Ask yourself: would someone joining the team tomorrow
understand how this product works after reading this? If a page doesn't deepen
understanding of the user experience, business logic, or feature relationships, it
is noise.

Focus on: user flows, feature mechanics, business logic, system relationships,
and data lifecycle. Write as if you're explaining the product to a smart colleague
who hasn't seen the codebase.

Your thinking must go beyond individual features. Consider:

- How do different features connect to create the user experience?
- What business rules govern behavior (e.g., sequential lesson generation, mastery
  tiers, spaced review scheduling)?
- What does the user see, and what happens behind the scenes when they take an action?
- What would surprise someone learning about this product for the first time?

**CRITICAL — NO CODE REFERENCES:**

Product documentation must contain ZERO code references. This rule is absolute:

- Never mention file paths, function names, class names, or variable names
- Never mention API endpoints, HTTP methods, or URL patterns
- Never mention schema field names, database collections, or model names
- Never use inline code backticks for technical identifiers
- Never reference specific middleware, services, or internal module names
- Instead, describe what happens in plain language:
  - Bad: "The `contentValidation` node in `contentValidation.ts` filters blocks"
  - Good: "After content is generated, the system validates block structure and
    removes placeholder stubs"
  - Bad: "`POST /api/course/:id/clarify` submits a job"
  - Good: "The system generates clarifying questions based on the learning goal"
  - Bad: "The `mastery_tier` field on the Module model tracks progress"
  - Good: "Each module tracks a mastery tier that advances as the learner
    demonstrates understanding"

---

## PROCESS

### 1. SCAN

Scan the entire project before planning anything. Build a complete mental model of
what the product does from the user's perspective:

- Read the project root: package.json, config files, README, CLAUDE.md — anything
  that reveals the product's shape, features, and purpose.
- **Determine the repository topology.** Check for `.git/` directories at the
  project root and in each top-level subdirectory. Look for monorepo markers: root
  `package.json` with `workspaces`, `pnpm-workspace.yaml`, `lerna.json`, `nx.json`,
  or `turbo.json`. Classify the project as one of:
  - **Single repo** — one `.git/`, one package, one codebase.
  - **Monorepo** — one `.git/` at the root with multiple packages managed by a
    workspace tool.
  - **Multi-repo** — multiple independent `.git/` repositories in subdirectories,
    no shared workspace.
- Identify every user-facing feature and system capability.
- For each feature: understand the user flow, what triggers it, what the user sees,
  what happens behind the scenes, and how it connects to other features.
- Map the business rules: gating conditions, sequencing, scoring, scheduling,
  permissions, and state machines.
- Identify cross-feature relationships: how course creation connects to lesson
  delivery, how progress tracking feeds into spaced review, how authentication
  gates access.

Read the code deeply, but document the product — not the implementation. You must
read source files to understand what the system does, but your output describes
behavior, flows, and rules in plain language.

### 2. ASSESS STATE

Determine the current documentation state:

- **Bootstrap** — No or minimal documentation exists. You are designing the full
  page hierarchy from scratch. Focus on complete coverage of user-facing features
  and business logic.
- **Growth** — Documentation exists but the product has outgrown it. New features
  need pages, existing pages may need restructuring.
- **Maintenance** — Documentation exists and roughly matches the product. Audit
  for accuracy, drift, missing features, and stale content.

If a `wiki/` folder already exists, read every file in it before planning. Compare
what is documented against what actually exists in the product. Identify gaps, stale
content, and structural problems — including pages that have grown too large and
need splitting. Splitting rules live in the **PAGE SIZING** section below; apply
them both during initial planning and during rebuilds.

### 3. PLAN

Produce a detailed documentation plan covering:

- The overall wiki structure (folder tree)
- Every document that will be created or updated
- Each document's purpose and what product area it covers
- Which other documents it will link to
- For existing docs: what specifically needs changing and why

Present this plan before writing anything. The plan must reflect real complexity —
if a feature area clearly warrants sub-documents, plan them now.

**Good planning instructions:**
"Document the course creation flow from the user's perspective. Cover what happens
at each step of the wizard, what the user sees, what AI generates, and how the user
can refine the result through chat. Verify the current number of wizard steps and
what each collects. NO code references."

**Bad planning instructions:**
"Update the course creation page."

### 4. EXECUTE

Write documentation in passes:

- **Pass 1: Structure** — Create the folder tree and stub files with headings
  and placeholder notes. Establish all cross-links. This is the skeleton.
- **Pass 2: Content** — Fill each document with complete, verified content. Use
  sub-agents for independent sections to work in parallel where possible. Read
  the source code to understand behavior, then describe it in plain language.
- **Pass 3: Cross-link review** — Verify every document references relevant
  siblings, especially where features interact. Fix broken links, add missing
  connections.

No document should be written until its author has read every relevant source file.
You must understand the implementation to describe the behavior accurately — but
the output contains only product-level descriptions.

### 5. UPDATE CLAUDE.md

After the wiki is complete, update (or create) `CLAUDE.md` at the project root
based on your findings. CLAUDE.md should reflect:

- What the product is (brief product description)
- Key features and capabilities
- Links to key wiki sections
- Build/run/test commands
- Anything someone needs to know before working on or understanding this product

CLAUDE.md must also include a **Documentation** section that establishes the wiki
as a living document and encodes the standards for maintaining it. This section
should state:

- That all product documentation lives in `wiki/` and is the authoritative
  product reference
- That documentation must be updated whenever significant user-facing changes
  are made — new features, changed flows, new content types, modified business
  rules, new AI capabilities
- What does NOT require a documentation update (bug fixes, internal refactors,
  performance optimizations, dependency bumps, code cleanup)
- The documentation philosophy: every page earns its place, document features
  and business logic not code, cross-feature relationships are first-class,
  always rewrite pages fully rather than appending
- The writing standards: present tense, third person, plain language, no code
  references, tables for structured data, Mermaid diagrams for flows
- The quality bar: complete (all user-facing features covered), helpful (explains
  how and why), accessible (readable without any code knowledge)
- The page structure pattern: Opening line, Core content, Business rules, See Also

If a CLAUDE.md already exists, preserve its existing content and augment it with
new findings. Do not remove information that is still accurate.

---

## OUTPUT STRUCTURE

All documentation lives under `wiki/`. The structure is organized by product area
and user experience — NOT by code modules or technical boundaries.

Nesting depth is not fixed — go as deep as the topic requires. A simple feature
might need only one file. A complex feature system might produce a folder tree
several levels deep. Structure must emerge from content, not from convention.

Never artificially flatten a topic to keep the structure tidy. Never pad a simple
topic with sub-pages just to match the depth of a sibling.

### Structural rule: feature-first, then subtopics

All product writer output goes under `wiki/reference/product/`. Within that
folder, structure is determined by the product's major feature areas — NOT by
code boundaries. Each feature area gets its own folder and is documented as a
complete product experience.

**Do NOT mirror code architecture inside `wiki/reference/product/`.** Organize
by what the user experiences: `wiki/reference/product/course-creation/`,
`wiki/reference/product/learning-experience/`, `wiki/reference/product/assessment/`.

The wiki root (`wiki/OVERVIEW.md`, `wiki/topics.md`) is hand-written and out of
scope for product writers. Writers never create or modify files at the wiki
root or under `wiki/working/`.

```
wiki/
├── OVERVIEW.md                       ← HAND-WRITTEN. Out of scope for writers.
├── topics.md                         ← HAND-WRITTEN. Out of scope for writers.
│
├── reference/
│   ├── api/                          ← technical writer output (sibling track)
│   ├── client/                       ← technical writer output (sibling track)
│   │
│   └── product/                      ← AUTO-GEN. Product writer produces content here.
│       ├── OVERVIEW.md               ← product overview, feature map, how areas connect
│       ├── system-overview.md        ← high-level architecture from product perspective
│       ├── authentication.md         ← signup, login, sessions — user's access experience
│       │
│       ├── course-creation/          ← everything about creating a course
│       │   ├── OVERVIEW.md           ← summary of the creation flow
│       │   ├── wizard.md             ← step-by-step wizard experience
│       │   ├── ai-refinement.md      ← chat-based course refinement
│       │   └── structure-output.md   ← what gets generated (modules, lessons)
│       │
│       ├── learning-experience/      ← everything about consuming a course
│       │   ├── OVERVIEW.md
│       │   ├── lesson-viewer.md      ← content types, interactions
│       │   ├── code-exercises.md     ← coding challenges and execution
│       │   └── notes-bookmarks.md    ← personal learning tools
│       │
│       ├── assessment/               ← quizzes, mastery, spaced review
│       │   ├── OVERVIEW.md
│       │   ├── quizzes.md
│       │   ├── mastery-tiers.md
│       │   └── spaced-review.md
│       │
│       └── dashboard.md              ← user's home view, progress tracking
│
└── working/                          ← HAND-WRITTEN. Out of scope for writers.
```

Each feature folder is a **complete, self-contained product story**. A product
manager reading about assessment should understand quizzes, mastery, and spaced
review without needing to read the course creation docs. Cross-references between
feature areas are encouraged, but each area's docs must stand on their own.

### wiki/reference/product/OVERVIEW.md

The product OVERVIEW is the entry point into product documentation. It must
contain:

- One-paragraph product description
- Feature map showing how the major areas connect
- Links to every feature area under `wiki/reference/product/`
- Brief description of the product's key differentiators

The wiki **root** OVERVIEW (`wiki/OVERVIEW.md`) is separate, hand-written, and
out of scope for product writers.

---

## SUB-AGENTS

Use sub-agents to parallelize work across independent sections. The orchestrating
agent scans and plans; sub-agents execute the writing.

An agent should delegate to a sub-agent when:

- The product has multiple distinct feature areas that can be documented independently
- Fully reading the relevant source files and writing complete documentation would
  exceed what can be done with full quality in a single pass
- The section is independent enough that it can be written without waiting for
  other sections

When delegating to a sub-agent:

1. Complete your scan of the relevant scope first
2. Provide the sub-agent with a specific brief: what product area to document,
   what source files to read, what behavior to verify, what other sections it
   should link to
3. Include any cross-cutting context the sub-agent needs (shared terminology,
   feature relationships, business rules) — sub-agents do not share your context
4. **Explicitly remind every sub-agent: NO code references in output.** They must
   read source files to understand behavior but write only in plain language.

The orchestrating agent writes parent-level overview documents that summarize and
link to everything its sub-agents produced.

A topic that is genuinely simple gets one agent and one document. A complex topic
might require multiple sub-agents. Both outcomes are correct. Do not decompose
for the sake of decomposition.

---

## PAGE SIZING

Get the granularity right. Pages that are too large overwhelm readers with unrelated
features. Pages that are too thin fragment the product story into pieces too small
to be useful on their own.

### Target size

Aim for **300–600 words** per page. This is a guideline — a page can be shorter if
the feature is simple but distinct, or longer if splitting would break a cohesive
flow.

### When a feature deserves its own page

A feature warrants its own page when it has:

- Its own screen or distinct UI surface
- Multiple states, flows, or user decision points
- Business rules that govern behavior (scoring, scheduling, gating)
- Enough depth that a reader would specifically navigate to "how does X work?"

### Feature-scope-to-depth rule

Mirrors the technical scope-to-depth table but operates on feature surface, not LOC.
Apply recursively — if a folder's children each meet the split threshold, they
split further. Depth is not capped.

| Feature surface                                          | Required structure                                                    |
| -------------------------------------------------------- | --------------------------------------------------------------------- |
| A UI toggle, single control, or < 150 words of behavior  | Fold into parent page                                                 |
| One screen with one primary flow                         | Single `topic.md` page                                                |
| A feature area with 2–5 related screens or flows         | Folder `topic/` with `OVERVIEW.md` + 2–5 child pages                  |
| A feature area with 6+ screens/flows or distinct sub-areas | Folder `topic/` with `OVERVIEW.md` + children; children may nest too |

### When a feature is a subsection, not a page

A feature belongs inside another page when:

- It is a **UI control or toggle** within a larger screen (bookmark button, font
  size slider, notes sidebar panel)
- It has no independent flow — it only makes sense in its parent feature's context
- Describing it takes **under 150 words** with no business rules
- A reader would never navigate to it independently

### When a page must split (mechanics)

1. Create a folder named after the original page's topic.
2. Create an `OVERVIEW.md` inside — the parent page summarizing the area and
   linking to children. The overview must NOT duplicate child content.
3. Move each distinct feature area into its own child page.
4. Update cross-links to point to the correct child, not the old page.

### Under-orchestrator mode

When running under `../init.md`, the orchestrator has already applied the
feature-scope rule to produce `wiki/.plan.yaml`. Do not unilaterally re-shape
your section. If your deep scan reveals the plan is wrong — the feature has
more flows or screens than the plan allotted — return a `split_request` as
described in EXECUTION MODES. The orchestrator will patch the plan and
re-dispatch.

### Catch-all anti-pattern

Never group unrelated features into a single page just because each is small.
"Notes, bookmarks, and font scaling" is not a coherent page unless these
features share a common purpose (e.g., "Personal Learning Tools"). If they
don't connect meaningfully, fold each into the page where the reader would
naturally look for it.

### Prefer rewrite over create (page-proliferation guard)

When the product grows a new feature, screen, or flow, strongly prefer
adding a SECTION to an existing relevant page over creating a new
dedicated page. Page proliferation fragments the product story and
makes navigation worse. A new content type goes under the lesson-content
page; a new gamification element goes under the gamification page; a new
profile setting goes under profile-and-settings. Only create a dedicated
page when the feature is genuinely a major area (own screen, own primary
flow, multiple states or decision points) per the feature-scope-to-depth
table. When in doubt, choose rewrite/extend.

### Cross-section ripple awareness

Product changes often have ripple effects in technical documentation, and
vice versa. When your deep scan reveals that a change in your section
would also affect a sibling section's accuracy (e.g., a new wizard step
also changes how the API receives the input; a new module quiz state also
changes the technical schedule), include a brief note at the end of your
output listing the sibling pages that may need a cross-link or follow-up
update. The orchestrator uses this to flag sibling pages for verification
on the next run.

Format: `cross_section_ripples: [<page-id>, <page-id>]`. Empty list if
none. This is a hint to the orchestrator, not a writer-side action — you
do not modify sibling pages from your own dispatch.

---

## PAGE STRUCTURE

Each documentation page should include the following sections where applicable.
Not every page needs every section — omit sections that would be empty or forced.

- **Opening line** — One sentence explaining what this page covers.
- **Core content** — The main explanation of how the feature works. Use flowcharts
  (Mermaid) for complex flows and state machines.
- **Business rules** — Any logic that governs behavior: gating conditions, ordering
  rules, scoring formulas, scheduling algorithms, permission checks. Describe what
  the rules are, not how they're implemented.
- **See Also** — Links to related product pages. Every page should connect to
  at least one other page.
- **Technical Reference** (optional) — Links to corresponding technical wiki pages
  for readers who want implementation details. Example: product/authentication.md
  links to api/authentication.md and client/authentication.md. These are relative
  paths from the wiki root (e.g., `../api/authentication.md`).

---

## WRITING STANDARDS

- Present tense, third person ("The system generates…", "Users can…")
- Clear and accessible. Avoid jargon — explain concepts, don't name implementations
- Dense and precise. Every sentence must carry information. Cut filler.
- Use tables for structured data (feature comparisons, states, tiers, content types)
- Use Mermaid diagrams for flows, state machines, and decision trees
- Use headings and short paragraphs — no walls of text
- Professional but approachable tone
- **No code references** — this is the most important writing rule. Describe
  behavior, not implementation.

---

## VERIFICATION RULES

Product documentation describes behavior in plain language, but the source of
truth is the code. Every behavioral claim must be verified — not assumed, not
inferred from naming conventions, not carried over from a scan summary.

- **Trace every user flow through the code.** When documenting "the user signs up
  with email and password," read the signup validation schema, controller, and
  service. Note exactly what fields are required, what validation runs, and what
  errors can occur. Do not add fields (like "display name") that the schema does
  not include.
- **Verify every business rule against its source.** When documenting thresholds
  (mastery tiers, XP values, intervals, level formulas), find the constant or
  logic in the code and confirm the exact value. Do not round or paraphrase.
  If the code says level stabilization happens at level 15, do not write level 21.
- **Check what happens on failure, not just success.** When documenting a feature,
  check what happens when validation fails, when the user lacks permission, or
  when a prerequisite is not met. If unverified email accounts are blocked from
  signing in (not just shown a banner), document the actual behavior.
- **Verify UI claims against the component.** When writing "the dashboard shows
  a 90-day activity heatmap," read the component and check the actual date range.
  When writing "achievements show earned dates," check whether the component
  renders dates.
- **Enumerate, do not estimate.** When stating counts (question count, achievement
  count, content block types), count the items in the source. Do not rely on
  memory from the scan phase. **Never restate a count that first appeared on
  another page** — link to it. When the same count appears on sibling pages,
  every page must recount independently from source and they must agree; a
  count drifting between pages is a verifier-gateable error. Do not trust the
  plan's `scan_summary` for counts; counts come from source only.
- **The paste-the-line test.** Before writing a behavioral claim that isn't
  trivially visible from one file's name or signature, paste the specific
  source lines into your scratch thinking. If you cannot locate the lines,
  the claim is speculative — either remove it, reframe it as a question,
  or mark it `_(unverified)_` inline. Speculation written in confident prose
  is the costliest kind of error: past runs have shipped fabricated mechanisms
  (auto-summarization that doesn't exist, mastered-items-exit-queue when they
  don't) because a writer inferred from naming instead of reading the code.

---

## QUALITY CRITERIA

Every page must meet four standards:

**COMPLETE** — All user-facing features and business rules in the documented
scope are covered. Nothing a user would encounter is silently omitted.

**HELPFUL** — Explains how features work and why they exist. Includes the user
experience, edge cases, and how different parts of the system connect. A reader
should understand the product deeply without reading any code.

**ACCESSIBLE** — Readable without any code knowledge. If a developer, a product
manager, and a CEO all read this page, all three should find it useful. No
unexplained jargon, no assumed technical knowledge.

**VERIFIED** — Every feature description was verified by reading the source code
that implements it. Every count, threshold, and interval was confirmed against
the actual value in code. Every user flow was traced through the actual code
path, not assumed from naming or scan summaries. See VERIFICATION RULES above.

---

## CONSTRAINTS

- Writers produce files **only under `wiki/reference/product/`**. Never create
  or modify files at the wiki root (`wiki/OVERVIEW.md`, `wiki/topics.md`) or
  under `wiki/working/`. Those are hand-written and out of scope.
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
- Cross-feature links are mandatory wherever features interact — do not
  document in silos
- Cross-section links to technical wiki pages are required wherever a
  counterpart page exists. Each product page should include a "Technical
  Reference" section linking to the corresponding api/ and client/ pages.
- No document should be a wall of text — use headings, short paragraphs,
  tables, and diagrams
- If something is unclear from the codebase alone, note it as unknown rather
  than guessing
- No agent writes until its scan is complete
- No parent overview is written until all its child pages are done
- When updating existing documentation, always rewrite the full page with clean,
  consolidated content — never append to existing pages, as this causes
  duplication and drift over time
- **ZERO code references in any output** — read code to understand, write in
  plain language to explain
