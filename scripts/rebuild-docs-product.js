/**
 * rebuild-docs-product.js — Multi-agent documentation engine for product pages.
 *
 * Orchestrates parallel Claude agents to audit and rebuild "How Strive Works"
 * Notion documentation (product-level, no code references):
 *   Phase A: Prepare — fetch docs, generate manifest, build outline
 *   Phase B: Plan   — orchestrator agent produces structured task plan
 *   Phase C: Execute — worker agents read source files & write markdown in parallel,
 *                      then sequential Notion write pass applies changes
 *
 * Usage:
 *   ANTHROPIC_API_KEY=... NOTION_API_KEY=... NOTION_ROOT_ID=... node rebuild-docs-product.js
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const chalk = require('chalk');
const DOC_STANDARDS = require('./doc-standards-product');
const { indent, label, separator, phaseHeader, summaryHeader, phaseTiming } = require('./lib/log-helpers');
const { invokeAgent } = require('./lib/agent');
const { loadDocsIndex, buildDocsOutline, loadChildrenContext } = require('./lib/docs');
const { PLAN_SCHEMA, WORKER_OUTPUT_SCHEMA } = require('./lib/schemas');
const { checkNumericConsistency, printNumericConsistencyReport } = require('./lib/gates');
const { lintProductResults, printProductLintReport } = require('./lib/product-lint');
const { verifyResults, applyVerdicts, printVerifyReport, writeVerifyArtifact } = require('./lib/verify');


const SCRIPTS_DIR = __dirname;
const REPO_ROOT = process.env.REPO_ROOT || path.resolve(SCRIPTS_DIR, '../..');
const DOCS_INDEX_PATH = path.join(REPO_ROOT, '_docs', '_index.json');
const NOTION_TOOL = path.join(SCRIPTS_DIR, 'notion-tool.js');

const CONCURRENCY = 5;
const WORKER_MAX_TURNS = 30;
const THEME = chalk.bold.magenta;

// ---------------------------------------------------------------------------
// Phase A: Prepare
// ---------------------------------------------------------------------------

function generateManifest() {
  const run = (cmd) => execSync(cmd, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();

  const files = run("find src -type f \\( -name '*.ts' -o -name '*.tsx' \\) | grep -v '_generated' | sort");
  const dirs = run('find src -type d -maxdepth 3 | sort');
  const barrels = run("find src -name 'index.ts' -o -name 'index.tsx' | sort");

  return [
    '# Codebase Manifest',
    '',
    '## All TypeScript/TSX files',
    '```',
    files,
    '```',
    '',
    '## Directory tree (depth 3)',
    '```',
    dirs,
    '```',
    '',
    '## Barrel files (index.ts)',
    '```',
    barrels,
    '```',
  ].join('\n');
}

async function prepare() {
  const phaseStart = Date.now();
  console.log(phaseHeader('Phase A: Prepare', THEME));
  console.log(label('Repo root:', chalk.dim(REPO_ROOT)));

  // 1. Fetch Notion docs
  console.log(chalk.cyan(`\n${indent.L1}Fetching Notion documentation…`));
  execSync(`node ${path.join(SCRIPTS_DIR, 'fetch-notion-docs.js')}`, {
    cwd: REPO_ROOT,
    env: process.env,
    stdio: 'inherit',
  });

  // 2. Generate manifest
  console.log(chalk.cyan(`\n${indent.L1}Generating codebase manifest…`));
  const manifest = generateManifest();
  const fileCount = (manifest.match(/\.tsx?$/gm) || []).length;
  console.log(`${indent.L1}${chalk.bold(fileCount)} source files, ${manifest.split('\n').length} manifest lines`);

  // 3. Read docs index
  const docsIndex = loadDocsIndex(DOCS_INDEX_PATH);
  console.log(`\n${indent.L1}Docs index: ${chalk.bold(docsIndex.length)} pages`);
  for (const doc of docsIndex) {
    console.log(`${indent.L2}${chalk.cyan(doc.title || doc.path)} ${chalk.dim(`[${doc.id}]`)}`);
  }

  // 4. Build docs outline (headings only — for orchestrator)
  console.log(chalk.cyan(`\n${indent.L1}Building documentation outline…`));
  const docsOutline = buildDocsOutline(docsIndex, REPO_ROOT);
  console.log(`${indent.L1}Outline: ${chalk.bold(`${Math.round(docsOutline.length / 1024)}KB`)} (headings only)`);

  console.log(phaseTiming('Phase A', Date.now() - phaseStart));
  return { manifest, docsOutline, docsIndex };
}

// ---------------------------------------------------------------------------
// Phase B: Plan (orchestrator agent)
// ---------------------------------------------------------------------------

function buildOrchestratorPrompt(manifest, docsOutline, docsIndex) {
  return `You are a product documentation planning agent for Strive, an AI-powered learning platform.

## Your job

Analyze the codebase file listing and existing documentation outline, then produce a
structured plan. Each task in your plan will be executed by an independent worker agent
that has access to the full codebase via Read, Glob, and Grep tools.

You manage the "How Strive Works" section — product-level documentation that explains
what the platform does, how features work, and the business logic behind them.
These pages are read by everyone: developers, product managers, and leadership.

${DOC_STANDARDS.DOCUMENTATION_PHILOSOPHY}

CRITICAL: All documentation must contain ZERO code references. No file paths, no function
names, no API endpoints, no schema fields, no inline code backticks. Workers will read
the code but must describe everything in plain language.

## Determine the documentation state

- **bootstrap** — No or almost no documentation exists. Design the full page hierarchy.
- **growth** — Pages exist but the codebase has outgrown them. New areas need pages,
  large pages need splitting.
- **maintenance** — Pages exist and roughly match the code. Audit for accuracy and drift.

## Task planning rules

- Each task maps to ONE documentation page (one Notion write operation)
- Always use 'rewrite' for existing pages — never 'append'. Appending causes duplication
  and drift. Produce complete page content with changes integrated.
- For 'rewrite': include page_id and current_doc_file from the docs index
- For 'create': MUST include parent_id and title. Use the page ID of the parent page
  from the docs index — NOT the product root ID. Sub-pages go under their parent.
- **Hierarchical bootstrap** (creating a parent AND its child in the same run —
  common when the knowledge base is empty or missing an entire subtree): if the
  child's parent is being created by another task in THIS plan, set the child's
  parent_id to the parent task's 'id' (its slug) rather than a Notion UUID, and
  add the parent task's id to the child's 'depends_on' array. The pipeline
  swaps the task-id for the real Notion UUID after the parent is created. This
  is the ONLY case where parent_id can be a task slug; every other parent_id
  must be a real Notion UUID from the docs index or the product root ID.
  Plan deep trees in layers — top-level tasks first, then children, then
  grandchildren — with each layer's depends_on pointing at its parent task.
- For 'delete': include page_id — only for pages documenting removed features
- For 'split': create separate child tasks (action: 'create') and one parent task
  (action: 'rewrite') that depends_on the children
- STRONGLY prefer rewriting existing pages over creating new ones.

## Coverage check

After drafting your task list, verify that every major user-facing feature has
corresponding documentation. Cross-reference the codebase manifest against the existing
docs outline. If a significant feature area (authentication, course creation, lessons,
quizzes, gamification, dashboard, etc.) has no page or section, plan a task for it.

## Cross-page consistency

Workers run in parallel and cannot coordinate. Numeric drift — the same count
or threshold appearing with different values on sibling pages — happens when
one page is rewritten and another page citing the same fact is not. When
planning:

- If the code change affects a count, threshold, or constant that is likely
  cited on multiple pages (achievement counts, level thresholds, XP values,
  review intervals, question counts, block-type lists, tier boundaries), task
  EVERY page that could plausibly mention that fact for rewrite — not just the
  "owner" page.
- When the same fact is taught in an OVERVIEW and a detail page, both must say
  the same thing. Past runs have shipped OVERVIEWs contradicting their own
  detail pages (e.g. "mastered items exit the review queue" in the overview
  while the detail page correctly said they stay). Plan both together.
- Tell each worker to re-verify the fact from source independently. Do not
  state "the count is N" in the instructions — that propagates a stale number
  through the instructions themselves.

## Page sizing (feature-scope to depth)

Choose the right granularity per page. Apply recursively — if a page's children
each cover multiple distinct flows, they split further.

| Feature surface                                            | Shape                                                      |
| ---------------------------------------------------------- | ---------------------------------------------------------- |
| A UI toggle, single control, or <150 words of behavior     | Fold into a parent page                                    |
| One screen with one primary flow                           | One standalone page                                        |
| A feature area with 2–5 related screens or flows           | Parent page + 2–5 children                                 |
| A feature area with 6+ flows or distinct sub-areas         | Parent page + children; children may themselves be parents |

A feature deserves its own page when it has: its own screen/UI surface, multiple
states or user decision points, business rules (scoring, scheduling, gating),
or enough depth that a reader would navigate to "how does X work?"

A feature is a subsection, not a page, when: it's a UI control within a larger
screen, it only makes sense in its parent's context, or describing it takes
under 150 words with no business rules.

Anti-patterns to avoid:
- **Catch-all pages** — never group unrelated features ("notes, bookmarks, font
  scaling") on one page just because each is small, unless they share a common
  purpose (e.g. "Personal Learning Tools").
- **Padded sub-pages** — never fragment a simple feature into sub-pages just
  to match a sibling's depth.

## Plan self-critique

Before returning your plan, critique it along five axes and revise if any fail:

1. **Coverage** — is every significant user-facing feature documented? If a
   feature area has no page and no rewrite/create task, you missed it.
2. **Over-factoring** — are any planned pages too thin (<150 words of real
   content) or covering a UI toggle that belongs in a parent? They should merge.
3. **Under-factoring** — does any page's scope cover 6+ distinct flows or
   sub-areas per the table above? It should split.
4. **Drift** — does any count, threshold, or user-facing rule you reference
   appear on multiple pages? If yes, have you tasked every affected page (per
   Cross-page consistency)?
5. **OVERVIEW/detail alignment** — if you're rewriting both an overview and
   one of its detail pages, do the instructions describe the SAME behavior? A
   parent summary that says one thing and a child page that says another is a
   reported bug waiting to happen.

Revise the task list to resolve each critique, then return.

## Instructions field

The instructions you write for each task are the worker agent's primary guidance.
Be specific about WHAT to document and WHAT to verify. The worker has Read, Glob,
and Grep tools and will explore the codebase itself to find the relevant files.
You do NOT need to specify file paths — the worker will discover them.

Include specific verification instructions: "Verify the exact number of wizard steps
by reading the screen component. Check the mastery tier thresholds against the constants.
Confirm what happens when a user tries to sign in with an unverified email."

CRITICAL: Remind workers in every task instruction that output must contain NO code
references — no file paths, function names, endpoints, schema fields, or backticks.
Everything must be described in plain language.

Good: "Document the course creation flow from the user's perspective. Cover what happens
at each step of the wizard, what the user sees, and how AI generates the course structure.
Verify the current number of wizard steps and what each collects. NO code references."

Bad: "Update the course creation page."

${DOC_STANDARDS.PAGE_STRUCTURE}

## Inputs

### CODEBASE MANIFEST (all source files)
${manifest}

### CURRENT DOCUMENTATION OUTLINE (section headings per page)
Below are the section headings for each existing documentation page. This shows you
what topics are already covered. Workers will receive the full page content when rewriting.
${docsOutline}

### DOCS INDEX (Notion page IDs and file paths)
${JSON.stringify(docsIndex, null, 2)}

### PRODUCT ROOT PAGE ID
${process.env.NOTION_ROOT_ID}

## Output

Produce your structured plan. Include clear instructions for each worker explaining
exactly what to document, what to verify, and what the page should cover.
Omit tasks for pages that are already accurate — only include work that needs doing.`;
}

async function orchestrate(manifest, docsOutline, docsIndex) {
  const phaseStart = Date.now();
  console.log(phaseHeader('Phase B: Plan', THEME));

  const prompt = buildOrchestratorPrompt(manifest, docsOutline, docsIndex);
  console.log(chalk.dim(`${indent.L1}Prompt: ${Math.round(prompt.length / 1024)}KB`));

  const plan = await invokeAgent({ prompt, schema: PLAN_SCHEMA, maxTurns: 10, cwd: REPO_ROOT, label: 'Orchestrator' });

  if (!plan || !plan.tasks?.length) {
    console.log(chalk.dim(`${indent.L1}Orchestrator produced no tasks — documentation is up to date.`));
    console.log(phaseTiming('Phase B', Date.now() - phaseStart));
    return { state: 'maintenance', reasoning: 'No changes needed', tasks: [] };
  }

  // Validate create tasks have parent_id
  for (const t of plan.tasks) {
    if (t.action === 'create' && !t.parent_id) {
      console.warn(chalk.yellow(`${indent.L1}${'⚠'} Task "${t.id}" is a create but has no parent_id — will fail at write time`));
    }
  }

  const stateColors = { bootstrap: chalk.magenta, growth: chalk.yellow, maintenance: chalk.green };
  const stateColor = stateColors[plan.state] || chalk.white;
  console.log(label('State:    ', stateColor(plan.state)));
  console.log(label('Reasoning:', chalk.italic(plan.reasoning)));
  console.log(label('Tasks:    ', chalk.bold(plan.tasks.length)));
  console.log('');
  for (const t of plan.tasks) {
    const priorityColor = t.priority === 1 ? chalk.red : t.priority === 2 ? chalk.yellow : chalk.dim;
    const idInfo = t.page_id ? ` [${t.page_id}]` : t.parent_id ? ` → parent [${t.parent_id}]` : '';
    console.log(`${indent.L2}${priorityColor(`P${t.priority}`)} ${chalk.bold(t.action.padEnd(8))} ${chalk.cyan(t.section)}${t.title ? ` "${t.title}"` : ''}${chalk.dim(idInfo)}`);
    console.log(chalk.dim(`${indent.L3}${t.instructions.slice(0, 120)}${t.instructions.length > 120 ? '…' : ''}`));
  }

  console.log(phaseTiming('Phase B', Date.now() - phaseStart));

  return plan;
}

// ---------------------------------------------------------------------------
// Phase C: Execute (workers + Notion writes)
// ---------------------------------------------------------------------------

function buildWorkerPrompt(task, manifest, docsIndex = []) {
  let currentDoc = '';
  if (task.current_doc_file) {
    const docPath = path.join(REPO_ROOT, task.current_doc_file);
    if (fs.existsSync(docPath)) {
      currentDoc = fs.readFileSync(docPath, 'utf8');
    }
  }

  // Hub-page alignment: if this task rewrites a page that has children in
  // Notion, include the children's current content so the worker can align
  // the hub with what the children actually say. Critical for product
  // OVERVIEWs — past runs shipped OVERVIEWs that contradicted their own
  // detail pages.
  let childrenBlock = '';
  if (task.action === 'rewrite' && task.page_id) {
    const ctx = loadChildrenContext(task.page_id, docsIndex, REPO_ROOT);
    if (ctx.count > 0) {
      childrenBlock = `\n## Hub-page alignment

This page is a parent to ${ctx.count} other page(s). Below is what those
children currently say. When your rewrite summarizes or references the
children, the summary MUST match what the children actually describe — not
what the planner's instructions imply. Past runs have shipped OVERVIEWs
contradicting their own detail pages (e.g. "mastered items exit the review
queue" in the OVERVIEW while the detail page correctly said they stay).

If a child claim looks wrong, add a one-line note in your summary; do not
attempt to rewrite the children from this worker. Remember: NO code
references — describe everything in plain language, even when summarizing
technical detail from the children.

${ctx.text}
`;
    }
  }

  return `You are a product documentation writer for Strive, an AI-powered learning platform.
You have ONE job: write complete, accurate product documentation for a specific section.

These pages are part of "How Strive Works" — product-level documentation read by
everyone on the team: developers, product managers, and leadership.

## Your assignment

Section: ${task.section}
Action: ${task.action}
Task ID: ${task.id}

## Instructions from the planner

${task.instructions}

## Current documentation for this page

${currentDoc || '(No existing documentation — write from scratch)'}

## Codebase manifest (all files that exist)

${manifest}

## Process

1. Use the manifest above to identify which files are relevant to your section
2. Use Glob and Grep to find files, Read to examine them (batch 3-5 per turn)
3. Read every relevant file — do not guess or assume
4. Write complete documentation based on what you find in the code

${DOC_STANDARDS.WRITING_STANDARDS}

${DOC_STANDARDS.VERIFICATION_RULES}

${DOC_STANDARDS.QUALITY_CRITERIA}

${DOC_STANDARDS.PAGE_STRUCTURE}

${DOC_STANDARDS.LINK_STANDARDS}
${childrenBlock}
## CRITICAL: No Code References

Your output must contain ZERO code references:
- Never mention file paths, function names, class names, or variable names
- Never mention API endpoints or HTTP methods
- Never mention schema field names, database collections, or model names
- Never use inline code backticks for technical identifiers
- Instead, describe what happens in plain language

## Output

Your structured output must contain:
- task_id: "${task.id}"
- action: "${task.action}"
- markdown: the COMPLETE page content as markdown
- summary: one-line description of what you wrote
- skipped: false (unless the existing docs are already accurate, then true with skip_reason)
${task.page_id ? `- page_id: "${task.page_id}"` : ''}
${task.parent_id ? `- parent_id: "${task.parent_id}"` : ''}
${task.title ? `- title: "${task.title}"` : ''}`;
}

async function runWorkerAgent(task, manifest, docsIndex = []) {
  const prompt = buildWorkerPrompt(task, manifest, docsIndex);

  try {
    const result = await invokeAgent({
      prompt,
      schema: WORKER_OUTPUT_SCHEMA,
      maxTurns: WORKER_MAX_TURNS,
      tools: ['Read', 'Glob', 'Grep'],
      cwd: REPO_ROOT,
      label: `Worker: ${task.section}`,
    });

    if (!result) {
      return {
        task_id: task.id, action: task.action, markdown: '', summary: 'Worker produced no output',
        skipped: true, skip_reason: 'No structured output returned',
      };
    }

    // Always use IDs from the plan — workers can't be trusted to echo them back
    result.page_id = task.page_id || result.page_id;
    result.parent_id = task.parent_id || result.parent_id;
    result.title = task.title || result.title;

    return result;
  } catch (err) {
    return {
      task_id: task.id, action: task.action, markdown: '', summary: `Worker error: ${err.message}`,
      skipped: true, skip_reason: err.message,
    };
  }
}

async function runTaskBatch(tasks, manifest, docsIndex = []) {
  const results = [];
  for (let i = 0; i < tasks.length; i += CONCURRENCY) {
    const batch = tasks.slice(i, i + CONCURRENCY);
    console.log(chalk.cyan(`\n${indent.L1}Batch ${Math.floor(i / CONCURRENCY) + 1}: workers ${i + 1}–${i + batch.length} of ${tasks.length}`));
    const batchStart = Date.now();
    const batchResults = await Promise.all(batch.map((t) => runWorkerAgent(t, manifest, docsIndex)));
    const batchElapsed = Math.round((Date.now() - batchStart) / 1000);
    for (const r of batchResults) {
      const icon = r.skipped ? chalk.yellow('○') : chalk.green('✓');
      const status = r.skipped ? chalk.yellow(`skipped (${r.skip_reason})`) : `${r.action} — ${r.summary}`;
      const mdLen = r.markdown ? `${Math.round(r.markdown.length / 1024)}KB` : '0KB';
      console.log(`${indent.L2}${icon} ${chalk.bold(r.task_id)}: ${status} ${chalk.dim(`[${mdLen}]`)}`);
    }
    console.log(chalk.dim(`${indent.L2}Batch completed in ${batchElapsed}s`));
    results.push(...batchResults);
  }
  return results;
}

function partitionTasks(tasks) {
  const independent = [];
  const dependent = [];
  for (const t of tasks) {
    if (t.depends_on && t.depends_on.length > 0) {
      dependent.push(t);
    } else {
      independent.push(t);
    }
  }
  independent.sort((a, b) => a.priority - b.priority);
  dependent.sort((a, b) => a.priority - b.priority);
  return { independent, dependent };
}

function resolveDependencies(dependentTasks, writeLog) {
  const createdIds = {};
  for (const entry of writeLog) {
    if (entry.created_id) {
      createdIds[entry.task_id] = entry.created_id;
    }
  }

  return dependentTasks.map((task) => {
    // If parent_id references a task that was created in this run (i.e. the
    // planner used the parent task's `id` as a placeholder because the real
    // Notion UUID did not exist at plan time), swap in the real UUID.
    // Existing UUIDs pass through unchanged — they won't match any key in
    // createdIds, which is keyed by task-id slug. This enables hierarchical
    // bootstrap without affecting remap runs.
    if (task.parent_id && createdIds[task.parent_id]) {
      task.parent_id = createdIds[task.parent_id];
    }

    const resolvedIds = (task.depends_on || [])
      .map((depId) => (createdIds[depId] ? `"${depId}" → page ID: ${createdIds[depId]}` : null))
      .filter(Boolean);

    if (resolvedIds.length > 0) {
      task.instructions += `\n\nChild pages created (reference these in the index):\n${resolvedIds.join('\n')}`;
    }

    return task;
  });
}

// ---------------------------------------------------------------------------
// Notion write pass (rebuild-specific: task-based, supports delete/rename)
// ---------------------------------------------------------------------------

function writeToNotion(results) {
  const writeLog = [];
  const tool = `node ${NOTION_TOOL}`;
  const env = { ...process.env };

  for (const result of results) {
    if (result.skipped) {
      writeLog.push({ task_id: result.task_id, status: 'skipped', reason: result.skip_reason });
      console.log(`${indent.L2}${chalk.yellow('○')} ${result.task_id}: ${chalk.yellow(`skipped — ${result.skip_reason}`)}`);
      continue;
    }

    if (!result.markdown || result.markdown.trim().length === 0) {
      writeLog.push({ task_id: result.task_id, status: 'skipped', reason: 'Empty markdown' });
      console.log(`${indent.L2}${chalk.yellow('○')} ${result.task_id}: ${chalk.yellow('skipped — empty markdown')}`);
      continue;
    }

    const tmpFile = `/tmp/doc_${result.task_id.replace(/[^a-z0-9_-]/gi, '_')}.md`;
    fs.writeFileSync(tmpFile, result.markdown);

    try {
      let output;
      switch (result.action) {
        case 'rewrite':
          output = execSync(`${tool} rewrite ${result.page_id} ${tmpFile}`, { env, encoding: 'utf8' });
          writeLog.push({ task_id: result.task_id, status: 'success', action: 'rewrite' });
          break;

        case 'create': {
          if (!result.title || !result.parent_id) {
            writeLog.push({ task_id: result.task_id, status: 'error', error: `Missing title ("${result.title}") or parent_id ("${result.parent_id}")` });
            console.log(`${indent.L2}${chalk.red('✗')} ${result.task_id}: ${chalk.red('create — missing title or parent_id')}`);
            continue;
          }
          const title = result.title.replace(/"/g, '\\"');
          output = execSync(`${tool} create ${result.parent_id} "${title}" ${tmpFile}`, { env, encoding: 'utf8' });
          const match = output.match(/\[([a-f0-9-]+)\]/);
          const createdId = match ? match[1] : null;
          writeLog.push({ task_id: result.task_id, status: 'success', action: 'create', created_id: createdId });
          break;
        }

        case 'delete':
          output = execSync(`${tool} delete ${result.page_id}`, { env, encoding: 'utf8' });
          writeLog.push({ task_id: result.task_id, status: 'success', action: 'delete' });
          break;

        case 'rename': {
          if (!result.title || !result.page_id) {
            writeLog.push({ task_id: result.task_id, status: 'error', error: 'Missing title or page_id' });
            console.log(`${indent.L2}${chalk.red('✗')} ${result.task_id}: ${chalk.red('rename — missing title or page_id')}`);
            continue;
          }
          const newTitle = result.title.replace(/"/g, '\\"');
          output = execSync(`${tool} rename ${result.page_id} "${newTitle}"`, { env, encoding: 'utf8' });
          writeLog.push({ task_id: result.task_id, status: 'success', action: 'rename' });
          break;
        }

        default:
          writeLog.push({ task_id: result.task_id, status: 'skipped', reason: `Unknown action: ${result.action}` });
          continue;
      }

      console.log(`${indent.L2}${chalk.green('✓')} ${chalk.bold(result.task_id)}: ${result.action} — ${result.summary}`);
    } catch (err) {
      writeLog.push({ task_id: result.task_id, status: 'error', error: err.message });
      console.log(`${indent.L2}${chalk.red('✗')} ${chalk.bold(result.task_id)}: ${result.action} — ${chalk.red(err.message)}`);
    }
  }

  return writeLog;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function printSummary(plan, allWriteResults, elapsed) {
  const succeeded = allWriteResults.filter((r) => r.status === 'success').length;
  const skipped = allWriteResults.filter((r) => r.status === 'skipped').length;
  const failed = allWriteResults.filter((r) => r.status === 'error').length;

  console.log(summaryHeader('PRODUCT REBUILD SUMMARY'));

  const stateColors = { bootstrap: chalk.magenta, growth: chalk.yellow, maintenance: chalk.green };
  const stateColor = stateColors[plan.state] || chalk.white;
  console.log(label('State:    ', stateColor(plan.state)));
  console.log(label('Reasoning:', chalk.italic(plan.reasoning)));
  console.log(label('Tasks:    ', `${plan.tasks.length} planned`));
  console.log(label('Results:  ', [
    succeeded && chalk.green(`${succeeded} succeeded`),
    skipped && chalk.yellow(`${skipped} skipped`),
    failed && chalk.red(`${failed} failed`),
  ].filter(Boolean).join(', ')));
  console.log(label('Duration: ', `${elapsed}s`));
  if (failed > 0) {
    console.log('');
    console.log(chalk.red.bold(`${indent.L1}Failures:`));
    for (const r of allWriteResults.filter((r) => r.status === 'error')) {
      console.log(`${indent.L2}${chalk.red('✗')} ${r.task_id}: ${chalk.red(r.error)}`);
    }
  }
  console.log(separator());
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const startTime = Date.now();

  console.log('');
  console.log(THEME('PRODUCT KNOWLEDGE BASE REBUILD'));
  console.log(separator());

  // Phase A
  const { manifest, docsOutline, docsIndex } = await prepare();

  // Phase B
  const plan = await orchestrate(manifest, docsOutline, docsIndex);

  if (plan.tasks.length === 0) {
    console.log(chalk.dim('\nNo tasks to execute. Documentation is up to date.'));
    return;
  }

  // Phase C
  const phaseCStart = Date.now();
  console.log(phaseHeader('Phase C: Execute', THEME));
  const { independent, dependent } = partitionTasks(plan.tasks);

  console.log(label('Independent:', chalk.bold(independent.length)));
  console.log(label('Dependent:  ', chalk.bold(dependent.length)));

  // Run independent workers
  console.log(chalk.cyan(`\n${indent.L1}--- Independent workers ---`));
  const independentResults = await runTaskBatch(independent, manifest, docsIndex);

  // Verifier pass (opt-in) — catches fabricated claims, code-ref leakage, and
  // behavioral drift in product pages before Notion writes. Strict mode blocks
  // critical-issue pages.
  const verifyEnabled = process.env.VERIFY === 'true';
  const verifyStrict = process.env.VERIFY_STRICT === 'true';
  if (verifyEnabled && independentResults.length > 0) {
    console.log(chalk.magenta(`\n${indent.L1}--- Verifier (independent batch, ${verifyStrict ? 'STRICT' : 'warn-only'}) ---`));
    const verifyReports = await verifyResults(independentResults, { mode: 'product', manifest, cwd: REPO_ROOT });
    applyVerdicts(independentResults, verifyReports, { strict: verifyStrict });
    printVerifyReport(verifyReports, { theme: THEME, strict: verifyStrict });
    if (process.env.VERIFY_REPORT_PATH) {
      try { writeVerifyArtifact(verifyReports, process.env.VERIFY_REPORT_PATH); } catch (e) { /* non-fatal */ }
    }
  }

  // Write independent results to Notion
  console.log(chalk.cyan(`\n${indent.L1}--- Writing independent results to Notion ---`));
  const writeLog = writeToNotion(independentResults);

  // Numeric consistency gate — warn on count drift across sibling pages.
  console.log(chalk.cyan(`\n${indent.L1}--- Numeric consistency (independent batch) ---`));
  printNumericConsistencyReport(checkNumericConsistency(independentResults), { theme: THEME });

  // Product code-reference linter — catch code-refs that slipped past the prompt.
  console.log(chalk.cyan(`\n${indent.L1}--- Product code-reference lint (independent batch) ---`));
  printProductLintReport(lintProductResults(independentResults), { theme: THEME });

  // Run dependent workers in waves. See technical rebuild for the full
  // rationale — the iterative loop subsumes the previous single-batch
  // behavior when every task resolves in the first pass (remap scenario),
  // and unlocks hierarchical bootstrap at no cost to remap runs.
  let allWriteResults = [...writeLog];
  if (dependent.length > 0) {
    const createdIds = {};
    for (const e of allWriteResults) if (e.created_id) createdIds[e.task_id] = e.created_id;

    const taskIdsInBatch = new Set(dependent.map((t) => t.id));
    let remaining = [...dependent];
    const allDependentResults = [];
    let waveNum = 0;

    while (remaining.length > 0) {
      waveNum += 1;
      const ready = remaining.filter((t) =>
        (t.depends_on || []).every((d) => createdIds[d] || !taskIdsInBatch.has(d))
      );
      if (!ready.length) {
        console.warn(chalk.yellow(`${indent.L1}⚠ Unresolvable dependencies for ${remaining.length} task(s): ${remaining.map((t) => t.id).join(', ')} — check each task's depends_on list.`));
        break;
      }
      remaining = remaining.filter((t) => !ready.includes(t));

      console.log(chalk.magenta(`\n${indent.L1}--- Dependent workers (wave ${waveNum}, ${ready.length} task(s)) ---`));
      const resolved = resolveDependencies(ready, allWriteResults);
      const waveResults = await runTaskBatch(resolved, manifest, docsIndex);

      if (verifyEnabled && waveResults.length > 0) {
        console.log(chalk.magenta(`\n${indent.L1}--- Verifier (dependent wave ${waveNum}, ${verifyStrict ? 'STRICT' : 'warn-only'}) ---`));
        const waveReports = await verifyResults(waveResults, { mode: 'product', manifest, cwd: REPO_ROOT });
        applyVerdicts(waveResults, waveReports, { strict: verifyStrict });
        printVerifyReport(waveReports, { theme: THEME, strict: verifyStrict });
      }

      console.log(chalk.cyan(`\n${indent.L1}--- Writing dependent results (wave ${waveNum}) to Notion ---`));
      const waveWriteLog = writeToNotion(waveResults);
      allDependentResults.push(...waveResults);
      allWriteResults.push(...waveWriteLog);
      for (const e of waveWriteLog) if (e.created_id) createdIds[e.task_id] = e.created_id;
    }

    // Cross-batch consistency — catches OVERVIEW/detail count drift across
    // any combination of independent + dependent waves.
    console.log(chalk.cyan(`\n${indent.L1}--- Numeric consistency (cross-batch) ---`));
    printNumericConsistencyReport(checkNumericConsistency([...independentResults, ...allDependentResults]), { theme: THEME });

    // Cross-batch product lint — catches leakage in dependent (often OVERVIEW) pages.
    console.log(chalk.cyan(`\n${indent.L1}--- Product code-reference lint (cross-batch) ---`));
    printProductLintReport(lintProductResults([...independentResults, ...allDependentResults]), { theme: THEME });
  }

  console.log(phaseTiming('Phase C', Date.now() - phaseCStart));

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  printSummary(plan, allWriteResults, elapsed);
}

main().catch((err) => {
  console.error(chalk.red.bold('Product rebuild failed:'), err.message);
  process.exit(1);
});
