#!/usr/bin/env node
/**
 * wiki-sync.js — multi-repo CI orchestrator.
 *
 * Architecture:
 *   - Code lives in git (one repo per consumer).
 *   - Documentation lives in Notion (the durable doc store).
 *   - CI bridges them: per push, read git diff → load plan + notion-map from
 *     the consumer's `.notion-docs/` → fetch affected pages from Notion →
 *     verify against scope_files → regenerate failures → re-verify → push
 *     successful regens to Notion. No git commits for documentation.
 *
 * Required env vars:
 *   ANTHROPIC_API_KEY        — for the verifier and writer sub-agents
 *   NOTION_API_KEY           — for Notion read and rewrite
 *   CONSUMER_REPO_ROOT       — checkout root of the consumer repo
 *   CONSUMER_REPO_NAME       — prefix used in the plan's scope_files (e.g. "api")
 *   BASE_SHA, HEAD_SHA       — git refs for the diff
 *
 * Optional env vars:
 *   PLAN_REL_PATH            — defaults to .notion-docs/plan.yaml
 *   NOTION_MAP_REL_PATH      — defaults to .notion-docs/notion-map.json
 *   WIKI_PROMPTS_DIR         — overrides ../prompts
 *   WIKI_REGEN_DISABLED=true — skip verify+regen; useful as a kill switch
 */

const fs = require('fs');
const path = require('path');
const chalk = require('chalk');

const { loadPlan } = require('./lib/plan');
const { getChangedFiles, computeAffectedPages } = require('./lib/affected-pages');
const { verifyPages, verifyMarkdown } = require('./lib/verify-existing');
const { regenPage } = require('./lib/regen');
const { loadNotionMap, resolveNotionId, fetchPageMarkdown, pushPageMarkdown } = require('./lib/wiki-to-notion');
const { newReport, finish, writeReport, alert } = require('./lib/telemetry');
const { phaseHeader, phaseTiming, summaryHeader, label, separator } = require('./lib/log-helpers');
const { findPlanRot } = require('./lib/scope-validator');
const narrative = require('./lib/narrative');

const SCRIPTS_DIR = __dirname;

async function main() {
  const startMs = Date.now();
  const repoRoot = requireEnv('CONSUMER_REPO_ROOT');
  const consumerRepoName = requireEnv('CONSUMER_REPO_NAME');
  const baseSha = requireEnv('BASE_SHA');
  const headSha = requireEnv('HEAD_SHA');
  const promptsDir = process.env.WIKI_PROMPTS_DIR || path.resolve(SCRIPTS_DIR, '..', 'prompts');
  const planRelPath = process.env.PLAN_REL_PATH || '.notion-docs/plan.yaml';
  const notionMapRelPath = process.env.NOTION_MAP_REL_PATH || '.notion-docs/notion-map.json';
  const notionToolPath = path.join(SCRIPTS_DIR, 'notion-tool.js');
  const regenDisabled = process.env.WIKI_REGEN_DISABLED === 'true';

  const report = newReport({ mergeSha: headSha, headSha });
  report.consumer = consumerRepoName;

  const state = {
    report,
    verifyReports: [],
    planRot: [],
    unmapped: [],
    regenDisabled,
    partial: true, // flipped to false at the end of main()
    error: null,
    mode: process.env.GITHUB_EVENT_NAME || 'push',
  };

  console.log(chalk.bold.cyan('\nWIKI SYNC'));
  console.log(separator());
  console.log(label('Consumer:  ', consumerRepoName));
  console.log(label('Repo root: ', repoRoot));
  console.log(label('Base SHA:  ', baseSha));
  console.log(label('Head SHA:  ', headSha));
  console.log(label('Prompts:   ', promptsDir));
  if (regenDisabled) console.log(chalk.yellow('  WIKI_REGEN_DISABLED=true — skipping regen steps'));
  console.log('');

  try {
    await runPipeline({
      state, startMs, repoRoot, consumerRepoName, baseSha, headSha,
      promptsDir, planRelPath, notionMapRelPath, notionToolPath, regenDisabled,
    });
  } catch (err) {
    state.error = err;
    if (!state.report.completed_at) finish(state.report, { startMs });
    throw err;
  } finally {
    emitNarrativeSafely(state);
  }
  return state;
}

