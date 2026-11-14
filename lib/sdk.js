/**
 * Self-contained replacements for the `@deepseek-ai/*` runtime imports a
 * published plugin must NOT take from the profile's node_modules.
 *
 * Resolving `@deepseek-ai/dsh-tools` from a profile installs a second copy of
 * the base layer: it shadows the CLI-internal build for the whole layer and
 * the agent loop's private scheduler symbol then goes missing
 * (`Cannot read properties of undefined (reading 'prepare')` on every tool
 * call). Everything below is a small, dependency-free reimplementation of the
 * parts of that SDK this plugin actually uses.
 *
 * @module dsh-upgrade/sdk
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Resolve a path under the DSH home directory, honouring `DSH_HOME`.
 * @param {...string} segments - path segments appended to the home root.
 * @returns {string} an absolute path.
 */
export function dshHomePath(...segments) {
  const override = process.env.DSH_HOME;
  const base = resolve(
    override !== undefined && override.length > 0 ? override : join(homedir(), '.dsh'),
  );
  return join(base, ...segments);
}

/** Compile one author-facing value spec into the raw JSON-Schema subset. */
function compileValue(spec) {
  const node = {};
  if (typeof spec.description === 'string' && spec.description.length > 0) {
    node.description = spec.description;
  }
  const type = spec.type;
  if (type === undefined || type === 'json') return node;
  if (type === 'object') {
    node.type = 'object';
    if (spec.additionalProperties !== undefined) node.additionalProperties = spec.additionalProperties;
    if (spec.properties !== undefined) node.properties = compilePropertyMap(spec.properties).properties;
    return node;
  }
  if (type === 'array') {
    node.type = 'array';
    if (spec.items !== undefined) node.items = compileValue(spec.items);
    return node;
  }
  node.type = type;
  if (spec.enum !== undefined) node.enum = [...spec.enum];
  if (spec.const !== undefined) node.const = spec.const;
  return node;
}

/** Compile a property map, collecting the `required` name list. */
function compilePropertyMap(spec) {
  const properties = {};
  const required = [];
  for (const [key, entry] of Object.entries(spec)) {
    const { required: isRequired, ...valueSpec } = entry;
    properties[key] = compileValue(valueSpec);
    if (isRequired === true) required.push(key);
  }
  return required.length > 0 ? { properties, required } : { properties };
}

/** Does a JS value match a raw-subset scalar type? */
function matchesScalarType(value, type) {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number';
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    default: return true;
  }
}

/** Validate a value against the compiled subset; returns path-qualified violations. */
function validateValue(schema, value, path) {
  if (typeof schema.type !== 'string' || schema.type.length === 0) return [];
  if (schema.type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return [`${path} must be an object`];
    }
    const violations = [];
    for (const key of schema.required ?? []) {
      if (!(key in value)) violations.push(`${path}.${key} is required`);
    }
    if (schema.additionalProperties === false) {
      const known = new Set(Object.keys(schema.properties ?? {}));
      for (const key of Object.keys(value)) {
        if (!known.has(key)) violations.push(`${path}.${key} is not a declared property`);
      }
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (key in value) violations.push(...validateValue(child, value[key], `${path}.${key}`));
    }
    return violations;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return [`${path} must be an array`];
    const violations = [];
    if (schema.items !== undefined) {
      value.forEach((item, index) => {
        violations.push(...validateValue(schema.items, item, `${path}[${index}]`));
      });
    }
    return violations;
  }
  if (!matchesScalarType(value, schema.type)) return [`${path} must be ${schema.type}`];
  if (schema.enum !== undefined && !schema.enum.some((v) => v === value)) {
    return [`${path} must be one of ${schema.enum.map(String).join(', ')}`];
  }
  if (schema.const !== undefined && schema.const !== value) {
    return [`${path} must be ${String(schema.const)}`];
  }
  return [];
}

/**
 * Define a first-party tool: compile the parameter spec, pre-validate the
 * arguments, and pass the call through to the implementation.
 * @param {object} options - tool definition (name/description/parameters/output/execute).
 * @returns {object} a registry-ready tool definition.
 */
export function defineTool(options) {
  const compiled = compilePropertyMap(options.parameters ?? {});
  const parameters = { type: 'object', properties: compiled.properties };
  if (compiled.required !== undefined) parameters.required = compiled.required;
  const userExecute = options.execute;
  return {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: {},
      render(args, value) {
        return options.output.render(args, value);
      },
    },
    async execute(args, exec) {
      const violations = validateValue(parameters, args, 'arguments');
      if (violations.length > 0) {
        throw new Error(`Error: invalid arguments: ${violations.join('; ')}`);
      }
      return userExecute(args ?? {}, exec);
    },
  };
}
