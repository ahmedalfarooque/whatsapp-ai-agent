import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SKILLS_ROOT, loadSkills, resetSkillCache, setSkillsRootForTests, skillsRoot } from '../../../src/skills/registry';
import { MAX_SKILL_FILE_BYTES } from '../../../src/skills/skillFile';

const GOOD = (name: string) => `---\nname: ${name}\ndescription: Does ${name}.\ntriggers: ${name} please\n---\nDo the thing.\n`;
const roots: string[] = [];
function makeRoot(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}
afterEach(() => { setSkillsRootForTests(null); for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); });
const load = (root: string) => { setSkillsRootForTests(root); return loadSkills(); };

describe('discovering skills from the one trusted directory', () => {
  it('reads <root>/<id>/SKILL.md for each directory, sorted by id, and ignores files and dot-directories at the top level', () => {
    const catalog = load(makeRoot({ 'b-skill/SKILL.md': GOOD('Beta'), 'a-skill/SKILL.md': GOOD('Alpha'), 'README.md': '# not a skill', '.hidden/SKILL.md': GOOD('Hidden') }));
    expect(catalog.skills.map((s) => s.id)).toEqual(['a-skill', 'b-skill']);
    expect(catalog.problems).toEqual([]);
  });

  it('a missing skills directory means no skills — not an error', () => {
    const catalog = load(path.join(os.tmpdir(), 'no-such-skills-dir-xyz'));
    expect(catalog.skills).toEqual([]);
    expect(catalog.problems).toEqual([]);
  });

  it('invalid files are reported with the reason and are NOT available; valid neighbours still load', () => {
    const catalog = load(makeRoot({
      'good/SKILL.md': GOOD('Good'),
      'no-name/SKILL.md': '---\ndescription: d\n---\nbody',
      'bad-tool/SKILL.md': '---\nname: Bad tool\ndescription: d\ntools: book_appointment\n---\nbody',
      'no-header/SKILL.md': 'just text',
      'empty-dir/placeholder.txt': 'no skill file here',
      'Bad_ID/SKILL.md': GOOD('Underscore'),
      'too-big/SKILL.md': `---\nname: Big\ndescription: d\n---\n${'x'.repeat(MAX_SKILL_FILE_BYTES + 10)}`,
    }));
    expect(catalog.skills.map((s) => s.id)).toEqual(['good']);
    const byId = Object.fromEntries(catalog.problems.map((p) => [p.id, p.problems.join(' | ')]));
    expect(byId['no-name']).toContain('"name" is required');
    expect(byId['bad-tool']).toContain('cannot be given to a skill');
    expect(byId['no-header']).toContain('must start with a header');
    expect(byId['empty-dir']).toContain('no SKILL.md');
    expect(byId['Bad_ID']).toContain('not a valid skill id');
    expect(byId['too-big']).toContain('larger than');
  });

  it('two skills with the same display name are not both loaded (the second is reported)', () => {
    const catalog = load(makeRoot({ 'first/SKILL.md': GOOD('Same Name'), 'second/SKILL.md': GOOD('same name') }));
    expect(catalog.skills.map((s) => s.id)).toEqual(['first']);
    expect(catalog.problems).toEqual([{ id: 'second', problems: ['another skill is already called "same name"'] }]);
  });

  it('a link is never followed: a symlinked skill directory or SKILL.md that points outside the directory is not loaded', () => {
    const outside = makeRoot({ 'secret/SKILL.md': GOOD('Outside') });
    const root = makeRoot({ 'real/SKILL.md': GOOD('Real') });
    let linked = true;
    try {
      fs.symlinkSync(path.join(outside, 'secret'), path.join(root, 'linked-dir'), 'junction');
      fs.mkdirSync(path.join(root, 'file-link'));
      fs.symlinkSync(path.join(outside, 'secret', 'SKILL.md'), path.join(root, 'file-link', 'SKILL.md'), 'file');
    } catch { linked = false; } // creating links may need a privilege on some Windows setups: then there is nothing to follow
    const catalog = load(root);
    expect(catalog.skills.map((s) => s.id)).toEqual(['real']);
    if (linked) expect(catalog.problems.map((p) => p.id).sort()).toEqual(expect.arrayContaining(['file-link'].filter(() => fs.existsSync(path.join(root, 'file-link', 'SKILL.md')))));
  });

  it('the result is cached for a few seconds and reloads when asked', () => {
    const root = makeRoot({ 'one/SKILL.md': GOOD('One') });
    setSkillsRootForTests(root);
    expect(loadSkills().skills).toHaveLength(1);
    fs.mkdirSync(path.join(root, 'two'));
    fs.writeFileSync(path.join(root, 'two', 'SKILL.md'), GOOD('Two'));
    expect(loadSkills().skills).toHaveLength(1); // still the cached answer
    resetSkillCache();
    expect(loadSkills().skills).toHaveLength(2);
  });

  it('the default directory is the application\'s own skills/ folder, and SKILLS_DIR (central config) is the only way to name another', () => {
    expect(DEFAULT_SKILLS_ROOT).toBe(path.resolve(__dirname, '../../../skills'));
    expect(skillsRoot()).toBe(DEFAULT_SKILLS_ROOT);
  });
});

describe('the skills shipped with the application', () => {
  it('every one validates (no problems), has a unique id and name, grants only allowed tools and is OFF by default', () => {
    const catalog = load(DEFAULT_SKILLS_ROOT);
    expect(catalog.problems).toEqual([]);
    expect(catalog.skills.length).toBeGreaterThanOrEqual(3);
    expect(new Set(catalog.skills.map((s) => s.id)).size).toBe(catalog.skills.length);
    for (const s of catalog.skills) {
      expect(s.defaultEnabled, s.id).toBe(false); // a business opts in; nothing starts answering customers differently by itself
      expect(s.tools, s.id).not.toContain('book_appointment');
      expect(s.instructions.length, s.id).toBeGreaterThan(50);
    }
    expect(catalog.skills.map((s) => s.id)).toEqual(expect.arrayContaining(['catalogue-finder', 'quote-request-helper', 'complaint-handling']));
  });
});
