const chalk = require('chalk');
const { query } = require('@anthropic-ai/claude-agent-sdk');
const { indent } = require('./log-helpers');

const DEFAULT_MODEL = 'claude-sonnet-4-6';

// Retry policy for transient API errors (429, 5xx, network blips). Terminal
// errors (auth, validation, schema mismatch) bubble up immediately — retrying
// them just wastes time and money.
const MAX_RETRY_ATTEMPTS = 3;       // total attempts: initial + 2 retries
const RETRY_BASE_DELAY_MS = 2000;
const RETRY_BACKOFF_FACTOR = 4;     // 2s → 8s → 32s
const RETRY_JITTER_MS = 1000;

/**
 * Decide whether an error is worth retrying. Conservative — when in doubt,
 * don't retry. The cost of a wrong retry is double-charging; the cost of a
 * wrong non-retry is a single fail_hard verdict that re-runs on next push.
 */
function isRetryable(err) {
  if (!err) return false;
  const status = err.status || err.statusCode || (err.error && err.error.status);
  if (status === 429) return true;
  if (status >= 500 && status < 600) return true;

  const msg = String(err.message || '').toLowerCase();
  if (/rate.?limit|too many requests|429/.test(msg)) return true;
  if (/\b5\d\d\b|service.unavailable|bad gateway|gateway timeout/.test(msg)) return true;
  if (/econnreset|enotfound|etimedout|econnrefused|socket hang up/.test(msg)) return true;
  if (/overloaded|temporarily unavailable/.test(msg)) return true;
  return false;
}

function backoffDelay(attempt) {
  const exp = RETRY_BASE_DELAY_MS * Math.pow(RETRY_BACKOFF_FACTOR, attempt);
  const jitter = Math.random() * RETRY_JITTER_MS;
  return Math.round(exp + jitter);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Invoke a Claude agent with structured output.
 * Returns the structured output or null if no result.
 *
 * Pass `label` to enable compact activity logging (agent start + completion).
 *
 * Transient errors (429, 5xx, network) are retried with exponential backoff
 * up to MAX_RETRY_ATTEMPTS total attempts. Terminal errors throw immediately.
 */
async function invokeAgent({ prompt, schema, model = DEFAULT_MODEL, maxTurns = 10, tools = [], cwd, label: agentLabel }) {
  const start = Date.now();

  if (agentLabel) {
    console.log(`${indent.L2}◆ ${agentLabel} ${chalk.dim(`[${model}]`)}`);
  }

  let result = null;
  let lastError = null;

  for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
    try {
      result = null; // reset between attempts; previous partial state is unsafe
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

      for await (const event of conversation) {
        if (event.type === 'result' && event.subtype === 'success') {
          result = event.structured_output || JSON.parse(event.result);
        }
      }

      // Success path — break out of retry loop.
      lastError = null;
      break;
    } catch (err) {
      lastError = err;
      const isLastAttempt = attempt === MAX_RETRY_ATTEMPTS - 1;
      if (!isRetryable(err) || isLastAttempt) {
        throw err;
      }
      const delay = backoffDelay(attempt);
      console.log(`${indent.L3}${chalk.yellow(`⟲ retry ${attempt + 1}/${MAX_RETRY_ATTEMPTS - 1} after ${delay}ms`)} ${chalk.dim(err.message || String(err))}`);
      await sleep(delay);
    }
  }

  if (agentLabel) {
    const elapsed = Math.round((Date.now() - start) / 1000);
    console.log(`${indent.L3}${chalk.dim(`${elapsed}s`)}`);
  }

  return result;
}

module.exports = { invokeAgent, DEFAULT_MODEL, isRetryable };
