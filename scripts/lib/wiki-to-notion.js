/**
 * wiki-to-notion.js — Notion read/write for the multi-repo CI flow.
 *
 * Notion is the durable doc store. Page content is fetched from Notion via
 * `notion-tool.js read` and pushed via `notion-tool.js rewrite`. No `wiki/`
 * tree is committed in any consumer repo; only a small notion-map sits at
 * `.notion-docs/notion-map.json` (committed) so CI can resolve page ids to
 * Notion ids.
 *
 * Module surface:
 *   loadNotionMap(repoRoot, [relPath])    — load the page-id → notion-id map
 *   resolveNotionId(notionMap, pageId)    — page id → notion id, or null
 *   fetchPageMarkdown(notionId, toolPath) — Notion → markdown (with retry)
 *   pushPageMarkdown(notionId, md, toolPath) — markdown → Notion (with retry)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const chalk = require('chalk');
const { indent } = require('./log-helpers');

const DEFAULT_NOTION_MAP_REL_PATH = '.notion-docs/notion-map.json';

// Retry policy for transient Notion API errors. Same shape as agent.js.
const NOTION_MAX_ATTEMPTS = 3;
const NOTION_BASE_DELAY_MS = 1500;
const NOTION_BACKOFF_FACTOR = 3;       // 1.5s → 4.5s → 13.5s
const NOTION_JITTER_MS = 500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isRetryableNotionError(reason) {
  if (!reason) return false;
  const msg = String(reason).toLowerCase();
  if (/rate_limited|rate.limit|429/.test(msg)) return true;
  if (/internal_server_error|service_unavailable|gateway_timeout|bad_gateway/.test(msg)) return true;
  if (/\b5\d\d\b/.test(msg)) return true;
  if (/econnreset|enotfound|etimedout|econnrefused|socket hang up|network/.test(msg)) return true;
  return false;
}

function notionBackoffDelay(attempt) {
  const exp = NOTION_BASE_DELAY_MS * Math.pow(NOTION_BACKOFF_FACTOR, attempt);
  return Math.round(exp + Math.random() * NOTION_JITTER_MS);
}

/**
 * Load the notion-map. Throws with a clear message if missing.
 * Returned object maps `<page-id>` → `<notion-page-id>`.
 */
function loadNotionMap(repoRoot, relPath = DEFAULT_NOTION_MAP_REL_PATH) {
  const mapPath = path.join(repoRoot, relPath);
  if (!fs.existsSync(mapPath)) {
    throw new Error(
      `Notion map not found at ${mapPath}. ` +
      `Bootstrap: after the manual Notion upload, copy wiki/.notion-map.json from your local project into this consumer repo at ${relPath}.`
    );
  }
  return JSON.parse(fs.readFileSync(mapPath, 'utf8'));
}

/**
 * Resolve a page id to a Notion page id via the map. Returns null if unmapped.
 * Accepts both "<id>" and "wiki/.../<id>.md" lookup keys (legacy compatibility).
 */
function resolveNotionId(notionMap, pageId) {
  if (notionMap[pageId]) return notionMap[pageId];
  // Legacy: some bootstrap tooling stored keys with the wiki/ prefix and .md suffix.
  for (const [k, v] of Object.entries(notionMap)) {
    const normalized = k.replace(/^wiki\//, '').replace(/\.md$/, '');
    if (normalized === pageId) return v;
  }
  return null;
}

/**
 * Fetch a Notion page as markdown. Returns the markdown string.
 * Retries on transient Notion API errors.
 */
async function fetchPageMarkdown(notionId, notionToolPath) {
  let lastErr = null;
  for (let attempt = 0; attempt < NOTION_MAX_ATTEMPTS; attempt++) {
    try {
      const out = execSync(`node ${notionToolPath} read ${notionId}`, {
        env: process.env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 32 * 1024 * 1024,
      });
      return out;
    } catch (err) {
      lastErr = err;
      const msg = err.stderr ? String(err.stderr) : err.message;
      const isLast = attempt === NOTION_MAX_ATTEMPTS - 1;
      if (isLast || !isRetryableNotionError(msg)) {
        throw new Error(`fetchPageMarkdown(${notionId}) failed: ${msg}`);
      }
      const delay = notionBackoffDelay(attempt);
      console.log(`${indent.L3}${chalk.yellow(`⟲ notion read retry ${attempt + 1}/${NOTION_MAX_ATTEMPTS - 1} after ${delay}ms`)} ${chalk.dim(msg.split('\n')[0])}`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

/**
 * Push a markdown string to a Notion page (full rewrite).
 * Retries on transient errors.
 *
 * @returns {{ ok: boolean, reason?: string }}
 */
async function pushPageMarkdown(notionId, markdown, notionToolPath) {
  // notion-tool's `rewrite` takes a file path; write to a tempfile.
  const tmpFile = path.join(os.tmpdir(), `wiki-sync-${notionId.replace(/[^a-z0-9-]/gi, '_')}.md`);
  // Inject the drift-prevention banner so manual edits in Notion show their ephemeral status.
  const banner = '> ⚠ Auto-generated. Edits in Notion will be overwritten on next sync.\n\n';
  fs.writeFileSync(tmpFile, banner + markdown);

  let lastErr = null;
  try {
    for (let attempt = 0; attempt < NOTION_MAX_ATTEMPTS; attempt++) {
      try {
        execSync(`node ${notionToolPath} rewrite ${notionId} ${tmpFile}`, {
          env: process.env,
          encoding: 'utf8',
          stdio: 'pipe',
        });
        return { ok: true };
      } catch (err) {
        lastErr = err;
        const msg = err.stderr ? String(err.stderr) : err.message;
        const isLast = attempt === NOTION_MAX_ATTEMPTS - 1;
        if (isLast || !isRetryableNotionError(msg)) {
          return { ok: false, reason: msg };
        }
        const delay = notionBackoffDelay(attempt);
        console.log(`${indent.L3}${chalk.yellow(`⟲ notion write retry ${attempt + 1}/${NOTION_MAX_ATTEMPTS - 1} after ${delay}ms`)} ${chalk.dim(msg.split('\n')[0])}`);
        await sleep(delay);
      }
    }
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
  return { ok: false, reason: lastErr ? lastErr.message : 'unknown error' };
}

module.exports = {
  loadNotionMap,
  resolveNotionId,
  fetchPageMarkdown,
  pushPageMarkdown,
};