async function runPipeline({
  state, startMs, repoRoot, consumerRepoName, baseSha, headSha,
  promptsDir, planRelPath, notionMapRelPath, notionToolPath, regenDisabled,
}) {
  const { report } = state;

  // Step 0: load the plan + notion-map. Both must be committed under .notion-docs/.
  const plan = loadPlan(repoRoot, planRelPath);
  console.log(label('Plan:      ', `${plan.pages.length} pages, ${(plan.sections || []).length} sections`));

  let notionMap;
  try {
    notionMap = loadNotionMap(repoRoot, notionMapRelPath);
  } catch (err) {
    console.error(chalk.red(`\n✗ ${err.message}`));
    alert(err.message, { severity: 'error' });
    throw err;
  }
  console.log(label('Notion map:', `${Object.keys(notionMap).length} entries`));

  // Phase 0: validation gates. Cheap, pre-LLM checks.
  const phase0 = Date.now();
  console.log(phaseHeader('Phase 0: Validation gates'));

  const planRot = findPlanRot(plan, repoRoot, consumerRepoName);
  const planRotIds = new Set(planRot.map((p) => p.id));
  state.planRot = planRot;
  report.plan_rot_pages = planRot.length;
  if (planRot.length > 0) {
    console.log(chalk.yellow(`  ${planRot.length} page(s) with plan rot in this consumer's slice:`));
    for (const p of planRot) {
      console.log(chalk.yellow(`    - ${p.id}`));
      for (const sf of p.scope_files) console.log(chalk.dim(`        ${sf}`));
    }
    console.log(chalk.yellow('  These pages will be skipped from verify+regen. Update the plan to fix.'));
    alert(`${planRot.length} page(s) in ${consumerRepoName}'s slice have plan rot — scope_files match nothing on disk`, { severity: 'warn' });
  } else {
    console.log(chalk.dim('  Plan rot:  none in this consumer slice'));
  }
  console.log(phaseTiming('Phase 0', Date.now() - phase0));

  // Phase 1: compute affected pages from diff (prefixed with consumer name).
  const phase1 = Date.now();
  console.log(phaseHeader('Phase 1: Affected pages'));
  const changedFiles = getChangedFiles({ baseSha, headSha, cwd: repoRoot });
  console.log(label('Changed:   ', `${changedFiles.length} file(s)`));
  const affectedAll = computeAffectedPages(plan, changedFiles, consumerRepoName);
  const affected = affectedAll.filter((a) => !planRotIds.has(a.page.id));
  const skippedPlanRot = affectedAll.length - affected.length;
  report.affected_pages = affected.length;
  console.log(label('Affected:  ', `${affected.length} page(s)`));
  for (const a of affected) {
    console.log(chalk.dim(`  - ${a.page.id} (${a.matchedFiles.length} matched)`));
  }
  if (skippedPlanRot > 0) {
    console.log(chalk.yellow(`  (${skippedPlanRot} affected page(s) skipped due to plan rot)`));
  }
  console.log(phaseTiming('Phase 1', Date.now() - phase1));

  // Resolve notion ids upfront. Pages without a mapped Notion id can't be
  // verified or regenerated — surface as warnings and skip.
  const verifiable = [];
  const unmapped = [];
  for (const a of affected) {
    const notionId = resolveNotionId(notionMap, a.page.id);
    if (!notionId) {
      unmapped.push(a.page);
    } else {
      verifiable.push({ page: a.page, notionId });
    }
  }
  state.unmapped = unmapped;
  if (unmapped.length > 0) {
    console.log(chalk.yellow(`  ${unmapped.length} affected page(s) have no notion-map entry; skipping:`));
    for (const p of unmapped) console.log(chalk.yellow(`    - ${p.id}`));
    alert(`${unmapped.length} page(s) affected but unmapped in ${notionMapRelPath} — Notion sync can't reach them`, { severity: 'warn' });
  }

  // Phases 2–4: verify, regenerate, re-verify, push.
  let verifyReports = [];
  if (verifiable.length > 0 && !regenDisabled) {
    // Phase 2: verify existing pages.
    const phase2 = Date.now();
    console.log(phaseHeader('Phase 2: Verify existing pages'));
    verifyReports = await verifyPages(verifiable, {
      repoRoot, promptsDir, notionToolPath, consumerRepoName,
    });
    state.verifyReports = verifyReports;
    // Snapshot the pre-regen verifier state so the narrative can show the
    // initial reason a page was flagged even after Phase 3 mutates verdict.
    for (const r of verifyReports) {
      r.initial = {
        verdict: r.verdict,
        summary: r.summary,
        stats: r.stats,
        issues: r.issues || [],
      };
    }
    for (const r of verifyReports) {
      const icon = r.verdict === 'pass' ? chalk.green('✓')
        : r.verdict === 'fail_soft' ? chalk.yellow('⚠')
        : chalk.red('✗');
      console.log(`  ${icon} ${r.page.id}: ${r.verdict} ${chalk.dim(`(critical=${r.stats.critical} improvement=${r.stats.improvement} resolved=${r.stats.resolved})`)}`);
    }
    report.verifier_passes = verifyReports.filter((r) => r.verdict === 'pass').length;
    report.verifier_fail_soft = verifyReports.filter((r) => r.verdict === 'fail_soft').length;
    report.verifier_fail_hard = verifyReports.filter((r) => r.verdict === 'fail_hard').length;
    console.log(phaseTiming('Phase 2', Date.now() - phase2));

    // Phase 3: regenerate failed pages, re-verify, push to Notion on success.
    const needsRegen = verifyReports.filter((r) => r.verdict !== 'pass');
    const allRipples = new Set();

    if (needsRegen.length > 0) {
      const phase3 = Date.now();
      console.log(phaseHeader(`Phase 3: Regenerate ${needsRegen.length} page(s)`));

      for (const vr of needsRegen) {
        // Fetch existing markdown for the writer's "previous version" context.
        const notionId = resolveNotionId(notionMap, vr.page.id);
        let existingMarkdown = '';
        try {
          existingMarkdown = await fetchPageMarkdown(notionId, notionToolPath);
        } catch (err) {
          console.log(`${chalk.dim('  (could not fetch existing — proceeding as fresh generation:')} ${chalk.dim(err.message)})`);
        }

        // Regenerate.
        const regen = await regenPage({
          page: vr.page,
          plan,
          issues: vr.issues || [],
          verdict: vr.verdict,
          repoRoot,
          promptsDir,
          consumerRepoName,
          existingMarkdown,
        });
        for (const r of regen.ripples || []) allRipples.add(r);

        vr.regenAction = {
          attempted: true,
          skipped: !!regen.skipped,
          skipReason: regen.skip_reason,
          regenerated: !!regen.regenerated,
          summary: regen.summary,
          ripples: regen.ripples || [],
          splitRequest: !!regen.split_request,
        };

        if (regen.skipped) {
          console.log(chalk.dim(`  ${vr.page.id}: writer skipped, keeping original verdict ${vr.verdict}`));
          continue;
        }
        if (!regen.regenerated) {
          console.log(chalk.red(`  ${vr.page.id}: regen produced no new content (${regen.summary})`));
          vr.verdict = 'fail_hard';
          continue;
        }
        report.regenerations += 1;

        // Re-verify the regenerated markdown BEFORE pushing — fail_hard never
        // corrupts Notion in this design; we only push verified content.
        const reVerify = await verifyMarkdown({
          page: vr.page,
          markdown: regen.markdown,
          repoRoot, promptsDir, consumerRepoName,
        });

        if (reVerify.verdict === 'fail_soft') {
          console.log(chalk.yellow(`  ${vr.page.id}: still fail_soft after auto-fix → escalating to fail_hard`));
          reVerify.verdict = 'fail_hard';
        }

        vr.verdict = reVerify.verdict;
        vr.stats = reVerify.stats;
        vr.issues = reVerify.issues;
        vr.summary = reVerify.summary;

        if (reVerify.verdict === 'pass') {
          // Push the regenerated markdown to Notion.
          const push = await pushPageMarkdown(notionId, regen.markdown, notionToolPath);
          if (push.ok) {
            console.log(`  ${chalk.green('→ Notion')} ${vr.page.id}`);
            report.notion_pages_updated += 1;
            vr.pushed = true;
          } else {
            console.log(`  ${chalk.red('✗ Notion push')} ${vr.page.id}: ${chalk.red(push.reason)}`);
            alert(`Notion push failed for ${vr.page.id}: ${push.reason}`, { severity: 'error' });
            vr.verdict = 'fail_hard';
            vr.summary = `regenerated but Notion push failed: ${push.reason}`;
            vr.pushed = false;
            vr.pushError = push.reason;
          }
        } else {
          console.log(chalk.dim(`  ${vr.page.id}: regen fail_hard — not pushing to Notion`));
          vr.pushed = false;
        }
      }
      console.log(phaseTiming('Phase 3', Date.now() - phase3));
    }

    // Recompute tallies after regen+re-verify.
    report.verifier_passes = verifyReports.filter((r) => r.verdict === 'pass').length;
    report.verifier_fail_soft = verifyReports.filter((r) => r.verdict === 'fail_soft').length;
    report.verifier_fail_hard = verifyReports.filter((r) => r.verdict === 'fail_hard').length;

    // Surface fail_hard pages prominently. Without persistence, this is the
    // operator's only chance to notice; recheck.md run later picks them up too.
    const fails = verifyReports.filter((r) => r.verdict === 'fail_hard');
    if (fails.length > 0) {
      alert(`${fails.length} page(s) ended in fail_hard; not synced to Notion`, { severity: 'warn' });
      for (const r of fails) {
        console.log(chalk.red(`  fail_hard: ${r.page.id} — ${r.summary}`));
      }
    }
    if (allRipples.size > 0) {
      const rippleList = Array.from(allRipples);
      console.log(chalk.dim(`  ${rippleList.length} cross-section ripple(s) flagged: ${rippleList.join(', ')}`));
      alert(`Cross-section ripples flagged: ${rippleList.join(', ')}. Consider running the wiki-system skill's recheck.md to verify them.`, { severity: 'notice' });
    }
  } else if (verifiable.length > 0 && regenDisabled) {
    console.log(chalk.dim('\nWIKI_REGEN_DISABLED=true — skipping verify+regen.'));
  } else {
    console.log(chalk.dim('\nNo verifiable affected pages — nothing to do.'));
  }

  // Wrap up: write telemetry to /tmp (will be uploaded as a workflow artifact).
  finish(report, { startMs });
  state.partial = false;
  const reportPath = writeReport(repoRoot, report);

  console.log(summaryHeader('SYNC SUMMARY'));
  console.log(label('Consumer:  ', consumerRepoName));
  console.log(label('Affected:  ', String(report.affected_pages)));
  console.log(label('Plan rot:  ', String(report.plan_rot_pages)));
  console.log(label('Verifier:  ', `${report.verifier_passes} pass, ${report.verifier_fail_soft} fail_soft, ${report.verifier_fail_hard} fail_hard`));
  console.log(label('Notion:    ', `${report.notion_pages_updated} updated`));
  console.log(label('Duration:  ', `${report.duration_seconds}s`));
  console.log(label('Report:    ', reportPath));
  console.log('');
}

function emitNarrativeSafely(state) {
  try {
    const md = narrative.build(state);
    narrative.emit(md);
  } catch (err) {
    console.error(chalk.dim(`narrative: emit failed (${err.message}); continuing`));
  }
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(chalk.red(`Missing required env var: ${name}`));
    process.exit(1);
  }
  return v;
}

main().catch((err) => {
  console.error(chalk.red.bold('\nWiki sync failed:'), err.message);
  if (err.stack) console.error(chalk.dim(err.stack));
  process.exit(1);
});
