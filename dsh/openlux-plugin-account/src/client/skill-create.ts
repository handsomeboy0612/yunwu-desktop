import type { SkillTarget } from '../market/wire.ts'

/** The authoring skill WorkBuddy activates for its «创建技能» flow. */
export const SKILL_CREATOR = 'skill-creator'

/** Draft plus the explicit token whose native DSH decoration should be primed. */
export interface SkillCreationDraft {
  readonly prompt: string
  readonly skillToken?: string
}

/**
 * Build the draft placed in a skill-authoring session.
 *
 * DSH deliberately treats a literal `/name` in the draft as the skill
 * invocation: the host injects the full skill body before the model acts
 * (`@deepseek-ai/dsh-client-ui-skill/README.zh.md:5-7`). The client may also
 * decorate the token once its skill lexicon is warm, but correctness does not
 * depend on that decoration. Prefix only when the installed catalog proves that
 * exact front-matter name exists; otherwise the descriptive prompt remains
 * usable instead of becoming a dead slash command.
 */
export function skillCreationDraft(target: SkillTarget, prompt: string): SkillCreationDraft {
  const available = target.installed.some(skill => skill.name === SKILL_CREATOR)
  return available
    ? { prompt: `/${SKILL_CREATOR} ${prompt}`, skillToken: SKILL_CREATOR }
    : { prompt }
}
