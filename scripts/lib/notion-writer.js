const fs = require('fs');
const { execSync } = require('child_process');
const chalk = require('chalk');
const { indent } = require('./log-helpers');

/**
 * Write results to Notion via notion-tool.js CLI.
 *
 * @param {Object} opts
 * @param {Array} opts.actions - Plan actions (type, page_id, parent_id, page_title, instructions)
 * @param {Array} opts.results - Worker results (markdown, summary, skipped, skip_reason), indexed to match non-crosslink actions
 * @param {Array} opts.crosslinks - Crosslink actions (optional)
 * @param {string} opts.notionToolPath - Path to notion-tool.js
 * @param {string} opts.metaFn - Function that returns metadata string for a given action type
 * @returns {Array} writeLog entries
 */
function writeResults({ actions, results, crosslinks = [], notionToolPath, metaFn }) {
  const writeLog = [];
  const tool = `node ${notionToolPath}`;
  const env = { ...process.env };

  // Write content results (rewrite/create)
  const contentActions = actions.filter((a) => a.type !== 'crosslink');
  for (let i = 0; i < contentActions.length; i++) {
    const action = contentActions[i];
    const result = results[i];
    const pageLabel = action.page_title || action.type;

    if (result.skipped) {
      writeLog.push({ status: 'skipped', type: action.type, page: pageLabel, detail: result.skip_reason });
      console.log(`${indent.L2}${chalk.yellow('○')} ${pageLabel}: ${chalk.yellow(`skipped — ${result.skip_reason}`)}`);
      continue;
    }

    if (!result.markdown?.trim()) {
      writeLog.push({ status: 'skipped', type: action.type, page: pageLabel, detail: 'Empty markdown' });
      console.log(`${indent.L2}${chalk.yellow('○')} ${pageLabel}: ${chalk.yellow('skipped — empty markdown')}`);
      continue;
    }

    const markdown = result.markdown + (metaFn ? `\n\n*${metaFn(action.type)}*` : '');
    const tmpFile = `/tmp/sync_${action.type}_${(action.page_id || action.page_title || 'new').replace(/[^a-z0-9_-]/gi, '_')}.md`;
    fs.writeFileSync(tmpFile, markdown);

    try {
      switch (action.type) {
        case 'rewrite':
          execSync(`${tool} rewrite ${action.page_id} ${tmpFile}`, { env, encoding: 'utf8', stdio: 'pipe' });
          writeLog.push({ status: 'ok', type: 'rewrite', page: pageLabel, id: action.page_id, detail: `${result.markdown.length} chars` });
          break;
        case 'create': {
          const title = (action.page_title || result.page_title).replace(/"/g, '\\"');
          const output = execSync(`${tool} create ${action.parent_id} "${title}" ${tmpFile}`, { env, encoding: 'utf8', stdio: 'pipe' });
          const match = output.match(/\[([a-f0-9-]+)\]/);
          const createdId = match ? match[1] : null;
          writeLog.push({ status: 'ok', type: 'create', page: pageLabel, id: createdId, detail: `parent: ${action.parent_id}` });
          break;
        }
      }
      console.log(`${indent.L2}${chalk.green('✓')} ${chalk.bold(action.type)} "${pageLabel}"`);
    } catch (err) {
      writeLog.push({ status: 'error', type: action.type, page: pageLabel, id: action.page_id || action.parent_id, detail: err.message });
      console.log(`${indent.L2}${chalk.red('✗')} ${chalk.bold(action.type)} "${pageLabel}" — ${chalk.red(err.message)}`);
    }
  }

  // Write crosslinks
  for (const action of crosslinks) {
    const note = action.instructions;
    const crosslinkMd = `---\n\n> 🔗 ${note}\n\n${metaFn ? `*${metaFn('crosslink')}*` : ''}`;
    const tmpFile = `/tmp/sync_crosslink_${(action.page_id || '').replace(/[^a-z0-9_-]/gi, '_')}.md`;
    fs.writeFileSync(tmpFile, crosslinkMd);

    try {
      execSync(`${tool} append ${action.page_id} ${tmpFile}`, { env, encoding: 'utf8', stdio: 'pipe' });
      writeLog.push({ status: 'ok', type: 'crosslink', page: action.page_title, id: action.page_id, detail: action.instructions.slice(0, 120) });
      console.log(`${indent.L2}${chalk.green('✓')} ${chalk.bold('crosslink')} "${action.page_title}"`);
    } catch (err) {
      writeLog.push({ status: 'error', type: 'crosslink', page: action.page_title, id: action.page_id, detail: err.message });
      console.log(`${indent.L2}${chalk.red('✗')} ${chalk.bold('crosslink')} "${action.page_title}" — ${chalk.red(err.message)}`);
    }
  }

  return writeLog;
}

module.exports = { writeResults };
