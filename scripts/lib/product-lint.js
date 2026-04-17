/**
 * product-lint.js — deterministic code-reference linter for product docs.
 *
 * Mirrors the Phase 3e product code-reference gate from wiki-init.md. Product
 * pages must contain ZERO code references; writers slip them in under pressure
 * despite prompts. This is the safety net.
 *
 * Warn-only by default — reports hits to stdout but doesn't block the Notion
 * write. Callers can inspect the returned issue list and decide to block.
 *
 * Rules we enforce (patterns that should NOT appear in product markdown):
 *
 *   1. Backticked PascalCase identifiers     — `UserModel`, `CourseScreen`
 *   2. Backticked camelCase identifiers      — `useAuth`, `submitModuleQuiz`
 *   3. Backticked SNAKE_CASE constants       — `MAX_NOTES`, `STREAK_FREEZE_MAX`
 *   4. Source-file paths                     — `foo.ts`, `bar.tsx`
 *   5. Literal /api/ URL shapes              — `/api/course/:id`
 *   6. HTTP verbs preceding a path in prose  — `POST /courses`
 *
 * False-positive avoidance:
 *
 *   - We skip content inside ```code fences```. Fenced blocks can legitimately
 *     contain code (e.g. mermaid diagrams, occasional illustrative snippets).
 *     The sync-preserve rule keeps old fences; the rebuild prompt disallows
 *     them. This linter is for PROSE leakage, not fence content.
 *   - We skip content inside () of markdown links [text](url). Product docs use
 *     Notion URLs as targets — those aren't "code references" in the writing.
 *   - Patterns 1-3 require surrounding backticks, so prose phrases like
 *     "JSON" or "OAuth" don't trigger.
 */

const chalk = require('chalk');
const { indent } = require('./log-helpers');

// -- Masking helpers ---------------------------------------------------------

/** Replace every char inside fenced code blocks with spaces so positions line up. */
function maskCodeFences(md) {
  // Match ```<lang?>\n ... \n``` non-greedy; dotall flag for cross-line.
  return md.replace(/```[\s\S]*?```/g, (m) => ' '.repeat(m.length));
}

/** Replace every char inside markdown link URLs [text](url) with spaces. */
function maskLinkTargets(md) {
  // Match "](...)" — we blank only the url portion.
  return md.replace(/\]\(([^)]*)\)/g, (m, url) => `](${' '.repeat(url.length)})`);
}

function sanitize(md) {
  return maskLinkTargets(maskCodeFences(md));
}

// -- Pattern definitions -----------------------------------------------------

const RULES = [
  {
    id: 'backtick-pascal',
    label: 'backticked PascalCase identifier',
    // Backticked token with mixed case, at least one lowercase before a second capital.
    // e.g. `UserModel`, `CourseScreen`, `HomeScreen`. Single capitalized words like
    // `JSON`, `HTTP` don't match (we require a lowercase letter in the middle).
    pattern: /`[A-Z][a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*`/g,
  },
  {
    id: 'backtick-camel',
    label: 'backticked camelCase identifier',
    // Backticked lowercase-starting token with a capital later.
    // e.g. `useAuth`, `submitQuiz`, `nextReviewDate`.
    pattern: /`[a-z][a-zA-Z0-9]*[A-Z][A-Za-z0-9]+`/g,
  },
  {
    id: 'backtick-snake',
    label: 'backticked SNAKE_CASE constant',
    pattern: /`[A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+`/g,
  },
  {
    id: 'source-path',
    label: 'source file path',
    // Match token.ext where ext ∈ {ts, tsx, js, jsx, py, mjs, cjs} — with a path
    // or backticks signaling it's code, not prose. We keep the bar low: any
    // `[word].ts` etc. inside or outside backticks fires.
    pattern: /\b[A-Za-z_][\w-]*\.(?:ts|tsx|js|jsx|py|mjs|cjs)\b/g,
  },
  {
    id: 'api-url',
    label: 'literal /api/ URL',
    pattern: /(?:^|[^/\w])(\/api\/[a-z][\w\/:.-]*)/gm,
  },
  {
    id: 'http-verb',
    label: 'HTTP verb followed by a path',
    pattern: /\b(?:GET|POST|PUT|DELETE|PATCH)\s+\/[\w/:.-]+/g,
  },
];

// -- Public API --------------------------------------------------------------

/**
 * Scan a single markdown string for code-reference hits.
 *
 * @param {string} markdown
 * @returns {Array<{ rule: string, label: string, match: string, line: number }>}
 */
function lintProductMarkdown(markdown) {
  if (!markdown || typeof markdown !== 'string') return [];
  const masked = sanitize(markdown);
  const hits = [];

  for (const rule of RULES) {
    const rx = new RegExp(rule.pattern.source, rule.pattern.flags);
    let m;
    while ((m = rx.exec(masked)) !== null) {
      // Line number for readability — cheap O(n) count via slice.
      const upto = masked.slice(0, m.index);
      const line = (upto.match(/\n/g) || []).length + 1;
      // Capture group 1 wins when present (api-url rule), else full match.
      const text = (m[1] || m[0]).trim();
      hits.push({ rule: rule.id, label: rule.label, match: text, line });
    }
  }
  return hits;
}

/**
 * Lint an array of worker results (each { page_title?, markdown, skipped? }).
 * Returns per-page summary.
 *
 * @param {Array<{ page_title?: string, task_id?: string, markdown?: string, skipped?: boolean }>} results
 */
function lintProductResults(results) {
  const report = [];
  for (const r of (results || [])) {
    if (!r || r.skipped || !r.markdown) continue;
    const hits = lintProductMarkdown(r.markdown);
    if (hits.length) {
      report.push({ page: r.page_title || r.task_id || '(unknown)', hits });
    }
  }
  return report;
}

/**
 * Print the report to stdout. Returns total hit count.
 */
function printProductLintReport(report, { theme = chalk.magenta } = {}) {
  if (!report.length) {
    console.log(`${indent.L1}${chalk.green('✓')} Product code-reference lint: clean`);
    return 0;
  }
  const totalHits = report.reduce((s, r) => s + r.hits.length, 0);
  console.log(`${indent.L1}${chalk.yellow('⚠')} Product code-reference lint: ${chalk.bold(totalHits)} hit(s) across ${report.length} page(s)`);
  for (const entry of report) {
    console.log(`${indent.L2}${theme(entry.page)}`);
    // Group hits by rule for compactness
    const byRule = new Map();
    for (const h of entry.hits) {
      const arr = byRule.get(h.rule) || [];
      arr.push(h);
      byRule.set(h.rule, arr);
    }
    for (const [ruleId, hits] of byRule) {
      const label = hits[0].label;
      const examples = hits.slice(0, 3).map((h) => `L${h.line}: ${chalk.bold(h.match)}`).join(chalk.dim(' · '));
      const more = hits.length > 3 ? chalk.dim(` (+${hits.length - 3} more)`) : '';
      console.log(`${indent.L3}${chalk.dim(label)}: ${examples}${more}`);
    }
  }
  console.log(`${indent.L2}${chalk.dim('(warning only — writes will proceed; rewrite product pages to remove code references)')}`);
  return totalHits;
}

module.exports = { lintProductMarkdown, lintProductResults, printProductLintReport, RULES };
