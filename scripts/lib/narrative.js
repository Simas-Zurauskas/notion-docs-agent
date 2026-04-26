/**
 * narrative.js — pure formatter for the post-run wiki-sync narrative.
 *
 * Input: a `state` object accumulated by the orchestrator across phases.
 * Output: a markdown string suitable for $GITHUB_STEP_SUMMARY (or stdout
 * for local runs).
 *
 * Shape mirrors the skill's recheck.md TIMELINE-entry format: header,
 * per-phase summary table, Notable findings (regenerated pages with a
 * one-sentence why), Anomalies (plan rot, fail_hard, partial states),
 * Skipped (regenerated but re-verify still failed → original kept).
 *
 * No I/O. The orchestrator decides where to write.
 */

const fs = require('fs');

const MAX_REASONING_CHARS = 500;

function truncate(text, max = MAX_REASONING_CHARS) {
  if (!text) return '';
  if (text.length <= max) return text;
  return text.slice(0, max).trimEnd() + '…';
}

function escapePipe(text) {
  return String(text || '').replace(/\|/g, '\\|').replace(/\n+/g, ' ');
}

function topIssueReason(vr) {
  const issues = Array.isArray(vr?.initial?.issues) ? vr.initial.issues : (vr?.issues || []);
  if (issues.length === 0) return '';
  const sev = (s) => (s === 'critical' ? 0 : s === 'improvement' ? 1 : 2);
  const sorted = [...issues].sort((a, b) => sev(a.severity) - sev(b.severity));
  const top = sorted[0];
  if (!top) return '';
  const claim = truncate(top.claim || '', 220);
  return claim;
}

/**
 * Pick the best one-line "why" for a page that ended up regenerated.
 * Prefer the writer's regen summary; fall back to the initial verifier
 * summary; fall back to the top issue claim.
 */
function whyForRegen(vr) {
  if (vr?.regenAction?.summary) return truncate(vr.regenAction.summary);
  if (vr?.initial?.summary) return truncate(vr.initial.summary);
  return topIssueReason(vr) || 'verifier flagged drift';
}

/**
 * Pick the best one-line "why" for a fail_hard page.
 */
function whyForFailHard(vr) {
  if (vr?.summary) return truncate(vr.summary);
  return topIssueReason(vr) || 'verifier returned fail_hard';
}

function buildHeader(state) {
  const r = state.report;
  const mode = state.mode || 'push';
  const sha = (r.merge_sha || '').slice(0, 12);
  const partial = state.partial ? ' · **partial run**' : '';
  const disabled = state.regenDisabled ? ' · **regen disabled**' : '';
  return `# Wiki Sync — ${r.consumer || 'unknown'} @ \`${sha}\`${partial}${disabled}\n\n` +
    `Mode: \`${mode}\` · Duration: ${r.duration_seconds ?? '?'}s · ` +
    `Started: ${r.started_at}\n` +
    (state.regenDisabled
      ? '\n> `WIKI_REGEN_DISABLED=true` — verify and regen were skipped; affected pages listed for visibility only.\n'
      : '');
}

function buildSummaryTable(state) {
  const r = state.report;
  const rows = [
    ['Affected pages',     r.affected_pages],
    ['Plan rot (skipped)', r.plan_rot_pages],
    ['Verifier · pass',    r.verifier_passes],
    ['Verifier · fail_soft', r.verifier_fail_soft],
    ['Verifier · fail_hard', r.verifier_fail_hard],
    ['Regenerated',        r.regenerations],
    ['Pushed to Notion',   r.notion_pages_updated],
  ];
  return [
    '## Phase summary',
    '',
    '| Metric | Count |',
    '| --- | ---: |',
    ...rows.map(([k, v]) => `| ${k} | ${v ?? 0} |`),
    '',
  ].join('\n');
}

function buildNotableFindings(state) {
  const regenerated = (state.verifyReports || []).filter((vr) => vr?.regenAction?.regenerated);
  if (regenerated.length === 0) return '';
  const lines = ['## Notable findings', ''];
  for (const vr of regenerated) {
    const pushed = vr.pushed ? '→ Notion' : 'not pushed';
    const why = whyForRegen(vr);
    lines.push(`- \`${vr.page.id}\` — regenerated, ${pushed}: ${escapePipe(why)}`);
  }
  lines.push('');
  return lines.join('\n');
}

