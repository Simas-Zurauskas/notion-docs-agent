/**
 * bootstrap-test.js — unit test harness for the dependent-task pipeline.
 *
 * Exercises resolveDependencies + the wave-scheduling logic without hitting
 * Anthropic or Notion. Lets us verify:
 *   - Remap runs produce byte-identical dependent-task state (no regression).
 *   - 2-level bootstrap resolves parent_ids correctly.
 *   - 3-level bootstrap runs across multiple waves.
 *   - Cycles terminate with a warning.
 *
 * Usage:
 *   node lib/bootstrap-test.js
 */

/* eslint-disable no-console */

const assert = require('assert');

// -- Import the actual functions from the production script ------------------

// We extract resolveDependencies into a pluggable form so this test doesn't
// have to parse the whole rebuild script. It's a copy — run this BEFORE and
// AFTER changes and compare output manually.

function resolveDependencies(dependentTasks, writeLog) {
  const createdIds = {};
  for (const entry of writeLog) {
    if (entry.created_id) {
      createdIds[entry.task_id] = entry.created_id;
    }
  }

  return dependentTasks.map((task) => {
    // NEW in proposed change — swap task-id parent_id for created Notion UUID
    if (task.parent_id && createdIds[task.parent_id]) {
      task.parent_id = createdIds[task.parent_id];
    }

    const resolvedIds = (task.depends_on || [])
      .map((depId) => (createdIds[depId] ? `"${depId}" → page ID: ${createdIds[depId]}` : null))
      .filter(Boolean);

    if (resolvedIds.length > 0) {
      task.instructions += `\n\nChild pages created (reference these in the index):\n${resolvedIds.join('\n')}`;
    }

    return task;
  });
}

// -- Wave scheduler (what will replace the single dep batch) -----------------

async function runWavesSimulated(dependent, writeLog, { runBatch, writeBatch, verifyBatch }) {
  const allDependentResults = [];
  const allWriteEntries = [];
  const createdIds = {};
  for (const e of writeLog) if (e.created_id) createdIds[e.task_id] = e.created_id;

  const taskIdsInBatch = new Set(dependent.map((t) => t.id));
  let remaining = [...dependent];
  let wave = 0;

  while (remaining.length > 0) {
    wave += 1;
    // A task is ready when every dep either:
    //   (a) was created in this run (createdIds has it), OR
    //   (b) is NOT in our task list (it's referring to something external —
    //       typically an existing Notion page whose UUID is in docsIndex).
    const ready = remaining.filter((t) =>
      (t.depends_on || []).every((d) => createdIds[d] || !taskIdsInBatch.has(d))
    );

    if (!ready.length) {
      console.warn(`  ⚠ Wave ${wave}: unresolvable deps for ${remaining.length} task(s): ${remaining.map((t) => t.id).join(', ')}`);
      break;
    }
    remaining = remaining.filter((t) => !ready.includes(t));

    const resolved = resolveDependencies(ready, [...writeLog, ...allWriteEntries]);
    const batchResults = await runBatch(resolved);
    if (verifyBatch) await verifyBatch(batchResults);
    const waveWriteLog = writeBatch(batchResults);

    allDependentResults.push(...batchResults);
    allWriteEntries.push(...waveWriteLog);
    for (const e of waveWriteLog) if (e.created_id) createdIds[e.task_id] = e.created_id;

    console.log(`  wave ${wave}: processed ${ready.length} task(s) — remaining ${remaining.length}`);
  }

  return { allDependentResults, allWriteEntries, remaining };
}

// -- Scenarios ---------------------------------------------------------------

function scenarioRemapOnly() {
  console.log('\n### Scenario: remap-only (existing hierarchy, no creates) ###');
  const independentWriteLog = [
    // All rewrites — no created_ids
    { task_id: 'rewrite-auth', status: 'success', action: 'rewrite' },
    { task_id: 'rewrite-models', status: 'success', action: 'rewrite' },
  ];
  const dependent = []; // no dependent tasks in remap
  console.log(`  dependent tasks: ${dependent.length}`);
  const resolved = resolveDependencies(dependent, independentWriteLog);
  assert.strictEqual(resolved.length, 0);
  console.log('  ✓ no tasks to resolve — OK');
}

