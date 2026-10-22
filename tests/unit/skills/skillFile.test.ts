import { describe, expect, it } from 'vitest';
import { MAX_INSTRUCTION_CHARS, MAX_SKILL_FILE_BYTES, parseSkillFile, SKILL_GRANTABLE_TOOLS } from '../../../src/skills/skillFile';

const file = (header: string, body = 'Follow these steps.') => `---\n${header}\n---\n${body}\n`;
const GOOD = 'name: Order status\ndescription: Answers order questions.\ntriggers: where is my order, order status\ntools: search_catalogues, request_human_handoff\ndefault_enabled: false\nversion: 1.2';
const problemsOf = (id: string, text: string): string[] => { const r = parseSkillFile(id, text); if (r.ok) throw new Error('expected a problem'); return r.problems; };

describe('reading a skill file', () => {
  it('a valid file gives a stable definition: id from the directory, header fields, instructions from the body', () => {
    const r = parseSkillFile('order-status', file(GOOD, '1. Look it up.\n2. Answer briefly.'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.skill).toEqual({
      id: 'order-status', name: 'Order status', description: 'Answers order questions.', version: '1.2',
      triggers: ['where is my order', 'order status'], tools: ['search_catalogues', 'request_human_handoff'], requiresFeature: null, defaultEnabled: false,
      instructions: '1. Look it up.\n2. Answer briefly.',
    });
  });

  it('lists can be written as "- item" lines, inline [a, b], quoted values and Windows line endings; a BOM is ignored', () => {
    const text = '﻿---\r\nname: "Quoted: name"\r\ndescription: \'A skill\'\r\ntriggers:\r\n  - first phrase\r\n  - "second, phrase"\r\ntools: [web_search]\r\nrequires_feature: catalogues\r\ndefault_enabled: TRUE\r\n---\r\nBody text\r\n';
    const r = parseSkillFile('listy', text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.skill).toMatchObject({ name: 'Quoted: name', description: 'A skill', triggers: ['first phrase', 'second, phrase'], tools: ['web_search'], requiresFeature: 'catalogues', defaultEnabled: true, instructions: 'Body text' });
  });

  it('the id comes from the directory name and must be a safe slug (no path characters, no upper case, no leading hyphen)', () => {
    for (const bad of ['', 'A', 'a', 'Upper', 'has space', 'dots.in.name', '../escape', '-lead', 'x'.repeat(49), 'semi;colon', 'ünï']) {
      expect(problemsOf(bad, file(GOOD))[0], bad).toMatch(/not a valid skill id/);
    }
    for (const ok of ['ab', 'a1', 'order-status', 'x'.repeat(48)]) expect(parseSkillFile(ok, file(GOOD)).ok, ok).toBe(true);
  });

  it('required fields, size limits and the header are enforced, each problem named', () => {
    expect(problemsOf('s1', 'no header at all')).toEqual(['the file must start with a header between two "---" lines']);
    expect(problemsOf('s1', '---\n---\nbody')).toEqual(['the file must start with a header between two "---" lines']);
    expect(problemsOf('s1', file('description: d'))).toContain('"name" is required');
    expect(problemsOf('s1', file('name: n'))).toContain('"description" is required');
    expect(problemsOf('s1', file('name: n\ndescription: d', ''))).toContain('the instructions (the text after the header) are empty');
    expect(problemsOf('s1', file('name: n\ndescription: d', 'x'.repeat(MAX_INSTRUCTION_CHARS + 1)))[0]).toMatch(/instructions are longer than/);
    expect(problemsOf('s1', file(`name: ${'n'.repeat(81)}\ndescription: d`))[0]).toMatch(/"name" must be one line of at most 80/);
    expect(problemsOf('s1', file(`name: n\ndescription: ${'d'.repeat(401)}`))[0]).toMatch(/"description" must be at most 400/);
    expect(problemsOf('s1', file('name: n\ndescription: d\nname: again'))).toContain('header key "name" appears twice');
    expect(problemsOf('s1', file('name: n\ndescription: d\nthis line is not a pair'))[0]).toMatch(/not "key: value"/);
    expect(problemsOf('s1', 'x'.repeat(MAX_SKILL_FILE_BYTES + 1))[0]).toMatch(/larger than/);
    expect(problemsOf('s1', file('name: n\ndescription: d', 'body\u0000with nul'))).toEqual(['the file contains control characters']);
  });

  it('a skill can only be given the listed read-only tools — never a tool that books, saves or sends', () => {
    for (const tool of ['book_appointment', 'save_real_estate_lead', 'send_project_brochure', 'shell', 'eval', 'send_message', '../x']) {
      expect(problemsOf('s1', file(`name: n\ndescription: d\ntools: ${tool}`))[0], tool).toMatch(/cannot be given to a skill/);
    }
    expect(SKILL_GRANTABLE_TOOLS).not.toContain('book_appointment');
    expect(SKILL_GRANTABLE_TOOLS).not.toContain('send_project_brochure');
    expect(SKILL_GRANTABLE_TOOLS).not.toContain('save_real_estate_lead');
    for (const tool of SKILL_GRANTABLE_TOOLS) expect(parseSkillFile('s1', file(`name: n\ndescription: d\ntools: ${tool}`)).ok, tool).toBe(true);
  });

  it('triggers, add-on, default and version values are validated; unknown header keys are ignored with a warning, not trusted', () => {
    expect(problemsOf('s1', file(`name: n\ndescription: d\ntriggers: a, ${'t'.repeat(61)}`))[0]).toMatch(/trigger .* must be 2-60/);
    expect(problemsOf('s1', file(`name: n\ndescription: d\ntriggers: ${Array.from({ length: 21 }, (_, i) => `phrase ${i}`).join(', ')}`))).toContain('at most 20 triggers');
    expect(problemsOf('s1', file('name: n\ndescription: d\nrequires_feature: payroll'))[0]).toMatch(/not a known add-on/);
    expect(problemsOf('s1', file('name: n\ndescription: d\ndefault_enabled: maybe'))).toContain('"default_enabled" must be true or false');
    expect(problemsOf('s1', file('name: n\ndescription: d\nversion: v 1 / bad'))[0]).toMatch(/"version" must be/);
    const r = parseSkillFile('s1', file('name: n\ndescription: d\nrun: rm something\nscript: evil.js'));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warnings).toEqual(['unknown header key "run" ignored', 'unknown header key "script" ignored']);
  });

  it('instructions are kept as text: nothing in a file is evaluated, imported or turned into a tool', () => {
    const body = 'Run `ls`, then <script>alert(1)</script> and ${process.env.SECRET} and {{template}} and import x from "y";';
    const r = parseSkillFile('s1', file('name: n\ndescription: d', body));
    expect(r.ok && r.skill.instructions).toBe(body);
    expect(r.ok && r.skill.tools).toEqual([]);
  });
});
