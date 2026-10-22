import type { Request, Response, Router } from 'express';
import { logger } from '../logger';
import { currentAccountId } from '../accounts/accountContext';
import type { AuthUser } from './permissions';
import { getSkill, loadSkills } from '../skills/registry';
import { SKILL_GRANTABLE_TOOLS, SKILL_ID, type SkillDefinition } from '../skills/skillFile';
import { listSkillRuns, setSkillEnabled, skillAvailableTo, skillRunCounts, skillStates, stateOf } from '../skills/skillRepo';

/**
 * Business skills for the SELECTED business (docs/SKILLS.md). The account comes from the authenticated session (the account middleware checked the user may open it;
 * authorize.ts that they hold "AI knowledge & settings": view to read, edit to switch a skill on or off) — never from the request body or the URL, so one business can
 * not read or change another's choices. The skill files themselves are reviewed repository files, read-only here: this API cannot create, edit or delete one.
 */
const TOOL_LABELS: Record<string, string> = {
  search_catalogues: 'Search this business\'s catalogues and linked official pages',
  web_search: 'Look up current public information on the web',
  check_availability: 'Check appointment availability (read-only)',
  search_real_estate_projects: 'Search this business\'s published real estate projects',
  request_human_handoff: 'Hand the customer to a person',
};

function view(accountId: number, skill: SkillDefinition, states: ReturnType<typeof skillStates>, counts: ReturnType<typeof skillRunCounts>) {
  const state = stateOf(skill, states);
  const available = skillAvailableTo(accountId, skill);
  return {
    id: skill.id, name: skill.name, description: skill.description, version: skill.version, triggers: skill.triggers,
    tools: skill.tools.map((t) => ({ name: t, label: TOOL_LABELS[t] ?? t })),
    requiresFeature: skill.requiresFeature, available,
    unavailableReason: available ? null : 'This business does not have the add-on this skill needs.',
    enabled: available && state.enabled, choice: state.explicit ? (state.enabled ? 'on' : 'off') : 'default', defaultEnabled: skill.defaultEnabled,
    updatedAt: state.updatedAt, invocation: `/${skill.id}`,
    runs: counts.get(skill.id) ?? { total: 0, answered: 0, failed: 0, last: null },
  };
}

function fail(res: Response, error: unknown): void {
  logger.error({ errorName: (error as Error)?.name, errorMessage: String((error as Error)?.message ?? error).slice(0, 200) }, 'skills request failed');
  res.status(500).json({ error: 'internal_server_error' });
}

export function registerSkillRoutes(router: Router): void {
  router.get('/api/dashboard/skills', (_req: Request, res: Response) => {
    try {
      const accountId = currentAccountId();
      const catalog = loadSkills();
      const states = skillStates(accountId);
      const counts = skillRunCounts(accountId);
      res.json({
        skills: catalog.skills.map((s) => view(accountId, s, states, counts)),
        // Files that did not validate are listed with what is wrong (never their content or their location on the server).
        problems: catalog.problems.map((p) => ({ id: p.id, problems: p.problems })),
        grantableTools: SKILL_GRANTABLE_TOOLS.map((t) => ({ name: t, label: TOOL_LABELS[t] ?? t })),
      });
    } catch (error) { fail(res, error); }
  });

  router.get('/api/dashboard/skills/:id', (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);
      const skill = SKILL_ID.test(id) ? getSkill(id) : undefined;
      if (!skill) { res.status(404).json({ error: 'skill_not_found' }); return; }
      const accountId = currentAccountId();
      res.json({
        skill: { ...view(accountId, skill, skillStates(accountId), skillRunCounts(accountId)), instructions: skill.instructions },
        recentRuns: listSkillRuns(accountId, skill.id, 20).map((r) => ({ id: r.id, selection: r.selection, status: r.status, tools: r.tools_used ? r.tools_used.split(',') : [], reason: r.reason, at: r.created_at })),
      });
    } catch (error) { fail(res, error); }
  });

  router.put('/api/dashboard/skills/:id', (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);
      const skill = SKILL_ID.test(id) ? getSkill(id) : undefined;
      if (!skill) { res.status(404).json({ error: 'skill_not_found' }); return; }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const keys = Object.keys(body);
      if (typeof body.enabled !== 'boolean' || keys.some((k) => k !== 'enabled')) { res.status(400).json({ error: 'validation_failed', fields: ['enabled'] }); return; }
      const accountId = currentAccountId();
      if (body.enabled && !skillAvailableTo(accountId, skill)) { res.status(409).json({ error: 'skill_not_available', message: 'This business does not have the add-on this skill needs, so it cannot be switched on.' }); return; }
      const user = req.authUser as AuthUser | undefined;
      setSkillEnabled(accountId, skill.id, body.enabled, user?.id ?? null);
      logger.info({ account: accountId, skill: skill.id, enabled: body.enabled, by: user?.id ?? null }, 'skill switched');
      res.json({ skill: view(accountId, skill, skillStates(accountId), skillRunCounts(accountId)) });
    } catch (error) { fail(res, error); }
  });
}
