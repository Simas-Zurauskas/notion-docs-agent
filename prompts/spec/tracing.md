Tracing rules for the wiki generation pipeline. Every agent — orchestrator,
writer, verifier — emits a structured trace of what it did, what it decided,
and what happened. The result is a debuggable record of the whole run.

This file is referenced by `../init.md`, `../specialists/technical.md`,
`../specialists/product.md`, and `../specialists/verifier.md`. Each agent implements the subset
of rules that apply to its role.

---

## WHAT TRACING IS

Three artifacts per run, produced as a side-effect of normal work:

1. **Structured event logs** (JSONL) — one file per agent. Captures every
   meaningful action and decision in a form a script can read. Good for
   "replay exactly what happened" debugging.
2. **Decisions log** (`wiki/.trace/decisions.md`) — a single append-only
   markdown file. Every agent adds entries for non-obvious choices with
   rationale. Good for "why did it do that?" debugging.
3. **Timeline** (`wiki/.trace/TIMELINE.md`) — a phase-by-phase narrative
   synthesized by the orchestrator at the end of Phase 3e. Good for
   at-a-glance "what happened in this run?"

## WHAT TRACING IS NOT

- **Not a prompt-engineering log.** It records actions and decisions, not
  the agent's internal reasoning tokens or speculation.
- **Not a replacement for Claude Code's native transcripts.** Claude Code
  already stores raw tool-call records per sub-agent invocation. Tracing
  here captures semantic events on top of that — "split_request issued
  because scope was 3× estimate" is meaningful in a way that 50 raw
  tool calls aren't.
- **Not a real-time monitor.** Agents append after-the-fact. If you want
  live progress, watch the JSONL files with `tail -f`.

---

## DIRECTORY LAYOUT

```
wiki/.trace/
├── orchestrator.jsonl                   ← orchestrator's full event log
├── writer-<section-slug>.jsonl          ← one per writer sub-agent
│   (e.g. writer-api-models.jsonl)
├── verifier-<page-slug>.jsonl           ← one per verifier sub-agent
│   (e.g. verifier-api-models-user.jsonl)
├── decisions.md                         ← non-obvious choices, all agents append
└── TIMELINE.md                          ← merged narrative, written in Phase 3e
```

Slug rules for filenames:
- Replace `/` in ids with `-` (e.g. `api/models/user` → `api-models-user`).
- Lowercase, no spaces.
- If a verifier runs twice (auto-fix), append `.retry1`, `.retry2` to the
  filename: `verifier-api-auth-session.retry1.jsonl`.

---

## AGENT NAMING

Every agent has a stable `agent_id` used in both filenames and JSONL records:

| Role          | agent_id format                                   |
| ------------- | ------------------------------------------------- |
| Orchestrator  | `orchestrator`                                    |
| Writer        | `writer-<section-slug>`                           |
| Verifier      | `verifier-<page-slug>` (add `.retry1` on re-runs) |

The orchestrator assigns agent_ids when it dispatches sub-agents and includes
it in the assignment brief. Sub-agents must use exactly that id in their
JSONL output and as their filename.

---

## JSONL EVENT SCHEMA

One event per line. Every event MUST include these common fields:

```json
{
  "ts": "<ISO-8601 UTC timestamp>",
  "agent": "<agent_id>",
  "phase": "1 | 2 | 3a | 3b | 3c | 3d | 3e",
  "event": "<event type — one of the 12 below>"
}
```

Additional fields depend on the event type. Unknown fields are allowed but
discouraged — stay within the schema.

### Event types (12)

| Event            | Emitter              | Purpose                                                  |
| ---------------- | -------------------- | -------------------------------------------------------- |
| `phase`          | orchestrator         | Marks phase boundary                                     |
| `plan`           | orchestrator         | Plan lifecycle (draft / critique / write)                |
| `stub`           | orchestrator         | One stub file created                                    |
| `dispatch`       | orchestrator         | Sub-agent spawned                                        |
| `scope_read`     | writer, verifier     | Source file read                                         |
| `decision`       | any                  | Non-obvious choice made (also appended to decisions.md)  |
| `page_written`   | writer               | Writer finished a page                                   |
| `split_request`  | writer               | Writer requests a plan patch                             |
| `split_applied`  | orchestrator         | Orchestrator patched plan per request                    |
| `verdict`        | verifier             | Verification verdict emitted                             |
| `auto_fix`       | orchestrator         | Writer re-dispatched after fail_soft                     |
| `gate`           | orchestrator         | Quality gate checked                                     |

Plus one meta event any agent may emit when something unexpected happens:

