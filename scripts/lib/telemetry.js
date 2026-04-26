/**
 * telemetry.js — emit per-run JSON report.
 *
 * Spec: WIKI-PLAN.MD section C4. Written to wiki/.trace/runs/<sha>.json.
 * Surfaces the metrics ops needs (cost, no-op rate, fail counts) so trends
 * are observable without scraping CI logs.
 */

const fs = require('fs');
const path = require('path');

function newReport({ mergeSha, headSha }) {
  return {
    merge_sha: mergeSha || headSha,
    started_at: new Date().toISOString(),
    completed_at: null,
    affected_pages: 0,
    plan_rot_pages: 0,
    verifier_passes: 0,
    regenerations: 0,
    verifier_fail_soft: 0,
    verifier_fail_hard: 0,
    notion_pages_updated: 0,
    notion_pages_skipped: 0,
    duration_seconds: 0,
    disabled: false,
  };
}

function finish(report, { startMs }) {
  report.completed_at = new Date().toISOString();
  report.duration_seconds = Math.round((Date.now() - startMs) / 1000);
  return report;
}

function writeReport(_repoRoot, report) {
  // CI is stateless — there's no committed wiki/.trace/ to write into.
  // Emit to a fixed /tmp path so the workflow can upload it as an artifact.
  const dir = process.env.WIKI_TELEMETRY_DIR || '/tmp/wiki-sync';
  fs.mkdirSync(dir, { recursive: true });
  const slug = (report.merge_sha || 'unknown').slice(0, 12);
  const filename = `${report.started_at.replace(/[:.]/g, '-')}-${slug}.json`;
  const outPath = path.join(dir, filename);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  return outPath;
}

/**
 * Emit a CI alert (currently console-only; replace with Slack/email later).
 */
function alert(message, { severity = 'warn' } = {}) {
  const tag = severity === 'error' ? '::error::' : severity === 'warn' ? '::warning::' : '::notice::';
  // GitHub Actions log annotation format.
  console.log(`${tag}${message}`);
}

module.exports = {
  newReport,
  finish,
  writeReport,
  alert,
};
