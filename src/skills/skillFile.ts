import { TOOL_NAMES } from '../config/constants';

/**
 * A skill is a reviewed MARKDOWN file in the repository: `skills/<id>/SKILL.md`, a small header between `---` lines and then the instructions the assistant follows
 * while the skill is active. It is DATA, never code: nothing in it is executed, imported or evaluated, and it can only ask for tools from the short list below.
 *
 *   ---
 *   name: Order status
 *   description: Answers "where is my order" questions from the business's own records.
 *   triggers: where is my order, order status, track my order
 *   tools: search_catalogues, request_human_handoff
 *   default_enabled: false
 *   ---
 *   (instructions, plain Markdown, up to MAX_INSTRUCTION_CHARS)
 */
export const MAX_SKILL_FILE_BYTES = 32 * 1024;
export const MAX_INSTRUCTION_CHARS = 8000;
export const SKILL_ID = /^[a-z0-9][a-z0-9-]{1,47}$/;

/**
 * The only tools a skill can be given. Read-only lookups and the hand-over to a person. Tools that change something or reach a customer on their own
 * (book_appointment, save_real_estate_lead, send_project_brochure) are deliberately NOT grantable: letting an instruction file trigger an externally consequential
 * action needs an explicit customer-confirmation step that does not exist yet. A tool listed here is still only available when the business is offered it.
 */
export const SKILL_GRANTABLE_TOOLS: readonly string[] = [TOOL_NAMES.SEARCH_CATALOGUES, TOOL_NAMES.WEB_SEARCH, TOOL_NAMES.CHECK_AVAILABILITY, TOOL_NAMES.SEARCH_REAL_ESTATE_PROJECTS, TOOL_NAMES.REQUEST_HUMAN_HANDOFF];

export const SKILL_FEATURES = ['catalogues', 'real_estate'] as const;

export interface SkillDefinition {
  /** The directory name: stable, never derived from the display name. */
  id: string;
  name: string;
  description: string;
  version: string | null;
  /** Phrases that may select the skill automatically (empty = only an explicit /id request selects it). */
  triggers: string[];
  /** Tool names the skill may use (a subset of SKILL_GRANTABLE_TOOLS). */
  tools: string[];
  /** The business add-on this skill needs (a business without it never sees the skill as available). */
  requiresFeature: (typeof SKILL_FEATURES)[number] | null;
  /** Used when a business has not made a choice. */
  defaultEnabled: boolean;
  instructions: string;
}

export type ParsedSkill = { ok: true; skill: SkillDefinition; warnings: string[] } | { ok: false; problems: string[] };

const KNOWN_KEYS = new Set(['name', 'description', 'version', 'triggers', 'tools', 'default_enabled', 'requires_feature']);
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function unquote(v: string): string {
  const s = v.trim();
  return s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) ? s.slice(1, -1) : s;
}
function listOf(v: string): string[] {
  const s = v.trim().replace(/^\[/, '').replace(/\]$/, '');
  return s.split(',').map((x) => unquote(x)).filter(Boolean);
}

/** Splits the header from the body and reads `key: value` lines (a list is a comma-separated value or `- item` lines). Unknown keys are reported, not trusted. */
function readHeader(header: string, warnings: string[], problems: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let current: string | null = null;
  for (const raw of header.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && current) { out.get(current)!.push(unquote(item[1]!)); continue; }
    const kv = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) { problems.push(`header line is not "key: value": ${line.slice(0, 60)}`); current = null; continue; }
    const key = kv[1]!.toLowerCase();
    if (!KNOWN_KEYS.has(key)) { warnings.push(`unknown header key "${key}" ignored`); current = null; continue; }
    if (out.has(key)) { problems.push(`header key "${key}" appears twice`); current = null; continue; }
    out.set(key, kv[2]!.trim() === '' ? [] : key === 'triggers' || key === 'tools' ? listOf(kv[2]!) : [unquote(kv[2]!)]);
    current = key;
  }
  return out;
}

/** Validates one skill file. `id` is the name of its directory. Never throws. */
export function parseSkillFile(id: string, text: string): ParsedSkill {
  const problems: string[] = [];
  const warnings: string[] = [];
  if (!SKILL_ID.test(id)) return { ok: false, problems: [`"${id}" is not a valid skill id (lower-case letters, digits and hyphens, 2-48 characters, starting with a letter or digit)`] };
  if (Buffer.byteLength(text, 'utf8') > MAX_SKILL_FILE_BYTES) return { ok: false, problems: [`the file is larger than ${MAX_SKILL_FILE_BYTES} bytes`] };
  if (CONTROL.test(text)) return { ok: false, problems: ['the file contains control characters'] };
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---[ \t]*(?:\n([\s\S]*))?$/.exec(normalized);
  if (!m) return { ok: false, problems: ['the file must start with a header between two "---" lines'] };
  const header = readHeader(m[1]!, warnings, problems);
  const body = (m[2] ?? '').trim();
  const one = (key: string): string => (header.get(key)?.[0] ?? '').trim();

  const name = one('name');
  const description = one('description');
  if (!name) problems.push('"name" is required');
  else if (name.length > 80 || /\n/.test(name)) problems.push('"name" must be one line of at most 80 characters');
  if (!description) problems.push('"description" is required');
  else if (description.length > 400) problems.push('"description" must be at most 400 characters');
  if (!body) problems.push('the instructions (the text after the header) are empty');
  else if (body.length > MAX_INSTRUCTION_CHARS) problems.push(`the instructions are longer than ${MAX_INSTRUCTION_CHARS} characters`);

  const triggers = [...new Set((header.get('triggers') ?? []).map((t) => t.trim()).filter(Boolean))];
  if (triggers.length > 20) problems.push('at most 20 triggers');
  for (const t of triggers) if (t.length < 2 || t.length > 60) problems.push(`trigger "${t.slice(0, 30)}" must be 2-60 characters`);

  const tools = [...new Set((header.get('tools') ?? []).map((t) => t.trim()).filter(Boolean))];
  for (const t of tools) if (!SKILL_GRANTABLE_TOOLS.includes(t)) problems.push(`tool "${t.slice(0, 40)}" cannot be given to a skill (allowed: ${SKILL_GRANTABLE_TOOLS.join(', ')})`);

  const feature = one('requires_feature');
  if (feature && !(SKILL_FEATURES as readonly string[]).includes(feature)) problems.push(`requires_feature "${feature.slice(0, 30)}" is not a known add-on (${SKILL_FEATURES.join(', ')})`);

  const defaultRaw = one('default_enabled').toLowerCase();
  if (defaultRaw && !['true', 'false'].includes(defaultRaw)) problems.push('"default_enabled" must be true or false');
  const version = one('version');
  if (version && !/^[0-9A-Za-z.+-]{1,20}$/.test(version)) problems.push('"version" must be at most 20 characters of letters, digits and . + -');

  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    warnings,
    skill: { id, name, description, version: version || null, triggers, tools, requiresFeature: (feature || null) as SkillDefinition['requiresFeature'], defaultEnabled: defaultRaw === 'true', instructions: body },
  };
}