| Event          | Emitter | Purpose                                           |
| -------------- | ------- | ------------------------------------------------- |
| `unexpected`   | any     | Anomaly worth investigating (e.g. missing file)   |

### Event field reference

```jsonc
// phase — orchestrator only
{ "event": "phase", "action": "start" | "end", "duration_ms": <int if end> }

// plan — orchestrator only
{ "event": "plan", "action": "drafted" | "critiqued" | "written",
  "section_count": <int>, "page_count": <int>,
  "critiques": [<strings if critiqued>], "path": "<if written>" }

// stub — orchestrator only
{ "event": "stub", "path": "<wiki-relative path>" }

// dispatch — orchestrator only
{ "event": "dispatch", "target": "<agent_id>",
  "role": "writer" | "verifier", "purpose": "<short string>" }

// scope_read — writer, verifier
{ "event": "scope_read", "path": "<repo-relative path>", "lines": <int> }

// decision — any
{ "event": "decision", "category": "sizing" | "parity" | "nesting" | "other",
  "chose": "<one sentence>", "rationale": "<one sentence>" }

// page_written — writer
{ "event": "page_written", "path": "<wiki-relative path>",
  "words": <int>, "claim_count": <int> }

// split_request — writer
{ "event": "split_request", "parent_page": "<page id>",
  "reason": "<short string>", "children_count": <int> }

// split_applied — orchestrator
{ "event": "split_applied", "parent_page": "<page id>",
  "children_count": <int> }

// verdict — verifier
{ "event": "verdict", "page_id": "<page id>",
  "value": "pass" | "fail_soft" | "fail_hard",
  "stats": { "total_claims": <int>, "verified": <int>,
             "unverified": <int>, "contradicted": <int>,
             "code_refs": <int or null> } }

// auto_fix — orchestrator
{ "event": "auto_fix", "page_id": "<page id>", "attempt": 1 }

// gate — orchestrator
{ "event": "gate", "gate": "<gate name from Quality Gates>",
  "status": "pass" | "fail", "detail": "<short string if fail>" }

// unexpected — any
{ "event": "unexpected", "severity": "low" | "medium" | "high",
  "description": "<one sentence>" }
```

---

## WHAT EACH AGENT LOGS

### Orchestrator (`wiki/.trace/orchestrator.jsonl`)

**Minimum event counts per run.** A complete orchestrator trace emits at
least: one `phase: start` + one `phase: end` for each of the six phases
(1, 2, 3a, 3b, 3c, 3d, 3e — skipped phases still get a pair with a
note), one `stub` per file created in Phase 3a (typically 30–60 for a
mid-size project), one `dispatch` per sub-agent spawned (writers + any
verifiers), and one `gate` per Quality Gate checked in Phase 3e (7+
gates in the default set). A run whose `orchestrator.jsonl` contains
fewer than `stub_count ≥ page_count` and `dispatch_count ≥ writer_count`
is an incomplete trace — emit an `unexpected` event noting the
under-instrumentation and proceed. Past runs have shipped
`orchestrator.jsonl` files with 6 events total, leaving the TIMELINE
blind to ~90% of the orchestrator's actual work.

- `phase: start` at the beginning of each phase; `phase: end` at completion
  with `duration_ms`.
- `plan: drafted`, `plan: critiqued`, `plan: written` during Phase 2.
- `stub` per file created in Phase 3a. These are many events; the
  orchestrator emits them in a loop, not as prose.
- `dispatch` every time a sub-agent is spawned (writers in 3b/3c,
  verifiers in 3d, auto-fix writers as retries).
- `split_applied` when a writer's `split_request` is honored and the plan
  is patched.
- `auto_fix` when re-dispatching a writer after `fail_soft`.
- `gate` for every Quality Gate check run in Phase 3e.
- `decision` for any non-obvious orchestrator choice (e.g. declining a
  split_request, resolving a strict parity gap, picking an auto_fix
  recipient).
- `unexpected` for anomalies (a stub failed to write, a sub-agent returned
  an invalid report, a scope_file listed in the plan does not exist).

### Writer (`wiki/.trace/writer-<section>.jsonl`)