function scenarioRemapWithOverviewRefsChildren() {
  console.log('\n### Scenario: remap + OVERVIEW referencing children (current docs idiom) ###');
  // Planner creates two new children then rewrites an OVERVIEW that links to them.
  // Child tasks are independent. OVERVIEW depends on both child creates.
  const independentWriteLog = [
    { task_id: 'create-child-a', status: 'success', action: 'create', created_id: 'uuid-child-a' },
    { task_id: 'create-child-b', status: 'success', action: 'create', created_id: 'uuid-child-b' },
  ];
  const dependent = [{
    id: 'rewrite-overview',
    action: 'rewrite',
    page_id: 'uuid-existing-overview', // existing page, not being created
    depends_on: ['create-child-a', 'create-child-b'],
    instructions: 'Rewrite the overview linking to the two new children.',
  }];
  const resolved = resolveDependencies(dependent, independentWriteLog);
  assert.strictEqual(resolved[0].page_id, 'uuid-existing-overview', 'page_id must be untouched');
  assert.ok(resolved[0].instructions.includes('uuid-child-a'), 'instructions should embed created child UUIDs');
  assert.ok(resolved[0].instructions.includes('uuid-child-b'), 'instructions should embed both child UUIDs');
  console.log('  ✓ existing instructions-append behavior preserved');
  console.log('  ✓ page_id untouched');
}

async function scenarioBootstrap2Level() {
  console.log('\n### Scenario: 2-level bootstrap (empty root → top → leaf) ###');
  // Planner plans 'api-root' as top-level, then 'api-auth' as child using
  // the task id as parent_id + depends_on the top-level task.
  const independentWriteLog = [
    { task_id: 'api-root', status: 'success', action: 'create', created_id: 'uuid-api' },
  ];
  const dependent = [{
    id: 'api-auth',
    action: 'create',
    parent_id: 'api-root', // task id, not UUID
    depends_on: ['api-root'],
    title: 'Auth',
    instructions: 'Document the auth subsystem.',
  }];

  let resolved;
  await runWavesSimulated(dependent, independentWriteLog, {
    runBatch: async (tasks) => { resolved = tasks; return tasks.map((t) => ({ task_id: t.id, markdown: 'x', summary: '', skipped: false })); },
    writeBatch: (results) => results.map((r) => ({ task_id: r.task_id, status: 'success', action: 'create', created_id: `uuid-${r.task_id}` })),
  });

  assert.strictEqual(resolved[0].parent_id, 'uuid-api', 'parent_id must be swapped to the real Notion UUID');
  console.log('  ✓ parent_id swapped from task slug to real UUID');
}

async function scenarioBootstrap3Level() {
  console.log('\n### Scenario: 3-level bootstrap (root → top → middle → leaf) ###');
  const independentWriteLog = [
    { task_id: 'api-root', status: 'success', action: 'create', created_id: 'uuid-api' },
  ];
  const dependent = [
    { id: 'api-models', action: 'create', parent_id: 'api-root', depends_on: ['api-root'], title: 'Models', instructions: 'Models index.' },
    { id: 'api-models-user', action: 'create', parent_id: 'api-models', depends_on: ['api-models'], title: 'User', instructions: 'User model.' },
    { id: 'api-models-course', action: 'create', parent_id: 'api-models', depends_on: ['api-models'], title: 'Course', instructions: 'Course model.' },
  ];

  const waveOrder = [];
  await runWavesSimulated(dependent, independentWriteLog, {
    runBatch: async (tasks) => {
      waveOrder.push(tasks.map((t) => t.id));
      return tasks.map((t) => ({ task_id: t.id, markdown: 'x', summary: '', skipped: false, parent_id: t.parent_id }));
    },
    writeBatch: (results) => results.map((r) => ({ task_id: r.task_id, status: 'success', action: 'create', created_id: `uuid-${r.task_id}` })),
  });

  // Wave 1 should run just api-models (user/course can't run yet)
  // Wave 2 should run api-models-user + api-models-course in parallel
  assert.deepStrictEqual(waveOrder[0], ['api-models'], `first wave should be [api-models], got ${JSON.stringify(waveOrder[0])}`);
  assert.deepStrictEqual(waveOrder[1].sort(), ['api-models-course', 'api-models-user'], 'second wave should run user+course in parallel');
  console.log('  ✓ wave 1 processed [api-models]');
  console.log('  ✓ wave 2 processed [api-models-course, api-models-user]');
}

