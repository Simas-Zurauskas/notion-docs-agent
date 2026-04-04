const chalk = require('chalk');

const label = (key, val) => `  ${chalk.bold(key)} ${val}`;
const separator = () => chalk.dim('─'.repeat(60));
const phaseHeader = (name) => chalk.bold.cyan(`\n${name}`);

function prRef() {
  const num = process.env.PR_NUMBER;
  return num && num !== '0' ? `PR #${num}` : 'push';
}

function changeMeta() {
  return `${prRef()} by ${process.env.PR_AUTHOR} · ${new Date().toISOString().split('T')[0]}`;
}

module.exports = { label, separator, phaseHeader, prRef, changeMeta };
