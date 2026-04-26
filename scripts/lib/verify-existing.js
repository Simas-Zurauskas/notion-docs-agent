/**
 * verify-existing.js — runs the verifier specialist against a page's CURRENT
 * content (fetched from Notion) and its scope_files (read from the consumer
 * checkout). No disk persistence — verdicts are returned in memory.
 *
 * Verdict contract matches specialists/verifier.md:
 *   pass        — 0 critical AND 0 improvement (consideration is tolerated)
 *   fail_soft   — 1–3 improvement, 0 critical
 *   fail_hard   — 4+ improvement OR any critical
 *
 * The plan stores scope_files as project-rooted paths (e.g. `api/src/index.ts`).
 * The consumer checkout has files relative to its own root (`src/index.ts`).
 * `consumerRepoName` is the prefix used to translate between the two.
 */

const fs = require('fs');
const path = require('path');
const { invokeAgent } = require('./agent');
const { fetchPageMarkdown } = require('./wiki-to-notion');

const VERIFIER_CONCURRENCY = 5;
const VERIFIER_MAX_TURNS = 20;

const VERIFIER_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail_soft', 'fail_hard'] },
    stats: {
      type: 'object',
      properties: {
        total_claims: { type: 'integer', minimum: 0 },
        resolved: { type: 'integer', minimum: 0 },
        consideration: { type: 'integer', minimum: 0 },
        improvement: { type: 'integer', minimum: 0 },
        critical: { type: 'integer', minimum: 0 },
        code_refs: { type: 'integer', minimum: 0 },
      },
      required: ['total_claims', 'resolved', 'consideration', 'improvement', 'critical'],
    },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          status: { type: 'string', enum: ['unverified', 'contradicted', 'code_reference', 'scope_gap'] },
          severity: { type: 'string', enum: ['consideration', 'improvement', 'critical'] },
          claim: { type: 'string' },
          page_location: { type: 'string' },
          evidence: { type: 'string' },
          recommendation: { type: 'string' },
        },
        required: ['id', 'status', 'severity', 'claim', 'page_location', 'recommendation'],
      },
    },
    summary: { type: 'string' },
  },
  required: ['verdict', 'stats', 'issues', 'summary'],
};

function readVerifierPrompt(promptsDir) {
  return fs.readFileSync(path.join(promptsDir, 'specialists/verifier.md'), 'utf8');
}

/**
 * Strip the consumer prefix from scope_files so paths resolve against the
 * consumer's checkout root. `api/src/index.ts` → `src/index.ts` for api/ CI.
 */
function stripConsumerPrefix(scopeFiles, consumerRepoName) {
  if (!consumerRepoName) return scopeFiles || [];
  const prefix = `${consumerRepoName}/`;
  return (scopeFiles || [])
    .filter((p) => p.startsWith(prefix))
    .map((p) => p.slice(prefix.length));
}

function buildAssignmentBlock({ page, markdown, repoRoot, promptsDir, consumerRepoName }) {
  const localScopes = stripConsumerPrefix(page.scope_files, consumerRepoName);
  const planSchemaPath = path.join(path.resolve(promptsDir), 'spec/plan-schema.md');

  return `
---

## YOUR ASSIGNMENT

You are verifying an existing documentation page against its scope_files.
The page's current content is provided inline below — do NOT try to Read it
from disk. Read the source files via Read/Glob/Grep.

**page_id:** ${page.id}
**mode:** ${page.owner_agent}
**scope_files (paths relative to the consumer repo root, ${consumerRepoName || 'unprefixed'}):**
${localScopes.map((f) => `  - ${f}`).join('\n')}

The verifier report schema is documented in ${planSchemaPath}
§ VERIFIER REPORT SCHEMA. Return a structured-output response with verdict
+ stats + issues; the orchestrator does not parse a separate report file.

Verdict rules:
- pass = 0 critical, 0 improvement
- fail_soft = 1–3 improvement, 0 critical
- fail_hard = 4+ improvement OR any critical

### Page content (current state in Notion)

\`\`\`markdown
${markdown.length > 60000 ? markdown.slice(0, 60000) + '\n\n[... truncated; full page is ' + markdown.length + ' chars ...]' : markdown}
\`\`\`
`;
}

/**
 * Verify a page using markdown content already in hand (e.g. just-regenerated
 * output that hasn't been pushed to Notion yet, or a verifier dispatched
 * with content that was fetched separately).
 */
async function verifyMarkdown({ page, markdown, repoRoot, promptsDir, consumerRepoName }) {
  const verifierPrompt = readVerifierPrompt(promptsDir);
  const assignment = buildAssignmentBlock({ page, markdown, repoRoot, promptsDir, consumerRepoName });

  const result = await invokeAgent({
    prompt: verifierPrompt + assignment,
    schema: VERIFIER_OUTPUT_SCHEMA,
    maxTurns: VERIFIER_MAX_TURNS,
    tools: ['Read', 'Glob', 'Grep'],
    cwd: repoRoot,
    label: `Verify: ${page.id}`,
  });

  if (!result) {
    return {
      page,
      verdict: 'fail_hard',
      stats: { total_claims: 0, resolved: 0, consideration: 0, improvement: 0, critical: 0 },
      issues: [{
        id: 1, status: 'scope_gap', severity: 'critical',
        claim: 'verifier produced no structured output',
        page_location: 'throughout',
        recommendation: 'investigate verifier failure (likely transient API or model error)',
      }],
      summary: 'verifier returned no structured output',
    };
  }

  return {
    page,
    verdict: result.verdict,
    stats: result.stats,
    issues: result.issues || [],
    summary: result.summary || '',
  };
}

/**
 * Verify a page by fetching its current content from Notion first.
 */
async function verifyPage({ page, notionId, repoRoot, promptsDir, notionToolPath, consumerRepoName }) {
  let markdown;
  try {
    markdown = await fetchPageMarkdown(notionId, notionToolPath);
  } catch (err) {
    return {
      page,
      verdict: 'fail_hard',
      stats: { total_claims: 0, resolved: 0, consideration: 0, improvement: 0, critical: 0 },
      issues: [{
        id: 1, status: 'scope_gap', severity: 'critical',
        claim: `cannot fetch page from Notion: ${err.message}`,
        page_location: 'fetch',
        recommendation: 'verify NOTION_API_KEY, the notion-map entry, and Notion API health',
      }],
      summary: 'page fetch from Notion failed',
    };
  }

  return verifyMarkdown({ page, markdown, repoRoot, promptsDir, consumerRepoName });
}

/**
 * Verify an array of pages with bounded concurrency.
 *
 * @param {Array<{ page, notionId }>} pageEntries
 */
async function verifyPages(pageEntries, { repoRoot, promptsDir, notionToolPath, consumerRepoName, concurrency = VERIFIER_CONCURRENCY }) {
  const reports = [];
  for (let i = 0; i < pageEntries.length; i += concurrency) {
    const batch = pageEntries.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(({ page, notionId }) =>
        verifyPage({ page, notionId, repoRoot, promptsDir, notionToolPath, consumerRepoName })
      )
    );
    reports.push(...batchResults);
  }
  return reports;
}

module.exports = {
  verifyPage,
  verifyMarkdown,
  verifyPages,
  VERIFIER_OUTPUT_SCHEMA,
};