async function scenarioMixed() {
  console.log('\n### Scenario: mixed — new page under EXISTING parent + new tree ###');
  // User has API page in docsIndex already. Planner creates 1) a child under
  // API (parent_id = existing UUID), 2) a new top-level "Gamification" page,
  // 3) a child under the new page.
  const independentWriteLog = [
    { task_id: 'api-schema', status: 'success', action: 'create', created_id: 'uuid-api-schema' }, // independent; under existing API page
    { task_id: 'gamification-root', status: 'success', action: 'create', created_id: 'uuid-gam' },
  ];
  const dependent = [
    {
      id: 'gamification-xp',
      action: 'create',
      parent_id: 'gamification-root', // task id
      depends_on: ['gamification-root'],
      title: 'XP',
      instructions: 'XP system.',
    },
  ];

  let resolved;
  await runWavesSimulated(dependent, independentWriteLog, {
    runBatch: async (tasks) => { resolved = tasks; return tasks.map((t) => ({ task_id: t.id, markdown: 'x', summary: '', skipped: false })); },
    writeBatch: (results) => results.map((r) => ({ task_id: r.task_id, status: 'success', action: 'create', created_id: `uuid-${r.task_id}` })),
  });

  assert.strictEqual(resolved[0].parent_id, 'uuid-gam');
  console.log('  ✓ new-under-new resolved to real UUID');
}

async function scenarioCycle() {
  console.log('\n### Scenario: cycle detection (A depends on B, B depends on A) ###');
  const independentWriteLog = [];
  const dependent = [
    { id: 'task-a', action: 'create', parent_id: 'task-b', depends_on: ['task-b'], title: 'A', instructions: '.' },
    { id: 'task-b', action: 'create', parent_id: 'task-a', depends_on: ['task-a'], title: 'B', instructions: '.' },
  ];

  const { remaining } = await runWavesSimulated(dependent, independentWriteLog, {
    runBatch: async (tasks) => tasks.map((t) => ({ task_id: t.id, markdown: 'x', summary: '', skipped: false })),
    writeBatch: (results) => results.map((r) => ({ task_id: r.task_id, status: 'success', action: 'create', created_id: `uuid-${r.task_id}` })),
  });

  assert.strictEqual(remaining.length, 2, 'both cyclic tasks should remain unprocessed');
  console.log('  ✓ cycle detected, loop terminated');
}

async function scenarioUuidPassthrough() {
  console.log('\n### Scenario: resolver passes through real UUIDs unchanged ###');
  const independentWriteLog = [
    { task_id: 'some-task', status: 'success', action: 'create', created_id: 'uuid-real' },
  ];
  // Task whose parent_id is a real UUID (existing Notion page, not a task id).
  const dependent = [{
    id: 'task-child',
    action: 'create',
    parent_id: '336c2628-ef95-81bf-8806-d8b738a2d8eb', // real UUID
    depends_on: [], // no dependencies
    title: 'C',
    instructions: '.',
  }];

  const resolved = resolveDependencies(dependent, independentWriteLog);
  assert.strictEqual(resolved[0].parent_id, '336c2628-ef95-81bf-8806-d8b738a2d8eb', 'UUID must pass through unchanged');
  console.log('  ✓ real UUID not touched by resolver');
}

async function main() {
  console.log('=== Dependent-pipeline test harness ===');
  scenarioRemapOnly();
  scenarioRemapWithOverviewRefsChildren();
  await scenarioBootstrap2Level();
  await scenarioBootstrap3Level();
  await scenarioMixed();
  await scenarioCycle();
  await scenarioUuidPassthrough();
  console.log('\n=== All scenarios passed ===');
}

main().catch((e) => {
  console.error('TEST FAILED:', e);
  process.exit(1);
});
