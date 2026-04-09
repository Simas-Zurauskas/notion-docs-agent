const chalk = require('chalk');

// ---------------------------------------------------------------------------
// Indentation levels
// ---------------------------------------------------------------------------

const indent = {
  L1: '  ',
  L2: '    ',
  L3: '      ',
};

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const label = (key, val) => `${indent.L1}${chalk.bold(key)} ${val}`;
const separator = () => chalk.dim('─'.repeat(60));

/** Phase header — bold colored text with leading newline. */
const phaseHeader = (name, color = chalk.bold.cyan) => color(`\n${name}`);

/** Summary block header — separator + bold title + separator. */
const summaryHeader = (title) => `\n${separator()}\n${chalk.bold(title)}\n${separator()}`;

/** Phase timing footer — dim line showing elapsed seconds. */
const phaseTiming = (name, elapsedMs) =>
  chalk.dim(`${indent.L1}${name} completed in ${Math.round(elapsedMs / 1000)}s`);

/** Status line at L2 indent: icon + text + optional dim detail. */
const statusLine = (icon, text, detail) =>
  `${indent.L2}${icon} ${text}${detail ? chalk.dim(` ${detail}`) : ''}`;

/** Compact agent activity line. */
const agentLine = (agentLabel, { model, turns, elapsed, tools } = {}) => {
  const parts = [];
  if (model) parts.push(model);
  if (turns != null) parts.push(`${turns} turn${turns !== 1 ? 's' : ''}`);
  if (elapsed != null) parts.push(`${Math.round(elapsed / 1000)}s`);
  if (tools?.length) parts.push(`tools: ${tools.join(', ')}`);
  return `${indent.L2}◆ ${agentLabel} ${chalk.dim(`[${parts.join(', ')}]`)}`;
};

// ---------------------------------------------------------------------------
// Context helpers
// ---------------------------------------------------------------------------

function prRef() {
  const num = process.env.PR_NUMBER;
  return num && num !== '0' ? `PR #${num}` : 'push';
}

function changeMeta() {
  return `${prRef()} by ${process.env.PR_AUTHOR} · ${new Date().toISOString().split('T')[0]}`;
}

module.exports = {
  indent,
  label,
  separator,
  phaseHeader,
  summaryHeader,
  phaseTiming,
  statusLine,
  agentLine,
  prRef,
  changeMeta,
};
