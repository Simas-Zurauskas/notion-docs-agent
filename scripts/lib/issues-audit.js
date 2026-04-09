/**
 * issues-audit.js — Documentation issues auditor.
 *
 * Shared module called by both sync and rebuild scripts after their write phase.
 * Reads all current documentation, compares against the previous issues page,
 * and produces a complete replacement with current problems.
 *
 * Skips silently if the issues page ID env var is not set.
 */

const fs = require('fs');
const { execSync } = require('child_process');
const chalk = require('chalk');
const { indent, phaseHeader, phaseTiming } = require('./log-helpers');
const { invokeAgent } = require('./agent');
const { loadPageContent } = require('./docs');
const { ISSUES_AUDIT_SCHEMA } = require('./schemas');

const ENV_KEYS = {
  technical: 'NOTION_TECHNICAL_ISSUES_PAGE_ID',
  product: 'NOTION_PRODUCT_ISSUES_PAGE_ID',
};

const THEME = {
  technical: chalk.bold.cyan,
  product: chalk.bold.magenta,
};

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

function buildIssuesAuditPrompt({ docType, repoLabel, docsOutline, allDocsContent, currentIssuesContent, runContext }) {
  const isProduct = docType === 'product';
  const docLabel = isProduct ? 'Product ("How Strive Works")' : `Technical — ${repoLabel || 'Unknown'}`;
  const noCodeRule = isProduct
    ? `\n\nCRITICAL: This is product documentation. Issues must NEVER reference code — no file paths,
function names, endpoints, schema fields, or inline code backticks. Describe problems in plain language.`
    : '';

  return `You are a documentation quality auditor for the Strive learning platform.
You audit the ${docLabel} documentation section.

## Your Job

Review ALL current documentation pages and produce a complete, up-to-date issues page.
This page replaces the previous issues page entirely — it is the single source of truth
for known documentation problems in the ${docLabel} section.

## Issue Categories

Classify every issue into exactly one category:

### Critical
Problems that actively mislead readers or leave major gaps:
- Factual errors — documented behavior that does not match reality
- Ghost docs — pages or sections describing features/systems that no longer exist
- Missing docs — major systems, features, or flows with no documentation at all
- Broken structure — pages that are fundamentally disorganized or contradictory

### Improvement
Problems that reduce documentation quality but don't mislead:
- Stale details — minor inaccuracies, outdated configuration values, old names
- Incomplete sections — topics mentioned but not fully explained
- Missing cross-links — pages that should reference each other but don't
- Weak explanations — sections that describe "what" but not "why" or "how"
- Formatting issues — inconsistent heading levels, missing tables where useful

### Consideration
Observations that may or may not warrant action:
- Architecture observations — patterns worth discussing or documenting differently
- Scope questions — whether a topic belongs on a different page or needs splitting
- Redundancy — overlapping content across pages that could be consolidated
- Future-proofing — areas where upcoming changes may require doc updates

## Rules

1. Every issue must reference a specific page by title. Do not raise vague, cross-cutting
   issues without tying them to a specific page.
2. Every issue must have a clear, actionable description. Not "this page could be better"
   but "the Authentication section does not mention the token refresh flow."
3. Do NOT raise issues about the issues page itself.
4. Do NOT raise issues about missing content that is intentionally out of scope
   (e.g., product docs should not cover code internals).
5. Compare the previous issues page (if any) against the current documentation state.
   If a previously listed issue has been fixed, do NOT include it — it is resolved.
   If a previously listed issue still exists, carry it forward.
6. If documentation is in good shape, it is acceptable to produce a page with few or
   no issues. Do not invent problems.${noCodeRule}

## Context

${runContext?.trigger ? `This audit runs after a ${runContext.trigger} operation.` : ''}
${runContext?.summary ? `Run summary: ${runContext.summary}` : ''}

## Previous Issues Page

${currentIssuesContent || '(No previous issues page content — this is the first audit)'}

## Documentation Outline (all pages with headings)

${docsOutline}

## Full Documentation Content (all pages)

${allDocsContent}

## Output Format

Produce the complete issues page as markdown. Use this exact structure:

# Documentation Issues — ${docLabel}

*Last audited: ${new Date().toISOString().split('T')[0]}*

## Critical

> **[Page Title]** — Description of the critical issue.

*(None)* — if no critical issues exist

## Improvement

> **[Page Title]** — Description of the improvement.

*(None)* — if no improvements needed

## Considerations

> **[Page Title]** — Description of the consideration.

*(None)* — if no considerations

---

*Audited against N documentation pages.*

Each issue is a single blockquote line: bold page title in brackets, em dash, description.
Group multiple issues for the same page as separate blockquote lines (not merged).
Keep descriptions concise — one to two sentences max.

In the summary field, state the counts and how many previous issues were resolved.`;
}

