/**
 * Load the plugin against a stand-in context and report what it registered.
 *
 * This is the closest check to "does it activate" that runs without DSH: a
 * real DSH would inject `tools` and `commands` services, so the fake context
 * records the registrations instead and asserts their shape.
 *
 * Usage: node scripts/verify-activation.mjs
 */
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const pluginPath = join(import.meta.dirname, '..', 'index.js');
const module_ = await import(pathToFileURL(pluginPath).href);

/** Registered tools, by name. */
const tools = new Map();
/** Registered commands, by name. */
const commands = new Map();
/** Effects registered by the plugin. */
const effects = [];

const ctx = {
  tools: {
    register(definition) {
      if (tools.has(definition.name)) {
        throw new Error(`duplicate tool registration: ${definition.name}`);
      }
      tools.set(definition.name, definition);
      return () => tools.delete(definition.name);
    },
  },
  get(service) {
    if (service === 'commands') {
      return {
        register(definition) {
          commands.set(definition.name, definition);
          return () => commands.delete(definition.name);
        },
      };
    }
    return undefined;
  },
  effect(fn, label) {
    const dispose = fn();
    effects.push({ label, dispose });
    return dispose;
  },
};

const problems = [];

if (typeof module_.name !== 'string' || module_.name !== 'dsh-upgrade') {
  problems.push(`module name must be "dsh-upgrade", got ${JSON.stringify(module_.name)}`);
}
if (!Array.isArray(module_.inject) || !module_.inject.includes('tools')) {
  problems.push('module must export inject = ["tools"]');
}
if (typeof module_.apply !== 'function') {
  problems.push('module must export apply(ctx, config)');
}

if (problems.length === 0) {
  const config = {
    channel: 'newest',
    registry: 'https://registry.npmmirror.com',
    autoRestart: false,
    restartDelaySeconds: 6,
  };
  await module_.apply(ctx, config);
}

const expectedTools = [
  'dsh_upgrade_status',
  'dsh_upgrade_apply',
  'dsh_upgrade_verify',
  'dsh_upgrade_restart',
  'dsh_upgrade_status_all',
];

for (const name of expectedTools) {
  const definition = tools.get(name);
  if (definition === undefined) {
    problems.push(`tool not registered: ${name}`);
    continue;
  }
  if (typeof definition.description !== 'string' || definition.description.length < 20) {
    problems.push(`${name}: description is too short to be useful to a model`);
  }
  if (definition.parameters?.type !== 'object') {
    problems.push(`${name}: parameters must compile to a JSON Schema object`);
  }
  if (typeof definition.execute !== 'function') {
    problems.push(`${name}: execute is missing`);
  }
  if (typeof definition.output?.render !== 'function') {
    problems.push(`${name}: output.render is missing`);
  }
}

if (!commands.has('upgrade')) problems.push('slash command /upgrade was not registered');

console.log(`module: ${module_.name} (inject: ${JSON.stringify(module_.inject)})`);
console.log(`tools registered: ${tools.size}`);
for (const [name, definition] of tools) {
  const required = definition.parameters?.required ?? [];
  console.log(`  ${name}: params=[${Object.keys(definition.parameters?.properties ?? {}).join(', ')}] required=[${required.join(', ')}]`);
}
console.log(`commands registered: ${[...commands.keys()].join(', ') || '(none)'}`);
console.log(`effects registered: ${effects.length}`);

if (problems.length > 0) {
  console.error('\nFAILED:');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exitCode = 1;
} else {
  console.log('\nOK: the plugin registers every tool and command it declares.');
}
