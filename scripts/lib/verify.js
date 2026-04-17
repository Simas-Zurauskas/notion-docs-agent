/**
 * verify.js — post-generation claim verifier.
 *
 * Mirrors Phase 3d of the wiki-init.md orchestration: after workers produce
 * markdown, before Notion writes, a verifier agent re-reads each page's claims
 * against source and returns a structured issues report. Warn-only by default.
 *
 * Opt-in: the caller decides whether to run this. Typical pattern is to gate
 * on `process.env.VERIFY === 'true'` so default CI runs stay fast.
 *
 * Strict mode: pass `{ strict: true }` to applyVerdicts() to downgrade results
 * with critical issues to skipped — they won't be written to Notion. Default
 * is warn-only: everything still ships and the caller logs the report.
 *
 * Why this exists:
 *   Prompts + deterministic linters catch many classes of bug but not all.
 *   This is the "second pair of eyes" layer — a separate agent whose only job
 *   is to check, with different prompt shape and no stake in defending the
 *   first pass. Past audits found fabricated mechanisms, numeric drift, and
 *   OVERVIEW/detail contradictions that passed earlier gates cleanly.
 */

const chalk = require('chalk');
const { indent } = require('./log-helpers');
const { invokeAgent } = require('./agent');
const { ISSUES_AUDIT_SCHEMA } = require('./schemas');

const VERIFIER_CONCURRENCY = 5;
const VERIFIER_MAX_TURNS = 20;

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

