import type { AgentOverrideConfig } from './schema';
import { normalizeAgentSkillDirectives } from './utils';

/** Resolve runtime-only skill directives after all agent layers are merged. */
export function resolveEffectiveAgentOverrides(
  agents: Record<string, AgentOverrideConfig>,
  projectLocalSkillNames: () => readonly string[],
): Record<string, AgentOverrideConfig> {
  const includesLocalSkills = Object.values(agents).some(
    (override) => override.skills_include_local === true,
  );
  return normalizeAgentSkillDirectives(
    agents,
    includesLocalSkills ? projectLocalSkillNames() : [],
  );
}
