/**
 * affected-pages.js — compute which wiki pages are affected by a diff.
 *
 * Takes a list of changed file paths (from `git diff --name-only`) and a plan,
 * returns the page ids whose `scope_files` globs intersect the diff.
 *
 * This is what makes path-scoped CI cheap: a merge that touches no source
 * file referenced by any page's scope_files triggers zero LLM calls.
 */

const path = require('path');
const { execSync } = require('child_process');

/**
 * Get the list of files changed between two git refs.
 *
 * @param {object} opts
 * @param {string} opts.baseSha — the merge base or previous HEAD
 * @param {string} opts.headSha — the new HEAD
 * @param {string} opts.cwd — repo root for git commands
 * @returns {string[]} repo-relative file paths
 */
function getChangedFiles({ baseSha, headSha, cwd }) {
  if (!baseSha || baseSha.match(/^0+$/)) {
    // First push to a branch, or no parent commit — fall back to HEAD~1.
    baseSha = 'HEAD~1';
  }
  try {
    const out = execSync(
      `git diff --name-only ${baseSha}..${headSha} --`,
      { cwd, encoding: 'utf8' }
    );
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch (err) {
    throw new Error(
      `git diff failed (${baseSha}..${headSha}): ${err.message}. ` +
      `Ensure the workflow checks out with fetch-depth: 0.`
    );
  }
}

/**
 * Test whether a single file path matches a glob pattern.
 * Supports '*' (any chars except /), '**' (any chars including /), and exact match.
 *
 * Examples:
 *   match('api/src/services/foo.ts', 'api/src/services/**')  → true
 *   match('api/src/index.ts',        'api/src/services/**')  → false
 *   match('api/src/foo.ts',          'api/src/*.ts')         → true
 *   match('api/src/foo.test.ts',     'api/src/*.ts')         → true
 *   match('api/src/sub/foo.ts',      'api/src/*.ts')         → false
 */
function matchGlob(filePath, pattern) {
  // Normalize: strip leading ./
  const f = filePath.replace(/^\.\//, '');
  const p = pattern.replace(/^\.\//, '');

  // Build regex from glob.
  let re = '^';
  let i = 0;
  while (i < p.length) {
    const ch = p[i];
    if (ch === '*' && p[i + 1] === '*') {
      // ** → match anything including slashes
      re += '.*';
      i += 2;
      // consume optional trailing slash
      if (p[i] === '/') i += 1;
    } else if (ch === '*') {
      // * → match anything except slashes
      re += '[^/]*';
      i += 1;
    } else if ('.+?^$(){}|[]\\'.includes(ch)) {
      re += '\\' + ch;
      i += 1;
    } else {
      re += ch;
      i += 1;
    }
  }
  re += '$';
  return new RegExp(re).test(f);
}

/**
 * Determine which pages from the plan are affected by a list of changed files.
 *
 * The plan stores scope_files as project-rooted paths (e.g. `api/src/index.ts`)
 * because the skill that generates it sees the unified project root. CI runs
 * inside one consumer repo and `git diff` returns paths relative to THAT
 * repo (e.g. `src/index.ts`). To reconcile, we prefix every diff path with
 * the consumer's name in the project (`<consumerRepoName>/`) before matching.
 *
 * @param {object} plan — parsed plan
 * @param {string[]} changedFiles — repo-relative paths from git diff
 * @param {string} [consumerRepoName] — prefix to prepend (matches the plan's
 *   convention). If omitted, paths are matched as-is (legacy / unified-repo case).
 * @returns {Array<{ page: object, matchedFiles: string[] }>}
 */
function computeAffectedPages(plan, changedFiles, consumerRepoName) {
  const prefixed = consumerRepoName
    ? changedFiles.map((f) => `${consumerRepoName}/${f}`)
    : changedFiles;

  const result = [];
  for (const page of plan.pages) {
    const matched = [];
    for (const file of prefixed) {
      for (const pattern of page.scope_files || []) {
        if (matchGlob(file, pattern)) {
          matched.push(file);
          break;
        }
      }
    }
    if (matched.length > 0) {
      result.push({ page, matchedFiles: matched });
    }
  }
  return result;
}

module.exports = {
  getChangedFiles,
  matchGlob,
  computeAffectedPages,
};
