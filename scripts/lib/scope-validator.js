/**
 * scope-validator.js — verify every page's scope_files glob matches at
 * least one file in the working tree at HEAD.
 *
 * Why: CI conflates two failure modes today.
 *   1. DRIFT — code changed, page hasn't caught up. Verifier flags
 *      unverified claims; CI regenerates the page. Correct.
 *   2. PLAN ROT — a scope_file was renamed or deleted but the plan still
 *      references the old path. Verifier flags unverified claims (it can't
 *      Read what isn't there); CI tries to regen; writer also can't Read
 *      it; output is stale or hallucinated. Wasted dispatches, ambiguous
 *      diagnostics.
 *
 * This validator runs in Phase 0 (before any agent dispatch). For every
 * page that has a non-empty scope_files list, it expands each glob and
 * reports pages with zero matches. Phase 1 then filters those pages out
 * of the affected-pages set so they aren't verified or regenerated.
 *
 * Design choices:
 *   - Uses the `glob` npm package (stable, cross-Node-version) rather than
 *     Node 22's `fs.globSync` (still experimental).
 *   - Skips plan entries without scope_files (sections, OVERVIEW, etc.).
 *   - Skips pages where scope_files is explicitly an empty array.
 *   - Treats glob errors (malformed patterns) as "no match" rather than
 *     halting — surfaces them in the report just like a missing file.
 */

const { globSync } = require('glob');

/**
 * Validate scope_files for every page in the plan that belongs to this consumer.
 *
 * The plan covers the whole project (multi-repo). A page's scope_files are
 * project-rooted (e.g. `api/src/index.ts`). When CI runs inside one consumer
 * repo, that repo's checkout only contains its own files — `api/` CI can't
 * see `client/` files. So we filter to pages whose first scope_file path
 * segment matches `consumerRepoName`, then strip the prefix before glob-matching
 * against the consumer's working tree.
 *
 * @param {object} plan              — parsed plan
 * @param {string} repoRoot          — absolute path to the consumer repo root
 * @param {string} consumerRepoName  — repo name as it appears in plan paths
 *                                     (e.g. "api"). Required for multi-repo
 *                                     plans; pass undefined for legacy paths.
 * @returns {Array<{ id: string, path: string, scope_files: string[], matched: 0 }>}
 *          Pages whose scope_files match nothing on disk.
 */
function findPlanRot(plan, repoRoot, consumerRepoName) {
  const stale = [];
  const prefix = consumerRepoName ? `${consumerRepoName}/` : null;

  for (const page of plan.pages || []) {
    if (!Array.isArray(page.scope_files) || page.scope_files.length === 0) continue;

    // Filter to scope_files that belong to this consumer.
    const ownScopes = prefix
      ? page.scope_files.filter((p) => p.startsWith(prefix))
      : page.scope_files;
    if (ownScopes.length === 0) continue; // page is owned by another consumer

    const matched = new Set();
    for (const pattern of ownScopes) {
      // Strip the consumer prefix before globbing — files live at repo root
      // inside the consumer checkout, not nested under `<consumer>/`.
      const localPattern = prefix ? pattern.slice(prefix.length) : pattern;
      try {
        const hits = globSync(localPattern, { cwd: repoRoot, nodir: true });
        for (const h of hits) matched.add(h);
      } catch {
        // Malformed pattern → treat as no match. Plan owner should fix it.
      }
    }

    if (matched.size === 0) {
      stale.push({
        id: page.id,
        path: page.path,
        scope_files: ownScopes,
        matched: 0,
      });
    }
  }

  return stale;
}

module.exports = { findPlanRot };
