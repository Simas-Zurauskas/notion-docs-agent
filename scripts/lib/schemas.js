function assessSchema(actionTypes = ['rewrite', 'create']) {
  return {
    type: 'object',
    properties: {
      meaningful: { type: 'boolean' },
      reasoning: { type: 'string' },
      actions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: actionTypes },
            page_id: { type: 'string' },
            parent_id: { type: 'string' },
            page_title: { type: 'string' },
            instructions: { type: 'string' },
          },
          required: ['type', 'instructions'],
        },
      },
    },
    required: ['meaningful', 'reasoning', 'actions'],
  };
}

const GENERATE_SCHEMA = {
  type: 'object',
  properties: {
    page_title: { type: 'string' },
    markdown: { type: 'string' },
    summary: { type: 'string' },
    skipped: { type: 'boolean' },
    skip_reason: { type: 'string' },
  },
  required: ['page_title', 'markdown', 'summary', 'skipped'],
};

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    state: {
      type: 'string',
      enum: ['bootstrap', 'growth', 'maintenance'],
    },
    reasoning: { type: 'string' },
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          action: { type: 'string', enum: ['rewrite', 'create', 'delete', 'rename', 'split'] },
          page_id: { type: 'string' },
          parent_id: { type: 'string' },
          title: { type: 'string' },
          section: { type: 'string' },
          current_doc_file: { type: 'string' },
          instructions: { type: 'string' },
          priority: { type: 'integer', minimum: 1, maximum: 3 },
          depends_on: { type: 'array', items: { type: 'string' } },
        },
        required: ['id', 'action', 'section', 'instructions', 'priority'],
      },
    },
  },
  required: ['state', 'reasoning', 'tasks'],
};

const WORKER_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    task_id: { type: 'string' },
    action: { type: 'string' },
    markdown: { type: 'string' },
    page_id: { type: 'string' },
    parent_id: { type: 'string' },
    title: { type: 'string' },
    summary: { type: 'string' },
    skipped: { type: 'boolean' },
    skip_reason: { type: 'string' },
  },
  required: ['task_id', 'action', 'markdown', 'summary', 'skipped'],
};

module.exports = { assessSchema, GENERATE_SCHEMA, PLAN_SCHEMA, WORKER_OUTPUT_SCHEMA };