- First event: `scope_read` for the plan file (`wiki/.plan.yaml`).
- `scope_read` for every source file actually read during the deep scan.
- `decision` for non-obvious choices (e.g. "kept the page flat despite 1,800
  LOC because all concerns are cohesive").
- `page_written` for each page written (one writer may write several).
- `split_request` if the writer decides the planned scope is wrong. After
  emitting a split_request the writer terminates.
- `unexpected` for surprises (scope files that don't exist, files that are
  empty, contradictions between scope_files).

### Verifier (`wiki/.trace/verifier-<page>.jsonl`)

- First event: `scope_read` for the draft page being verified.
- `scope_read` for each source file consulted to verify a claim.
- `decision` for scope-expansion choices (e.g. "followed a reference into
  a non-scope file because the claim couldn't be verified within scope").
- One final `verdict` event carrying the full verdict and stats.
- `unexpected` for surprises (scope_files missing, draft is still a stub,
  schema-invalid claim).

---

## DECISIONS LOG (`wiki/.trace/decisions.md`)

Every `decision` JSONL event has a companion entry appended to
`decisions.md`. This gives a human-readable reasoning thread across all
agents. Format:

```markdown
## <ISO-8601 UTC timestamp> — <agent_id> — <category>

**Chose:** <one sentence>
**Considered:** <what alternatives were weighed>
**Why:** <one or two sentences; cite specific evidence from source or plan>

---
```

Rules:

- **Only non-obvious choices.** If the rationale is "followed the spec,"
  do not log it. Log only when a reader would ask "why did it do that?"
- **No noise.** A decision worth logging has an alternative worth
  considering. If there was no real choice, it's not a decision.
- **Append-only.** Never rewrite or delete prior entries.
- **Cite evidence.** "Because the plan said so" is not a rationale;
  "because the scope was 1,800 LOC but the concern areas are tightly
  coupled" is.

Calibration — write a decision entry when:

| Scenario                                                                     | Log? |
| ---------------------------------------------------------------------------- | ---- |
| Declined a split_request because parent is under 1,500 LOC                   | Yes  |
| Accepted a split_request as specified                                        | No   |
| Resolved a strict parity gap by downgrading parity vs. adding a page         | Yes  |
| Picked the first file alphabetically to read                                 | No   |
| Kept a 1,800-LOC page flat because concerns are cohesive                     | Yes  |
| Read every file in scope_files                                               | No   |
| Chose to fold a 200-LOC subsystem into its parent page                       | Yes  |

---

## TIMELINE SYNTHESIS (`wiki/.trace/TIMELINE.md`)

Written by the orchestrator at the end of Phase 3e as one of the finalize
steps. Procedure:

1. Read every `.jsonl` under `wiki/.trace/`. Merge by timestamp.
2. Read `wiki/.trace/decisions.md` for the reasoning layer.
3. Group events by phase.
4. Emit a human-readable narrative, one section per phase, plus a
   decisions summary at the end.

Target format:

```markdown
# Wiki generation run — <date> <time range>

## Phase 1: Scan (<start> — <end>, <duration>)
<2-4 sentences: what the scan found — repo counts, LOC, subsystem counts>

## Phase 2: Plan (<start> — <end>, <duration>)
<2-4 sentences: draft stats, critique outcomes, final plan size>

## Phase 3a: Stub-out (<start> — <end>, <duration>)
<1 sentence: stubs created>

## Phase 3b-3c: Writing (<start> — <end>, <duration>)
<2-4 sentences: writer count, pool size, split_requests issued and how resolved>

## Phase 3d: Verify (<start> — <end>, <duration>)
<2-4 sentences: verdicts breakdown, fail_soft auto-fixes, fail_hard list>

## Phase 3e: Finalize (<start> — <end>, <duration>)
<2-4 sentences: OVERVIEW.md written, gate results summary>

## Notable decisions
<bulleted list of the 5-10 most important entries from decisions.md>

## Anomalies
<bulleted list of any `unexpected` events, grouped by severity>
```

The TIMELINE is for humans. Keep it under 100 lines. The full event data
lives in the JSONL files — do not duplicate it here.

---

## CONSTRAINTS

- Every agent writes to its own JSONL file. Writers and verifiers never
  write to the orchestrator's JSONL, and vice versa.
- JSONL is append-only. Never rewrite a prior line. Correct a mistake by
  emitting a subsequent `unexpected` event.
- A missing trace file is not a run failure — the agent may have crashed
  before its first event. The orchestrator notes this in the TIMELINE
  under Anomalies and proceeds.
- Tracing overhead is bounded: no agent emits more than 200 events per
  run. A writer logging 200 `scope_read` events means the scope was too
  broad — flag that with an `unexpected` severity `medium` and continue.
- If `wiki/.trace/` does not exist when an agent starts, the agent
  creates it before its first write.
- Tracing failures never block the work. If writing a trace event fails,
  the agent proceeds with its primary task and emits an `unexpected`
  event about the trace failure when it can.
