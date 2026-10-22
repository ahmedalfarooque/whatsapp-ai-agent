import fs from 'node:fs';
import path from 'node:path';
import { env } from '../config/env';
import { logger } from '../logger';
import { MAX_SKILL_FILE_BYTES, parseSkillFile, SKILL_ID, type SkillDefinition } from './skillFile';

/**
 * Where skills come from: ONE trusted directory, `skills/` beside the application (the repository's reviewed files), or the directory named by SKILLS_DIR. Nothing else
 * is ever read: the computer is not scanned, Claude Code's own skills / settings are not touched, and a skill is not loaded from the database or from anything a
 * customer or an administrator can upload. Per skill the registry reads exactly `<root>/<id>/SKILL.md`, and only when that is a real file (not a link) whose real path
 * stays inside the root and whose size is within MAX_SKILL_FILE_BYTES. A file that does not validate is reported as a problem and is NOT available — it never half-loads.
 */
export const DEFAULT_SKILLS_ROOT = path.join(__dirname, '..', '..', 'skills');

export interface SkillProblem { id: string; problems: string[] }
export interface SkillCatalog { root: string; skills: SkillDefinition[]; problems: SkillProblem[]; loadedAt: number }

const CACHE_MS = 5000;
let cache: { root: string; at: number; catalog: SkillCatalog } | null = null;
let rootOverride: string | null = null;

/** Tests (and SKILLS_DIR) point the registry at a different trusted directory; null restores the default. */
export function setSkillsRootForTests(root: string | null): void { rootOverride = root; cache = null; }
export function resetSkillCache(): void { cache = null; }
export function skillsRoot(): string {
  if (rootOverride) return rootOverride;
  return env.SKILLS_DIR ? path.resolve(env.SKILLS_DIR) : DEFAULT_SKILLS_ROOT;
}

function loadCatalog(root: string): SkillCatalog {
  const catalog: SkillCatalog = { root, skills: [], problems: [], loadedAt: Date.now() };
  let realRoot: string;
  try { realRoot = fs.realpathSync(root); } catch { return catalog; } // no skills directory: no skills (not an error)
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(realRoot, { withFileTypes: true }); } catch { return catalog; }
  const names = new Set<string>();
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const id = entry.name;
    if (id.startsWith('.')) continue;
    if (entry.isSymbolicLink()) { catalog.problems.push({ id, problems: ['a link is not loaded (skills must be real directories)'] }); continue; }
    if (!entry.isDirectory()) continue; // a README.md or similar at the top level is not a skill
    if (!SKILL_ID.test(id)) { catalog.problems.push({ id, problems: ['the directory name is not a valid skill id'] }); continue; }
    const file = path.join(realRoot, id, 'SKILL.md');
    try {
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink() || !stat.isFile()) { catalog.problems.push({ id, problems: ['SKILL.md must be a regular file'] }); continue; }
      if (stat.size > MAX_SKILL_FILE_BYTES) { catalog.problems.push({ id, problems: [`SKILL.md is larger than ${MAX_SKILL_FILE_BYTES} bytes`] }); continue; }
      const real = fs.realpathSync(file);
      if (!real.startsWith(realRoot + path.sep)) { catalog.problems.push({ id, problems: ['SKILL.md resolves outside the skills directory'] }); continue; }
      const parsed = parseSkillFile(id, fs.readFileSync(real, 'utf8'));
      if (!parsed.ok) { catalog.problems.push({ id, problems: parsed.problems }); continue; }
      const key = parsed.skill.name.trim().toLowerCase();
      if (names.has(key)) { catalog.problems.push({ id, problems: [`another skill is already called "${parsed.skill.name}"`] }); continue; }
      names.add(key);
      catalog.skills.push(parsed.skill);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') catalog.problems.push({ id, problems: ['the directory has no SKILL.md'] });
      else catalog.problems.push({ id, problems: ['SKILL.md could not be read'] });
    }
  }
  if (catalog.problems.length > 0) logger.warn({ skillProblems: catalog.problems.map((p) => `${p.id}: ${p.problems[0]}`).slice(0, 10) }, 'some skill files were not loaded');
  return catalog;
}

/** The skills available to the application right now (cached for a few seconds: a skill file is read from disk, not on every message). */
export function loadSkills(now: number = Date.now()): SkillCatalog {
  const root = skillsRoot();
  if (cache && cache.root === root && now - cache.at < CACHE_MS) return cache.catalog;
  const catalog = loadCatalog(root);
  cache = { root, at: now, catalog };
  return catalog;
}

export function getSkill(id: string): SkillDefinition | undefined {
  return loadSkills().skills.find((s) => s.id === id);
}
