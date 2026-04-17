/**
 * gates.js — deterministic post-worker quality gates.
 *
 * These run after all workers produce markdown, before Notion writes. They do
 * not block writes — they emit warnings so a human can act on the CI log.
 *
 * - checkNumericConsistency: catches the same noun cited with different counts
 *   across sibling pages (the classic drift bug — "33 routes" here vs "32 routes"
 *   there). Matches \b(\d+)\s+(<noun>)\b where <noun> is a whitelist of
 *   doc-specific terms. Narrow noun list avoids false positives on measurements.
 */

const chalk = require('chalk');
const { indent } = require('./log-helpers');

// Nouns that typically carry codebase facts, not measurements. Singular and
// plural both match — the whitelist is plural-form (we strip trailing 's' on
// extraction). Extend as new drift categories are discovered.
const DRIFT_NOUNS = [
  'endpoints', 'routes', 'hooks', 'models', 'achievements', 'questions',
  'levels', 'tiers', 'blocks', 'block types', 'collections', 'middleware',
  'middlewares', 'components', 'primitives', 'languages', 'screens', 'pages',
  'agents', 'jobs', 'providers', 'variants', 'tools', 'fields',
];

const NOUN_PATTERN = DRIFT_NOUNS
  .map((n) => n.replace(/\s+/g, '\\s+'))
  .sort((a, b) => b.length - a.length) // longest first so "block types" wins over "blocks"
  .join('|');

// \b(\d+)\s+(<noun>)\b  — case-insensitive, word-bounded
const COUNT_REGEX = new RegExp(`\\b(\\d+)\\s+(${NOUN_PATTERN})\\b`, 'gi');

function normalizeNoun(noun) {
  const lower = noun.toLowerCase().trim().replace(/\s+/g, ' ');
  // Strip trailing 's' for a crude singular form so "5 routes" and "5 route" bucket together
  if (lower.endsWith('s') && !lower.endsWith('ss')) return lower.slice(0, -1);
  return lower;
}

/**
 * Scan worker results for count/noun pairs and report mismatches.
 *
 * @param {Array<{ page_title?: string, task_id?: string, markdown?: string, skipped?: boolean }>} results
 * @returns {{ issues: Array<{ noun: string, values: Array<{ value: number, page: string }> }>, scanned: number }}
 */
function checkNumericConsistency(results) {
  const active = (results || []).filter((r) => r && !r.skipped && r.markdown);
  /** @type {Map<string, Array<{ value: number, page: string }>>} */
  const byNoun = new Map();

  for (const r of active) {
    const pageLabel = r.page_title || r.task_id || '(unknown page)';
    // Use matchAll on a fresh regex per call — global regex lastIndex is stateful
    const rx = new RegExp(COUNT_REGEX.source, COUNT_REGEX.flags);
    let m;
    while ((m = rx.exec(r.markdown)) !== null) {
      const value = parseInt(m[1], 10);
      const noun = normalizeNoun(m[2]);
      if (!Number.isFinite(value)) continue;
      // Skip obviously non-doc numbers (years, huge counts, zero)
      if (value === 0 || value > 10000) continue;
      const arr = byNoun.get(noun) || [];
      arr.push({ value, page: pageLabel });
      byNoun.set(noun, arr);
    }
  }

  const issues = [];
  for (const [noun, occurrences] of byNoun.entries()) {
    const distinct = new Set(occurrences.map((o) => o.value));
    if (distinct.size > 1) {
      issues.push({ noun, values: occurrences });
    }
  }
  // Stable ordering for log readability
  issues.sort((a, b) => a.noun.localeCompare(b.noun));
  return { issues, scanned: active.length };
}

/**
 * Print the report to stdout. Returns the issue count for caller awareness.
 */
function printNumericConsistencyReport(report, { theme = chalk.cyan } = {}) {
  const { issues, scanned } = report;
  if (!issues.length) {
    console.log(`${indent.L1}${chalk.green('✓')} Numeric consistency: clean across ${scanned} page(s)`);
    return 0;
  }
  console.log(`${indent.L1}${chalk.yellow('⚠')} Numeric consistency: ${chalk.bold(issues.length)} mismatch(es) across ${scanned} page(s)`);
  for (const issue of issues) {
    // Group distinct values so "3 appears twice, 4 once" reads cleanly
    const byValue = new Map();
    for (const occ of issue.values) {
      const arr = byValue.get(occ.value) || [];
      arr.push(occ.page);
      byValue.set(occ.value, arr);
    }
    const valSummary = [...byValue.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([v, pages]) => `${chalk.bold(v)} ${issue.noun}${pages.length > 1 ? ` (×${pages.length})` : ''}`)
      .join(chalk.dim(' vs '));
    console.log(`${indent.L2}${theme(issue.noun)}: ${valSummary}`);
    for (const [v, pages] of byValue.entries()) {
      for (const p of pages) {
        console.log(`${indent.L3}${chalk.dim(`${v} → ${p}`)}`);
      }
    }
  }
  console.log(`${indent.L2}${chalk.dim('(warning only — writes will proceed; review the drifted pages)')}`);
  return issues.length;
}

module.exports = { checkNumericConsistency, printNumericConsistencyReport, DRIFT_NOUNS };
