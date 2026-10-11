/**
 * Checks the arguments a model supplied for a tool against that tool's own JSON-schema declaration before the handler runs, so a
 * malformed call (missing field, wrong type, out-of-range number, value outside an enum) becomes a clear error the MODEL can correct
 * instead of reaching business code. Supports the subset the project's tool schemas use: type, required, properties, items, enum,
 * minimum/maximum, minLength/maxLength. Unknown extra properties are ignored (never trusted, simply not read).
 */
type Schema = {
  type?: string | string[];
  required?: string[];
  properties?: Record<string, Schema>;
  items?: Schema;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
};

const typeOf = (value: unknown): string => (value === null ? 'null' : Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value);

function matchesType(expected: string, value: unknown): boolean {
  const actual = typeOf(value);
  if (expected === 'number') return actual === 'integer' || actual === 'number';
  return expected === actual;
}

export function validateToolArguments(schema: Schema | undefined, value: unknown, path = 'arguments'): string[] {
  if (!schema) return [];
  const errors: string[] = [];
  if (schema.type) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!allowed.some((t) => matchesType(t, value))) return [`${path} must be ${allowed.join(' or ')}`];
  }
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path} must be one of: ${schema.enum.join(', ')}`);
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path} must be at least ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path} must be at most ${schema.maximum}`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path} is too short`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path} is too long`);
  }
  if (Array.isArray(value) && schema.items) value.forEach((item, i) => errors.push(...validateToolArguments(schema.items, item, `${path}[${i}]`)));
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const name of schema.required ?? []) if (record[name] === undefined || record[name] === null) errors.push(`${path}.${name} is required`);
    for (const [name, sub] of Object.entries(schema.properties ?? {})) if (record[name] !== undefined && record[name] !== null) errors.push(...validateToolArguments(sub, record[name], `${path}.${name}`));
  }
  return errors;
}

/** A stable text form of the arguments, so two identical calls compare equal whatever the key order. */
export function canonicalArguments(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalArguments).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((k) => `${JSON.stringify(k)}:${canonicalArguments(record[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