function buildVerifierPrompt({ pageTitle, markdown, mode, manifest }) {
  const codeRefBlock = mode === 'product' ? `
### Code-reference audit (product mode only)

Product pages must contain ZERO code references. In addition to claim
verification, scan the page for:
- Backticked PascalCase identifiers (e.g. \`UserModel\`)
- Backticked camelCase identifiers (e.g. \`useAuth\`)
- Backticked SNAKE_CASE constants (e.g. \`MAX_NOTES\`)
- Source-file paths (\`.ts\`, \`.tsx\`, \`.js\`, \`.py\`)
- Literal /api/ URLs
- HTTP verbs followed by paths (GET /foo, POST /bar)

Each code-reference match is a **critical** issue — product pages must not
contain these. A deterministic linter runs alongside you, but prose leakage
(e.g. "the useAuth hook validates tokens" without backticks) slips past
regex and is your job to catch.
` : '';

  return `You are a documentation verifier for the Strive learning platform.
You have ONE job: check whether the factual claims in a drafted page are
supported by the source code. You are read-only. You do not rewrite pages.

## Your role

A writer agent produced the page below. Your job is to be the second pair of
eyes — catch fabricated claims, drifted counts, and contradictions the writer
missed. You are NOT an editor; you do not patch the page. You emit a
structured issues report.

## Process

1. Read the page below.
2. Identify 5–10 concrete factual claims — statements that could be proved
   wrong by reading source code. Categories:
   - **Numeric** — counts, thresholds, intervals, field counts, endpoint
     counts, XP values
   - **Flow** — multi-step descriptions of what the system does when X
   - **Behavioral** — what happens on success, failure, or edge conditions
   - **Reference** — specific file paths, function names, endpoint URLs
     (technical mode only)
   - **Business rule** — gating, scoring, scheduling, permission checks
3. Verify each claim by reading the source with Read, Glob, and Grep.
   - If the source supports the claim: resolved.
   - If the source contradicts the claim: critical.
   - If the source doesn't clearly support the claim and it's central to the
     page's purpose: critical. If it's marginal: improvement.
   - If the claim is unverifiable from the repo (e.g. references an external
     service's behavior): consideration.
4. Skip non-claims. Framing ("the system supports X"), opinions, audience
   guidance — none of these are factual claims; do not report them.
${codeRefBlock}
## Severity guide

| Severity      | Use when                                                      |
| ------------- | ------------------------------------------------------------- |
| critical      | Claim is contradicted, or a central claim is unverifiable     |
| improvement   | Claim is unverified and matters for reader understanding      |
| consideration | Minor wording, unverifiable external-only behavior            |
| resolved      | Claim was verified against source (report the evidence)       |

## Output format

Your structured output must contain:

- **markdown**: a human-readable issues report. Use this shape:

  \`\`\`
  # Verification report for: <page title>

  Verdict: <pass | warn | fail> (short rationale)

  ## Issues

  ### <issue title> (<severity>)
  - **Claim**: "<quote from page>"
  - **Evidence**: <file:line or "not found in source">
  - **Recommendation**: <actionable fix>

  ### ...
  \`\`\`

- **summary**: one-line verdict. "clean" if zero critical/improvement issues;
  "N issues (X critical)" otherwise.

- **stats**: object with counts per severity:
  - critical: count of critical issues
  - improvement: count of improvement issues
  - consideration: count of consideration issues
  - resolved: count of claims that were verified cleanly (for calibration)

If you find zero issues, return stats with all counters at 0 and a short
"No issues found" markdown.

## Rules (DO NOT violate these)

- You are read-only. Do not emit a rewritten page. Do not invent claims the
  writer didn't make.
- Report only factual claims that could be proved wrong by reading source.
- Cite file:line evidence for every issue. "Numbers seem off" is useless.
  "routes-and-controllers.md says 33 endpoints; src/routes/courseRoutes.ts:44
  declares 32" is useful.
- Do not report style preferences. If the writer chose a heading structure
  you'd have done differently, that's not an issue.

## Inputs

### Page title
${pageTitle}

### Page markdown
${markdown}

### Codebase manifest (all source files)
${manifest || '(not provided — use Glob to discover files)'}

Mode: ${mode}
`;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

async function verifyOne({ result, mode, manifest, cwd }) {
  const pageTitle = result.page_title || result.task_id || '(unknown page)';
  try {
    const prompt = buildVerifierPrompt({ pageTitle, markdown: result.markdown, mode, manifest });
    const report = await invokeAgent({
      prompt,
      schema: ISSUES_AUDIT_SCHEMA,
      maxTurns: VERIFIER_MAX_TURNS,
      tools: ['Read', 'Glob', 'Grep'],
      cwd,
      label: `Verifier: ${pageTitle}`,
    });
    if (!report) {
      return { page: pageTitle, ok: false, stats: emptyStats(), summary: 'No report returned', markdown: '' };
    }
    return {
      page: pageTitle,
      ok: true,
      stats: normalizeStats(report.stats),
      summary: report.summary || '',
      markdown: report.markdown || '',
    };
  } catch (err) {
    return { page: pageTitle, ok: false, stats: emptyStats(), summary: `Verifier error: ${err.message}`, markdown: '' };
  }
}

function emptyStats() {
  return { critical: 0, improvement: 0, consideration: 0, resolved: 0 };
}

function normalizeStats(stats) {
  const base = emptyStats();
  if (!stats || typeof stats !== 'object') return base;
  for (const k of Object.keys(base)) {
    const v = stats[k];
    base[k] = Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
  }
  return base;
}

/**
 * Run a verifier per non-skipped result, in batches.
 *
 * @param {Array} results           worker results (page_title?, markdown, skipped?)
 * @param {Object} opts
 * @param {string} opts.mode        'technical' | 'product'
 * @param {string} [opts.manifest]  optional codebase manifest for context
 * @param {string} [opts.cwd]       repo root for verifier tool access
 * @param {number} [opts.concurrency]
 * @returns {Promise<Array>}        per-result report entries (see verifyOne)
 */
async function verifyResults(results, { mode, manifest, cwd, concurrency = VERIFIER_CONCURRENCY } = {}) {
  const active = (results || []).filter((r) => r && !r.skipped && r.markdown?.trim());
  const reports = [];
  for (let i = 0; i < active.length; i += concurrency) {
    const batch = active.slice(i, i + concurrency);
    const batchReports = await Promise.all(
      batch.map((result) => verifyOne({ result, mode, manifest, cwd }))
    );
    reports.push(...batchReports);
  }
  return reports;
}

// ---------------------------------------------------------------------------
// Verdict application
// ---------------------------------------------------------------------------

/**
 * Walk the reports, log them, and optionally mark critical-issue results as
 * skipped so they don't reach Notion.
 *
 * @param {Array} results           worker results (mutated in strict mode)
 * @param {Array} reports           output of verifyResults
 * @param {Object} opts
 * @param {boolean} [opts.strict]   when true, results with critical issues are
 *                                  marked skipped=true with a skip_reason
 * @returns {{ blocked: number, warned: number, clean: number }}
 */
function applyVerdicts(results, reports, { strict = false } = {}) {
  const byPage = new Map(reports.map((r) => [r.page, r]));
  let blocked = 0;
  let warned = 0;
  let clean = 0;

  for (const result of results || []) {
    if (!result || result.skipped) continue;
    const pageLabel = result.page_title || result.task_id;
    const report = byPage.get(pageLabel);
    if (!report || !report.ok) continue; // no verifier report → don't touch
    const { critical, improvement } = report.stats;

    if (critical > 0) {
      if (strict) {
        result.skipped = true;
        result.skip_reason = `Blocked by verifier: ${critical} critical issue(s)`;
        blocked += 1;
      } else {
        warned += 1;
      }
    } else if (improvement > 0) {
      warned += 1;
    } else {
      clean += 1;
    }
  }
  return { blocked, warned, clean };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function printVerifyReport(reports, { theme = chalk.cyan, strict = false } = {}) {
  if (!reports.length) {
    console.log(`${indent.L1}${chalk.dim('No pages required verification (all skipped or empty).')}`);
    return;
  }
  let totalCritical = 0;
  let totalImprovement = 0;
  let totalConsideration = 0;
  let totalResolved = 0;
  let errored = 0;

  for (const r of reports) {
    if (!r.ok) { errored += 1; continue; }
    totalCritical += r.stats.critical;
    totalImprovement += r.stats.improvement;
    totalConsideration += r.stats.consideration;
    totalResolved += r.stats.resolved;
  }

  const passed = reports.filter((r) => r.ok && r.stats.critical === 0 && r.stats.improvement === 0).length;

  const headline = [
    chalk.bold(reports.length) + ' verified',
    passed && chalk.green(`${passed} clean`),
    totalCritical && chalk.red(`${totalCritical} critical`),
    totalImprovement && chalk.yellow(`${totalImprovement} improvement`),
    totalConsideration && chalk.dim(`${totalConsideration} consideration`),
    errored && chalk.magenta(`${errored} errored`),
  ].filter(Boolean).join(' · ');

  const strictNote = strict && totalCritical > 0
    ? chalk.red(' (strict mode: critical-issue pages BLOCKED from write)')
    : '';

  console.log(`${indent.L1}${chalk.bold('Verification:')} ${headline}${strictNote}`);

  for (const r of reports) {
    if (!r.ok) {
      console.log(`${indent.L2}${chalk.magenta('✗')} ${theme(r.page)}: ${chalk.magenta(r.summary || 'verifier errored')}`);
      continue;
    }
    const { critical, improvement, consideration, resolved } = r.stats;
    if (critical === 0 && improvement === 0 && consideration === 0) {
      console.log(`${indent.L2}${chalk.green('✓')} ${theme(r.page)} ${chalk.dim(`(${resolved} claim(s) verified)`)}`);
      continue;
    }
    const icon = critical > 0 ? chalk.red('✗') : chalk.yellow('⚠');
    const parts = [
      critical && chalk.red(`${critical} critical`),
      improvement && chalk.yellow(`${improvement} improvement`),
      consideration && chalk.dim(`${consideration} consideration`),
      resolved && chalk.dim(`${resolved} resolved`),
    ].filter(Boolean).join(' · ');
    console.log(`${indent.L2}${icon} ${theme(r.page)}: ${parts}`);
    if (r.summary) console.log(`${indent.L3}${chalk.dim(r.summary.slice(0, 180))}`);
  }

  if (totalResolved + totalCritical + totalImprovement + totalConsideration === 0) {
    console.log(`${indent.L2}${chalk.dim('(no factual claims extracted — pages may be too short to audit)')}`);
  }
}

/** Write the full verification markdown reports to a file for later review. */
function writeVerifyArtifact(reports, outPath) {
  const fs = require('fs');
  const lines = [
    `# Verification reports — ${new Date().toISOString()}`,
    '',
    `Total pages: ${reports.length}`,
    '',
    '---',
    '',
  ];
  for (const r of reports) {
    lines.push(`## ${r.page}`, '');
    lines.push(`Summary: ${r.summary || '(none)'}`, '');
    lines.push(`Stats: critical=${r.stats.critical}, improvement=${r.stats.improvement}, consideration=${r.stats.consideration}, resolved=${r.stats.resolved}`, '');
    if (r.markdown?.trim()) {
      lines.push('### Detail', '', r.markdown.trim(), '');
    }
    lines.push('---', '');
  }
  fs.writeFileSync(outPath, lines.join('\n'));
}

module.exports = {
  verifyResults,
  applyVerdicts,
  printVerifyReport,
  writeVerifyArtifact,
  VERIFIER_CONCURRENCY,
};
