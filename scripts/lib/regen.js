/**
 * regen.js — regenerate a documentation page after verifier failure.
 *
 * Produces new markdown via the writer specialist agent. In the multi-repo
 * Notion-mediated CI flow, regen does NOT push to Notion or write to disk —
 * it returns the markdown to the caller, who re-verifies it and only then
 * decides to push.
 *
 * Edge cases handled:
 *   - Hand-edit zones (<!-- AUTOREGEN_SKIP_BEGIN/END -->) are extracted from
 *     the existing markdown and spliced back into the regen output by
 *     position. In the Notion flow, comments rarely survive the markdown→
 *     blocks→markdown round-trip, so zones are typically absent in the
 *     fetched existing markdown — splice degrades to a no-op gracefully.
 *   - skipped:true (writer/verifier disagreement) → no markdown returned,
 *     skip_reason surfaced.
 *   - Empty/whitespace markdown → treat as failure.
 *   - split_request → log + return; CI does not auto-act on splits (manual
 *     init.md run required).
 *   - Empty issues list with fail_soft verdict → skip (data inconsistency).
 *   - Agent invocation throws → wrapped in a fail result, caller logs.
 */

const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const { invokeAgent } = require('./agent');
const { indent } = require('./log-helpers');

const REGEN_CONCURRENCY = 3;
const REGEN_MAX_TURNS = 30;

const WRITER_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    page_id: { type: 'string' },
    page_path: { type: 'string' },
    markdown: { type: 'string' },
    summary: { type: 'string' },
    skipped: { type: 'boolean' },
    skip_reason: { type: 'string' },
    cross_section_ripples: { type: 'array', items: { type: 'string' }, default: [] },
    split_request: {
      type: 'object',
      properties: {
        parent_page: { type: 'string' },
        reason: { type: 'string' },
        proposed_structure: { type: 'object' },
      },
    },
  },
  required: ['page_id', 'page_path', 'markdown', 'summary', 'skipped'],
};

const ZONE_BEGIN = '<!-- AUTOREGEN_SKIP_BEGIN -->';
const ZONE_END = '<!-- AUTOREGEN_SKIP_END -->';

// ---------------------------------------------------------------------------
// Hand-edit zones (best-effort; rarely survive Notion round-trip)
// ---------------------------------------------------------------------------

function extractZones(markdown) {
  const zones = [];
  let cursor = 0;
  while (cursor < markdown.length) {
    const beginIdx = markdown.indexOf(ZONE_BEGIN, cursor);
    if (beginIdx === -1) break;
    const endIdx = markdown.indexOf(ZONE_END, beginIdx + ZONE_BEGIN.length);
    if (endIdx === -1) break;
    const zoneEnd = endIdx + ZONE_END.length;
    zones.push({ startIdx: beginIdx, endIdx: zoneEnd, content: markdown.slice(beginIdx, zoneEnd) });
    cursor = zoneEnd;
  }
  return zones;
}

