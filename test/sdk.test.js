import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defineTool } from '../lib/sdk.js';

function tool(parameters) {
  return defineTool({
    name: 'probe',
    description: 'test tool',
    parameters,
    output: { schema: {}, render: () => [{ type: 'text', text: 'ok' }] },
    async execute(args) {
      return args;
    },
  });
}

test('defineTool compiles the parameter spec into JSON Schema', () => {
  const compiled = tool({
    root: { type: 'string', description: 'install root', required: true },
    dryRun: { type: 'boolean', description: 'rehearse' },
  });
  assert.equal(compiled.parameters.type, 'object');
  assert.deepEqual(compiled.parameters.required, ['root']);
  assert.deepEqual(compiled.parameters.properties.root, { description: 'install root', type: 'string' });
});

test('defineTool accepts valid arguments and forwards them', async () => {
  const compiled = tool({ root: { type: 'string', required: true } });
  const result = await compiled.execute({ root: 'C:\\dsh' }, {});
  assert.deepEqual(result, { root: 'C:\\dsh' });
});

test('defineTool rejects a missing required argument', async () => {
  const compiled = tool({ root: { type: 'string', required: true } });
  await assert.rejects(() => compiled.execute({}, {}), /root is required/u);
});

test('defineTool rejects a wrongly typed argument', async () => {
  const compiled = tool({ root: { type: 'string', required: true } });
  await assert.rejects(() => compiled.execute({ root: 42 }, {}), /must be string/u);
});

test('defineTool honours enum constraints', async () => {
  const compiled = tool({ channel: { type: 'string', enum: ['newest', 'latest'], required: true } });
  await assert.rejects(() => compiled.execute({ channel: 'beta' }, {}), /must be one of/u);
});

test('defineTool validates nested object properties', async () => {
  const compiled = tool({
    options: {
      type: 'object',
      required: true,
      properties: { port: { type: 'number', required: true } },
    },
  });
  await assert.rejects(() => compiled.execute({ options: { port: 'x' } }, {}), /options\.port must be number/u);
});

test('defineTool rejects undeclared properties when additionalProperties is false', async () => {
  const compiled = tool({
    options: { type: 'object', additionalProperties: false, properties: { port: { type: 'number' } } },
  });
  await assert.rejects(() => compiled.execute({ options: { extra: 1 } }, {}), /not a declared property/u);
});

test('defineTool validates array items', async () => {
  const compiled = tool({ roots: { type: 'array', items: { type: 'string' } } });
  await assert.rejects(() => compiled.execute({ roots: ['a', 2] }, {}), /roots\[1\] must be string/u);
});

test('an argument-free tool accepts an empty call', async () => {
  const compiled = tool({});
  assert.deepEqual(await compiled.execute({}, {}), {});
});
