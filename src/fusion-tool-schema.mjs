import Ajv from 'ajv';
import Ajv2019 from 'ajv/dist/2019.js';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const annotations = ['description', 'title', 'default', 'examples'];
const scalar = new Set(['string', 'number', 'integer', 'boolean', 'null']);
const typeOf = value => value === null ? 'null' : typeof value;
const options = {
  strictSchema: true, strictTypes: false, strictTuples: false, strictRequired: false,
  allowUnionTypes: true, allowMatchingProperties: true, allErrors: true, ownProperties: true,
  coerceTypes: false, useDefaults: false, removeAdditional: false,
};

/** Native PTC schemas are a smaller language than Cortico's JSON Schema.
 * The projection accepts source-valid values in native DSH's lossless JSON
 * domain; the original schema
 * remains authoritative at execution. Constraints outside the native subset
 * are visible as annotations, never silently discarded or coerced.
 */
export function createFusionToolSchemaCompiler(assertSupportedJsonSchema) {
  const validators = new Map();
  function validator(dialect) {
    const key = dialect ?? 'http://json-schema.org/draft-07/schema#';
    if (!validators.has(key)) {
      let Constructor;
      if (/^https?:\/\/json-schema.org\/draft-07\/schema#?$/.test(key)) Constructor = Ajv;
      else if (/^https?:\/\/json-schema.org\/draft\/2019-09\/schema#?$/.test(key)) Constructor = Ajv2019;
      else if (/^https?:\/\/json-schema.org\/draft\/2020-12\/schema#?$/.test(key)) Constructor = Ajv2020;
      else throw new Error('Unsupported World JSON Schema dialect: ' + key);
      const instance = new Constructor({ ...options, addUsedSchema: false });
      addFormats(instance);
      validators.set(key, instance);
    }
    return validators.get(key);
  }
  function project(node) {
    try { assertSupportedJsonSchema(node); return structuredClone(node); } catch {}
    if (typeof node === 'boolean') return { description: 'Host JSON Schema: ' + node };
    if (node.nullable === true) {
      // Ajv supports OpenAPI nullable. Retaining a single native type would
      // reject null before the original validator can evaluate enum/oneOf.
      return { description: [node.description, 'Nullable JSON Schema enforced by the host: ' + JSON.stringify(node)].filter(Boolean).join('\n') };
    }
    const result = {};
    for (const key of annotations) if (Object.hasOwn(node, key)) result[key] = structuredClone(node[key]);
    const omitted = {};
    let type = typeof node.type === 'string' ? node.type : undefined;
    // An enum without type is valid JSON Schema. Infer only homogeneous scalar
    // values; a mixed or structured enum stays with the authoritative validator.
    if (!type && !node.type && !node.oneOf && !node.anyOf && !node.allOf) {
      const values = node.enum ?? (Object.hasOwn(node, 'const') ? [node.const] : []);
      if (values.length && values.every(v => scalar.has(typeOf(v)) && typeOf(v) === typeOf(values[0]))) type = typeOf(values[0]);
    }
    if (type) result.type = type;
    for (const [key, value] of Object.entries(node)) {
      if (annotations.includes(key)) continue;
      if (key === 'type' && type) continue;
      if (key === 'properties' && type === 'object') {
        result.properties = Object.fromEntries(Object.entries(value).map(([name, schema]) => [name, project(schema)]));
      } else if (key === 'required' && type === 'object') {
        result.required = [...value];
      } else if (key === 'additionalProperties' && type === 'object' && typeof value === 'boolean' && !node.patternProperties) {
        result.additionalProperties = value;
      } else if (key === 'items' && type === 'array' && !Array.isArray(value) && !node.prefixItems) {
        result.items = project(value);
      } else if ((key === 'enum' || key === 'const') && scalar.has(type)) {
        const values = key === 'enum' ? value : [value];
        const matches = values.every(v => type === 'integer' ? Number.isInteger(v) : typeOf(v) === type);
        if (matches) result[key] = structuredClone(value); else omitted[key] = value;
      } else {
        omitted[key] = value;
      }
    }
    if (result.required) {
      result.properties ??= {};
      for (const key of result.required) if (!Object.hasOwn(result.properties, key)) {
        Object.defineProperty(result.properties, key, { value: {}, enumerable: true, configurable: true, writable: true });
      }
    }
    if (Object.keys(omitted).length) {
      result.description = [result.description, 'Additional JSON Schema enforced by the host: ' + JSON.stringify(omitted)].filter(Boolean).join('\n');
    }
    assertSupportedJsonSchema(result);
    return result;
  }
  return function compile(parameters) {
    const original = structuredClone(parameters);
    if (!original || original.type !== 'object' || original.nullable === true) throw new Error('World tool arguments must use a non-nullable object schema.');
    assertSchemaMaps(original);
    // Compile synchronously: unresolved references and unsupported assertions
    // fail mounting. No remote schema fetch and no argument mutation occurs.
    const compiler = validator(original.$schema);
    let validate;
    try { validate = compiler.compile(original); }
    // A package can declare nested $id values. Remove all non-meta cache/ref
    // entries so a later package cannot inherit those definitions by accident.
    finally { compiler.removeSchema(); }
    if (validate.$async) throw new Error('Asynchronous World JSON Schema validation is unsupported.');
    const projected = project(original);
    return {
      parameters: projected,
      original,
      validate(args) {
        if (validate(args)) return [];
        return (validate.errors ?? []).map(error => ({ path: error.instancePath, keyword: error.keyword, message: error.message }));
      },
    };
  };
}

// Ajv deliberately skips __proto__ entries in schema maps. Refuse such a
// declaration rather than advertising an assertion the validator won't run.
// Walk schema positions only: defaults, enum/const and examples are JSON data.
function assertSchemaMaps(schema) {
  if (!schema || typeof schema !== 'object') return;
  for (const key of ['properties', 'patternProperties', 'dependencies', 'dependentRequired', 'dependentSchemas', '$defs', 'definitions']) {
    const map = schema[key];
    if (!map || typeof map !== 'object' || Array.isArray(map)) continue;
    if (Object.hasOwn(map, '__proto__')) throw new Error('Unsupported World JSON Schema map key: ' + key + '.__proto__');
    if (key !== 'dependentRequired') for (const child of Object.values(map)) if (!Array.isArray(child)) assertSchemaMaps(child);
  }
  for (const key of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) if (Array.isArray(schema[key])) schema[key].forEach(assertSchemaMaps);
  for (const key of ['not', 'if', 'then', 'else', 'contains', 'additionalProperties', 'additionalItems', 'unevaluatedProperties', 'unevaluatedItems', 'propertyNames', 'contentSchema']) assertSchemaMaps(schema[key]);
  if (Array.isArray(schema.items)) schema.items.forEach(assertSchemaMaps); else assertSchemaMaps(schema.items);
}
