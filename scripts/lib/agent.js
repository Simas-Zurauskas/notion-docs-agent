const { query } = require('@anthropic-ai/claude-agent-sdk');

const DEFAULT_MODEL = 'claude-sonnet-4-6';

/**
 * Invoke a Claude agent with structured output.
 * Returns the structured output or null if no result.
 */
async function invokeAgent({ prompt, schema, model = DEFAULT_MODEL, maxTurns = 1, tools = [], cwd }) {
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
    if (event.type === 'result' && event.subtype === 'success') {
      result = event.structured_output || JSON.parse(event.result);
    }
  }

  return result;
}

module.exports = { invokeAgent, DEFAULT_MODEL };
