/**
 * plan.js — read and parse the documentation plan.
 *
 * The plan is the coordination spec produced by the wiki-system skill's
 * init.md orchestrator (run manually in Claude Code, not in CI).
 * Wiki-sync.js consumes it to know which pages exist, what scope_files each
 * page documents, and which writer agent owns each page.
 *
 * In CI, the plan + notion-map are committed to each consumer repo at
 * `.notion-docs/` (small project-specific config, NOT the wiki/ tree).
 *
 * Schema: see prompts/spec/plan-schema.md.
 */

const fs = require('fs');
const path = require('path');
const yaml = require('yaml');

const DEFAULT_PLAN_REL_PATH = '.notion-docs/plan.yaml';

/**
 * Load and validate the plan file.
 *
 * @param {string} repoRoot — absolute path to the consumer repo root
 * @param {string} [relPath] — path relative to repoRoot; defaults to .notion-docs/plan.yaml
 * @returns {object} parsed plan
 * @throws if the plan is missing or invalid
 */
function loadPlan(repoRoot, relPath = DEFAULT_PLAN_REL_PATH) {
  const planPath = path.join(repoRoot, relPath);
  if (!fs.existsSync(planPath)) {
    throw new Error(
      `Plan not found at ${planPath}. ` +
      `Bootstrap: run the wiki-system skill locally, then commit ${relPath} from your project's wiki/.plan.yaml into this consumer repo.`
    );
  }
  const raw = fs.readFileSync(planPath, 'utf8');
  const plan = yaml.parse(raw);

  validatePlan(plan);
  return plan;
}

/**
 * Enforce the invariants from spec/plan-schema.md.
 */
function validatePlan(plan) {
  if (!plan || typeof plan !== 'object') {
    throw new Error('Plan is not an object');
  }
  if (!plan.meta) throw new Error('Plan missing `meta`');
  if (!Array.isArray(plan.sections)) throw new Error('Plan missing `sections[]`');
  if (!Array.isArray(plan.pages)) throw new Error('Plan missing `pages[]`');

  const sectionIds = new Set(plan.sections.map((s) => s.id));
  const pagePaths = new Set();

  for (const section of plan.sections) {
    if (!section.id) throw new Error('Section missing id');
    if (!section.path) throw new Error(`Section ${section.id} missing path`);
    if (!section.path.startsWith('wiki/reference/')) {
      throw new Error(
        `Section ${section.id} path "${section.path}" must start with wiki/reference/`
      );
    }
    if (section.parent && !sectionIds.has(section.parent)) {
      throw new Error(`Section ${section.id} references unknown parent ${section.parent}`);
    }
  }

  for (const page of plan.pages) {
    if (!page.id) throw new Error('Page missing id');
    if (!page.path) throw new Error(`Page ${page.id} missing path`);
    if (!page.path.startsWith('wiki/reference/')) {
      throw new Error(
        `Page ${page.id} path "${page.path}" must start with wiki/reference/`
      );
    }
    if (!page.path.endsWith('.md')) {
      throw new Error(`Page ${page.id} path must end with .md`);
    }
    if (!page.section || !sectionIds.has(page.section)) {
      throw new Error(`Page ${page.id} has unknown section "${page.section}"`);
    }
    if (!Array.isArray(page.scope_files) || page.scope_files.length === 0) {
      throw new Error(`Page ${page.id} missing scope_files`);
    }
    if (!['technical', 'product'].includes(page.owner_agent)) {
      throw new Error(`Page ${page.id} has invalid owner_agent "${page.owner_agent}"`);
    }
    if (pagePaths.has(page.path)) {
      throw new Error(`Duplicate page path "${page.path}"`);
    }
    pagePaths.add(page.path);
  }
}

/**
 * Get a page entry by id.
 */
function getPage(plan, pageId) {
  return plan.pages.find((p) => p.id === pageId) || null;
}

/**
 * Get a section entry by id.
 */
function getSection(plan, sectionId) {
  return plan.sections.find((s) => s.id === sectionId) || null;
}

module.exports = {
  loadPlan,
  validatePlan,
  getPage,
  getSection,
};