function spliceHandEditZones(existing, regenerated, { log = null } = {}) {
  const existingZones = extractZones(existing || '');
  const regenZones = extractZones(regenerated);

  if (existingZones.length === 0 && regenZones.length === 0) {
    return { merged: regenerated };
  }
  if (existingZones.length !== regenZones.length) {
    const warning = `hand-edit zones drifted: existing has ${existingZones.length}, regen has ${regenZones.length}; shipping regen as-is`;
    if (log) log(chalk.yellow(`${indent.L3}⚠ ${warning}`));
    return { merged: regenerated, warning };
  }
  let result = regenerated;
  for (let i = regenZones.length - 1; i >= 0; i--) {
    const target = regenZones[i];
    const source = existingZones[i];
    result = result.slice(0, target.startIdx) + source.content + result.slice(target.endIdx);
  }
  return { merged: result };
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

function readWriterPrompt(promptsDir, mode) {
  const filename = mode === 'product' ? 'specialists/product.md' : 'specialists/technical.md';
  const promptPath = path.join(promptsDir, filename);
  if (!fs.existsSync(promptPath)) {
    throw new Error(`Writer prompt not found at ${promptPath}`);
  }
  return fs.readFileSync(promptPath, 'utf8');
}

function stripConsumerPrefix(scopeFiles, consumerRepoName) {
  if (!consumerRepoName) return scopeFiles || [];
  const prefix = `${consumerRepoName}/`;
  return (scopeFiles || [])
    .filter((p) => p.startsWith(prefix))
    .map((p) => p.slice(prefix.length));
}

function formatIssue(issue) {
  return [
    `- **id**: ${issue.id}`,
    `  **status**: ${issue.status}`,
    `  **severity**: ${issue.severity}`,
    `  **claim**: ${JSON.stringify(issue.claim || '')}`,
    `  **page_location**: ${issue.page_location || 'throughout'}`,
    `  **evidence**: ${issue.evidence || 'none'}`,
    `  **recommendation**: ${issue.recommendation || 'none'}`,
  ].join('\n');
}

function formatLinks(plan, page) {
  if (!Array.isArray(page.links_to) || page.links_to.length === 0) return 'None.';
  const lines = [];
  for (const linkedId of page.links_to) {
    const target = (plan.pages || []).find((p) => p.id === linkedId)
      || (plan.sections || []).find((s) => s.id === linkedId);
    lines.push(target ? `- ${linkedId} → ${target.path}` : `- ${linkedId} → (not found in plan)`);
  }
  return lines.join('\n');
}

function truncateForPrompt(text, maxChars) {
  if (!text) return '';
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '\n\n[... truncated; full content was ' + text.length + ' chars ...]';
}

function buildAssignment({ page, plan, existingMarkdown, issues, consumerRepoName }) {
  const localScopes = stripConsumerPrefix(page.scope_files, consumerRepoName);

  const existingBlock = existingMarkdown
    ? '### Existing page content (the version that failed verification)\n\n```markdown\n' +
      truncateForPrompt(existingMarkdown, 30000) +
      '\n```'
    : '### Existing page content\n\n*The page is empty or could not be fetched — treat this as a fresh generation.*';

  const issuesBlock = (Array.isArray(issues) && issues.length > 0)
    ? issues.map(formatIssue).join('\n\n')
    : '*No issues provided. The verifier flagged drift but produced no specific issues — re-read source and rewrite the page if it has drifted.*';

  return `

---

## YOUR ASSIGNMENT

You are regenerating one documentation page after the verifier flagged
issues against the existing version. Address every issue in your rewrite.

**page_id:** ${page.id}
**section:** ${page.section}
**owner_agent:** ${page.owner_agent}
**scope_files (paths relative to the consumer repo root, ${consumerRepoName || 'unprefixed'}):**
${localScopes.map((f) => `  - ${f}`).join('\n')}

### Cross-link targets (links_to)
${formatLinks(plan, page)}

${existingBlock}

### Verifier issues to address

${issuesBlock}

### Your task

1. Read every file in scope_files in full using the Read tool. Use Glob and
   Grep to follow references.
2. Use the existing page above as your starting draft (or treat as fresh
   generation if marked empty).
3. Address every issue in the issue list. Verify each claim against source
   as you write.
4. Output the COMPLETE page markdown — both updated sections and unchanged
   sections. Do not omit existing content that is still accurate.

Critical rules:
- **Single-pass write.** Produce the full markdown in one structured output.
  Do NOT use the Write tool. The orchestrator does not write to disk; it
  pushes your output to Notion if re-verification passes.
- **Skipped exit.** If after reading source you conclude the existing page
  is correct and the verifier was wrong, return \`skipped: true\` with a
  \`skip_reason\`. The orchestrator logs and moves on.
- **Split request.** If the page's real scope clearly exceeds the planned
  estimate (multiple distinct concern areas, ~1,500+ LOC), return a
  \`split_request\`. CI does not auto-act on splits — surfaces them for
  the human to handle via init.md.
- **Cross-section ripples.** If your reading reveals sibling pages may
  also need updates, list those page ids in \`cross_section_ripples\`.

### Output

Return structured output:
- \`page_id\`: ${page.id}
- \`markdown\`: the full regenerated page (or empty string if skipped)
- \`summary\`: one-line description of what changed
- \`skipped\`: true | false
- \`skip_reason\`: required if skipped is true
- \`cross_section_ripples\`: array of page ids (empty if none)
- \`split_request\`: only if you are requesting a split
`;
}

// ---------------------------------------------------------------------------
// Single-page regen
// ---------------------------------------------------------------------------

/**
 * Regenerate one page.
 *
 * @param {object} args
 * @param {object} args.page              — plan page entry
 * @param {object} args.plan              — full parsed plan (for links_to lookup)
 * @param {Array}  args.issues            — verifier issue list (may be empty)
 * @param {string} args.verdict           — 'fail_soft' | 'fail_hard'
 * @param {string} args.repoRoot          — consumer repo root (for source reads)
 * @param {string} args.promptsDir
 * @param {string} args.consumerRepoName  — prefix in plan paths
 * @param {string} args.existingMarkdown  — current page content from Notion
 * @returns {Promise<RegenResult>}
 *
 * RegenResult:
 *   {
 *     page,
 *     ok           — agent invocation produced parseable output
 *     regenerated  — new markdown is in `markdown` and ready to be pushed
 *     markdown     — the regenerated content (only when regenerated=true)
 *     skipped      — writer declined to rewrite
 *     skip_reason  — required when skipped=true
 *     summary      — one-line human description
 *     ripples      — string[] of page ids
 *     split_request? — when writer asked for a split (not auto-acted)
 *     warning?     — non-fatal issue (e.g. zone drift)
 *   }
 */
async function regenPage({ page, plan, issues, verdict, repoRoot, promptsDir, consumerRepoName, existingMarkdown }) {
  // Pre-flight checks.
  if (!page || !page.scope_files) {
    return { page, ok: false, regenerated: false, skipped: false, summary: 'invalid page entry', ripples: [] };
  }

  // Issues-list / verdict consistency check.
  if (verdict === 'fail_soft' && (!Array.isArray(issues) || issues.length === 0)) {
    return {
      page,
      ok: true,
      regenerated: false,
      skipped: true,
      skip_reason: 'verdict=fail_soft but issues list is empty (data inconsistency); not regenerating',
      summary: 'skipped due to empty issues list',
      ripples: [],
    };
  }

  // Build prompt: writer specialist + assignment.
  const writerPrompt = readWriterPrompt(promptsDir, page.owner_agent);
  const assignment = buildAssignment({ page, plan, existingMarkdown, issues, consumerRepoName });
  const fullPrompt = writerPrompt + assignment;

  // Invoke the writer agent. CWD = consumer repo root so Read resolves
  // scope_files (we already stripped the consumer prefix in the prompt).
  let result;
  try {
    result = await invokeAgent({
      prompt: fullPrompt,
      schema: WRITER_OUTPUT_SCHEMA,
      maxTurns: REGEN_MAX_TURNS,
      tools: ['Read', 'Glob', 'Grep'],
      cwd: repoRoot,
      label: `Regen: ${page.id}`,
    });
  } catch (err) {
    return { page, ok: false, regenerated: false, skipped: false, summary: `agent error: ${err.message}`, ripples: [] };
  }

  if (!result) {
    return { page, ok: false, regenerated: false, skipped: false, summary: 'writer produced no structured output', ripples: [] };
  }

  const ripples = Array.isArray(result.cross_section_ripples) ? result.cross_section_ripples : [];

  if (result.skipped === true) {
    const reason = result.skip_reason || '(no reason given)';
    console.log(`${indent.L3}${chalk.yellow('○')} writer declined to rewrite — ${chalk.yellow(reason)}`);
    return {
      page, ok: true, regenerated: false, skipped: true, skip_reason: reason,
      summary: result.summary || `skipped: ${reason}`,
      ripples,
    };
  }

  if (result.split_request) {
    console.log(`${indent.L3}${chalk.magenta('⚑')} writer issued split_request (not auto-acted in CI)`);
    return {
      page, ok: true, regenerated: false, skipped: false,
      summary: result.summary || 'split_request issued; manual init.md run required',
      ripples,
      split_request: result.split_request,
    };
  }

  const markdown = (result.markdown || '').trim();
  if (markdown.length === 0) {
    return { page, ok: false, regenerated: false, skipped: false, summary: 'writer returned empty markdown', ripples };
  }

  // Best-effort hand-edit zone preservation. Most Notion round-trips strip
  // HTML comments, so zones are typically absent in `existingMarkdown`.
  // The splice gracefully no-ops in that case.
  const spliced = spliceHandEditZones(existingMarkdown || '', result.markdown, {
    log: (msg) => console.log(msg),
  });

  console.log(`${indent.L3}${chalk.green('✓')} ${page.id}: ${result.summary || 'regenerated'} ${chalk.dim(`[${Math.round(spliced.merged.length / 1024)}KB]`)}`);

  return {
    page,
    ok: true,
    regenerated: true,
    skipped: false,
    markdown: spliced.merged,
    summary: result.summary || 'regenerated',
    ripples,
    warning: spliced.warning,
  };
}

module.exports = {
  regenPage,
  // Exposed for testing.
  extractZones,
  spliceHandEditZones,
  WRITER_OUTPUT_SCHEMA,
  REGEN_CONCURRENCY,
};
