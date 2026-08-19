/**
 * What a delegated teammate is allowed to call.
 *
 * Shared, like the persona rules next door, because a team installed from the
 * market and the same team shipped in the box must behave the same way: one row
 * shape means one behaviour to reason about, and the nine-tool child is the shape
 * this product has actually run end to end.
 *
 * @module openlux-plugin-account/market/teammate-tools
 */

/**
 * Portable allow-list for a teammate.
 *
 * The first four are tools the standard preset always registers, so a member row
 * naming them is valid in any composition this product ships.
 *
 * The two media tools are on a different footing and are here for a specific
 * reason: they are registered into the *global* tool layer rather than a
 * preset's (see the `tool-web` note in `cordis.patch.yml`), so every agent sees
 * them whatever preset it composed from — but `toolFilter.allow` is a whitelist,
 * so omitting them here is what took drawing and filming away from teammates.
 * That is a hard failure with no message: one shipped team has an `image-creator`
 * and a `video-generator` whose whole job is those two tools, and a delegation to
 * them could only ever come back as prose about a picture nobody made.
 *
 * Every member gets both rather than a per-role table, and the trade-off is
 * deliberate: a copywriter that can also draw is a wider agent than it needs to
 * be, while a per-role table is a second place to keep in sync with the roster
 * and would fail the same silent way the next time a team gains a member.
 *
 * ## Why `pwsh`, `web_fetch` and `read_image` are on it
 *
 * The list is bounded by what the kernel will accept, and the kernel says so out
 * loud: an entry it cannot resolve fails the whole delegation with
 * `tools.restrict() names unknown global tools "web_search", "glob", "grep",
 * "todo_write", "ask_user_question"; known global tools: …`. That message is the
 * candidate set — a teammate can be given a *global* tool and nothing else, so
 * `pwsh`, `web_fetch` and `read_image` are available and search is not
 * (`web_search` is registered per preset with `fetch: false`, the global row
 * being fetch-only with `search: false`).
 *
 * Shell earns its place: 13 of the 22 imported packages carry skills that are
 * scripts rather than prose, and three of those are teams — one team's 13 skills
 * are all crawlers. A teammate that can load such a skill but not run it reads
 * the instructions and then invents the output.
 *
 * The cost, measured on this machine rather than assumed: a delegated session
 * logs `approval/policy {"policy":"never","source":"delegation"}` with
 * `sandbox/mode workspace-write`, so a teammate's command runs without asking
 * anyone. The sandbox is the bound, and it is the kernel's own default for
 * delegation; a narrower product rule would have to be a `tools/pre-execute`
 * policy rather than an omission here, because omitting the tool is what
 * silently turns a scripted skill into fiction.
 *
 * `image_show` is deliberately absent: showing a picture to the user is the
 * lead's move, and a member has no user looking at its transcript
 * (`media/show-tool.ts`).
 */
export const MEMBER_ALLOW: readonly string[] = [
  'skill', 'read', 'write', 'edit', 'image_generate', 'video_generate',
  'pwsh', 'web_fetch', 'read_image',
]

/** One row of the lead's roster: the tool to call, and who answers. */
export interface Teammate {
  /** The delegation tool's name, as the composition registers it. */
  readonly toolName: string
  /** Who that tool reaches, in whatever terms the source could supply. */
  readonly label: string
}

/** Heading and instruction of the roster block, kept out of the loop below. */
const ROSTER_HEAD = [
  '',
  '## OpenLux teammate tools',
  'Delegate by calling these tools. Do not answer in a teammate\'s place.',
]

/**
 * Append the lead's roster of delegation tools to its persona.
 *
 * This one has to be prose in the document, and that was checked rather than
 * assumed: `dsh-tool-subagent`'s config takes `provider`, `toolName`,
 * `backgroundMode`, `agentOptions`, `persona`, `toolFilter` and `maxDepth` and
 * nothing else (`lib/index.js:22-38`), so a row cannot carry a description of
 * who the member is — the tool's description is the kernel's own fixed wording
 * about delegation in general.
 *
 * It survives alongside the runtime block that also names these tools
 * (`persona/tool-reality.ts` derives them from the visible tool set) because the
 * two say different things: the runtime one says *how* to delegate over whatever
 * tools exist, this one says *who* each tool reaches. An imported lead persona
 * already carries its own member table — `ai-content-creator-team`'s lists every
 * member with a Chinese name and a dispatch cheat-sheet — but it names members
 * by bare id, the way its own platform delegated. This block is the bridge from
 * those ids to the tool names this kernel registered.
 * @param lead - the lead's corrected persona.
 * @param teammates - one entry per member, in roster order.
 * @returns the persona with the roster appended.
 */
export function withTeammateRoster(lead: string, teammates: readonly Teammate[]): string {
  const lines = [...ROSTER_HEAD, ...teammates.map(row => `- ${row.toolName}: ${row.label}`)]
  return `${lead.replace(/\n$/, '')}\n${lines.join('\n')}\n`
}