// ---------------------------------------------------------------------------
// Content loader
// ---------------------------------------------------------------------------

function buildAllDocsContent(docsIndex, issuesPageId, baseDir) {
  const parts = [];
  for (const doc of docsIndex) {
    if (doc.id === issuesPageId) continue;
    const content = loadPageContent(doc.id, docsIndex, baseDir);
    if (content) {
      parts.push(`=== PAGE: "${doc.title}" [${doc.id}] ===\n${content}`);
    }
  }
  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Run the issues audit phase.
 *
 * @param {Object} opts
 * @param {'technical'|'product'} opts.docType
 * @param {Array} opts.docsIndex - From loadDocsIndex()
 * @param {string} opts.docsOutline - From buildDocsOutline()
 * @param {string} opts.baseDir - REPO_ROOT
 * @param {string} opts.notionToolPath - Absolute path to notion-tool.js
 * @param {string} [opts.repoLabel] - e.g. 'API' or 'Client' — used in page title for technical docs
 * @param {string} [opts.phaseLabel] - e.g. 'Phase 4' or 'Phase D'
 * @param {Object} [opts.runContext]
 * @param {string} [opts.runContext.trigger] - 'sync' or 'rebuild'
 * @param {string} [opts.runContext.summary] - One-line summary of what the run did
 * @param {Array}  [opts.runContext.writeLog] - Write results from preceding phase
 * @returns {Promise<{status: 'ok'|'skipped'|'error', detail: string}>}
 */
async function runIssuesAudit({ docType, docsIndex, docsOutline, baseDir, notionToolPath, repoLabel, phaseLabel, runContext }) {
  const envKey = ENV_KEYS[docType];
  const issuesPageId = process.env[envKey];

  if (!issuesPageId) {
    return { status: 'skipped', detail: `${envKey} not set` };
  }

  const phaseStart = Date.now();
  const theme = THEME[docType] || chalk.bold.cyan;
  console.log(phaseHeader(`${phaseLabel || 'Phase'}: Issues Audit`, theme));

  // Load current issues page content
  const currentIssuesContent = loadPageContent(issuesPageId, docsIndex, baseDir);

  // Load all docs content (excluding issues page)
  const allDocsContent = buildAllDocsContent(docsIndex, issuesPageId, baseDir);
  const pageCount = docsIndex.filter((d) => d.id !== issuesPageId).length;
  console.log(chalk.dim(`${indent.L1}Loaded ${pageCount} pages for audit (${Math.round(allDocsContent.length / 1024)}KB)`));

  // Build prompt
  const prompt = buildIssuesAuditPrompt({
    docType,
    repoLabel,
    docsOutline,
    allDocsContent,
    currentIssuesContent,
    runContext,
  });
  console.log(chalk.dim(`${indent.L1}Prompt: ${Math.round(prompt.length / 1024)}KB`));

  try {
    const result = await invokeAgent({
      prompt,
      schema: ISSUES_AUDIT_SCHEMA,
      maxTurns: 1,
      label: 'Issues Audit',
    });

    if (!result || !result.markdown?.trim()) {
      console.log(chalk.yellow(`${indent.L1}Audit produced no output`));
      console.log(phaseTiming('Issues Audit', Date.now() - phaseStart));
      return { status: 'skipped', detail: 'No output from agent' };
    }

    // Write to Notion
    const tmpFile = `/tmp/issues_audit_${docType}.md`;
    fs.writeFileSync(tmpFile, result.markdown);
    const tool = `node ${notionToolPath}`;
    execSync(`${tool} rewrite ${issuesPageId} ${tmpFile}`, {
      env: process.env,
      encoding: 'utf8',
      stdio: 'pipe',
    });

    const { stats } = result;
    console.log(
      `${indent.L1}${chalk.green('✓')} Issues page updated: ` +
        `${chalk.red(`${stats.critical} critical`)}, ` +
        `${chalk.yellow(`${stats.improvement} improvement`)}, ` +
        `${chalk.dim(`${stats.consideration} considerations`)} ` +
        `${chalk.dim(`(${stats.resolved} resolved)`)}`
    );
    console.log(`${indent.L1}${chalk.dim(result.summary)}`);
    console.log(phaseTiming('Issues Audit', Date.now() - phaseStart));

    return { status: 'ok', detail: result.summary };
  } catch (err) {
    console.log(`${indent.L1}${chalk.red('✗')} Issues audit failed: ${chalk.red(err.message)}`);
    console.log(phaseTiming('Issues Audit', Date.now() - phaseStart));
    return { status: 'error', detail: err.message };
  }
}

module.exports = { runIssuesAudit };