function buildAnomalies(state) {
  const lines = [];
  const failHard = (state.verifyReports || []).filter((vr) => vr?.verdict === 'fail_hard');
  const planRot = state.planRot || [];
  const unmapped = state.unmapped || [];

  if (failHard.length === 0 && planRot.length === 0 && unmapped.length === 0 && !state.partial && !state.error) {
    return '';
  }

  lines.push('## Anomalies', '');

  if (state.error) {
    lines.push(`- **Run errored before completion:** ${escapePipe(state.error.message || String(state.error))}`);
  }
  if (state.partial && !state.error) {
    lines.push('- **Partial run:** orchestrator did not complete all phases');
  }
  for (const vr of failHard) {
    const why = whyForFailHard(vr);
    lines.push(`- **fail_hard** \`${vr.page.id}\` — ${escapePipe(why)} (Notion content unchanged)`);
  }
  for (const p of planRot) {
    const sf = (p.scope_files || []).join(', ');
    lines.push(`- **plan rot** \`${p.id}\` — scope_files match nothing on disk: ${escapePipe(sf)}`);
  }
  for (const p of unmapped) {
    lines.push(`- **unmapped** \`${p.id}\` — affected by diff but no notion-map entry; can't reach Notion`);
  }

  lines.push('');
  return lines.join('\n');
}

function buildSkipped(state) {
  const skipped = (state.verifyReports || []).filter((vr) =>
    vr?.regenAction?.attempted && !vr.regenAction.regenerated && !vr.regenAction.skipped
  );
  if (skipped.length === 0) return '';
  const lines = ['## Skipped (regen attempted but not pushed)', ''];
  for (const vr of skipped) {
    const reason = vr.regenAction?.summary || vr.summary || 'regen failed';
    lines.push(`- \`${vr.page.id}\` — ${escapePipe(truncate(reason))}`);
  }
  lines.push('');
  return lines.join('\n');
}

function buildWriterSkipped(state) {
  const writerSkipped = (state.verifyReports || []).filter((vr) => vr?.regenAction?.skipped);
  if (writerSkipped.length === 0) return '';
  const lines = ['## Writer declined to rewrite', ''];
  for (const vr of writerSkipped) {
    const reason = vr.regenAction?.skipReason || 'no reason given';
    lines.push(`- \`${vr.page.id}\` — ${escapePipe(truncate(reason))}`);
  }
  lines.push('');
  return lines.join('\n');
}

function buildRipples(state) {
  const ripples = new Set();
  for (const vr of state.verifyReports || []) {
    for (const r of vr?.regenAction?.ripples || []) ripples.add(r);
  }
  if (ripples.size === 0) return '';
  const lines = [
    '## Cross-section ripples flagged',
    '',
    'Sibling pages may also need updates. Run `/wiki-system recheck` to verify.',
    '',
  ];
  for (const id of ripples) lines.push(`- \`${id}\``);
  lines.push('');
  return lines.join('\n');
}

function buildEmpty(state) {
  const r = state.report;
  const sha = (r.merge_sha || '').slice(0, 12);
  const reason = state.regenDisabled
    ? '`WIKI_REGEN_DISABLED=true` — verify and regen were skipped'
    : 'No doc-relevant changes; nothing to do';
  return [
    `# Wiki Sync — ${r.consumer || 'unknown'} @ \`${sha}\``,
    '',
    `Mode: \`${state.mode || 'push'}\` · Duration: ${r.duration_seconds ?? '?'}s`,
    '',
    reason + '.',
    '',
  ].join('\n');
}

/**
 * Build the full narrative markdown for one CI run.
 *
 * @param {object} state
 * @param {object} state.report          — telemetry report (counts + meta)
 * @param {Array}  state.verifyReports   — per-page verify+regen lifecycle
 * @param {Array}  state.planRot         — pages skipped due to plan rot
 * @param {Array}  state.unmapped        — pages skipped due to missing notion-map entry
 * @param {boolean} state.regenDisabled  — kill switch was on
 * @param {boolean} state.partial        — orchestrator did not complete all phases
 * @param {Error}  [state.error]         — fatal error if any
 * @param {string} [state.mode]          — 'push' | 'workflow_dispatch'
 * @returns {string} markdown
 */
function build(state) {
  const r = state.report || {};
  const verifyReports = state.verifyReports || [];
  const errored = !!(state.error || state.partial);
  const hasAnyActivity =
    (r.affected_pages && r.affected_pages > 0) ||
    verifyReports.length > 0 ||
    (state.planRot || []).length > 0 ||
    (state.unmapped || []).length > 0;

  if (!hasAnyActivity && !errored) return buildEmpty(state);

  const parts = [
    buildHeader(state),
    buildSummaryTable(state),
    buildNotableFindings(state),
    buildAnomalies(state),
    buildSkipped(state),
    buildWriterSkipped(state),
    buildRipples(state),
  ].filter(Boolean);

  return parts.join('\n');
}

/**
 * Emit the narrative to its sink:
 *   - $GITHUB_STEP_SUMMARY if set (CI environment)
 *   - stdout otherwise (local dev)
 *
 * Never throws — a sink failure logs a warning and returns false.
 */
function emit(markdown) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    try {
      fs.appendFileSync(summaryPath, markdown + '\n');
      return true;
    } catch (err) {
      console.error(`narrative: failed to write GITHUB_STEP_SUMMARY: ${err.message}`);
      console.log('\n' + markdown);
      return false;
    }
  }
  console.log('\n' + markdown);
  return true;
}

module.exports = {
  build,
  emit,
  truncate,
};
