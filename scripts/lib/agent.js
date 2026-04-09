const chalk = require('chalk');
const { query } = require('@anthropic-ai/claude-agent-sdk');
const { indent } = require('./log-helpers');

const DEFAULT_MODEL = 'claude-sonnet-4-6';

/**
 * Invoke a Claude agent with structured output.
 * Returns the structured output or null if no result.
 *
 * Pass `label` to enable compact activity logging (agent start + completion).
 */
async function invokeAgent({ prompt, schema, model = DEFAULT_MODEL, maxTurns = 1, tools = [], cwd, label: agentLabel }) {
  const start = Date.now();
  let turnCount = 0;

  if (agentLabel) {
    console.log(`${indent.L2}◆ ${agentLabel} ${chalk.dim(`[${model}, max ${maxTurns} turns]`)}`);
  }

  const conversation = query({
    prompt,
    options: {
      model,
      maxTurns,
      outputFormat: { type: 'json_schema', schema },
      allowedTools: tools,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      ...(cwd && { cwd }),
    },
  });

  let result = null;
  for await (const event of conversation) {
    if (event.type === 'assistant') {
      turnCount++;
    }
    if (event.type === 'result' && event.subtype === 'success') {
      result = event.structured_output || JSON.parse(event.result);
    }
  }

  if (agentLabel) {
    const elapsed = Math.round((Date.now() - start) / 1000);
    const parts = [`${turnCount} turn${turnCount !== 1 ? 's' : ''}`, `${elapsed}s`];
    console.log(`${indent.L3}${chalk.dim(parts.join(' · '))}`);
  }

  return result;
}

module.exports = { invokeAgent, DEFAULT_MODEL };
