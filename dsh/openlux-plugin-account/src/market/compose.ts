/**
 * Compose a DSH agent preset out of a market expert's CONTENT.
 *
 * The server ships `expert-content.tar.gz`: a persona, one persona per team
 * member, and whatever files those personas reference. It deliberately does not
 * ship a composition, because a composition names kernel packages and is
 * therefore only valid for one kernel version — shipping one would re-bind the
 * whole catalog to every kernel bump. The client knows which kernel it is
 * running, so the composition is built here, at install time.
 *
 * ## It is the running kernel's own `standard`, not a template of ours
 *
 * The base text is read from whatever `standard` the roster resolves. That is
 * the one decision this file is built around: a template of our own would drift
 * from the kernel on the first bump, in a way nothing would notice until a row
 * failed to mount. Reading the shipped file means an upgraded kernel upgrades
 * every installed expert's capability set for free, and a row the kernel adds
 * or renames arrives without us tracking it.
 *
 * ## The persona is corrected on the way in
 *
 * The documents in the archive were written for another product, and they name
 * tools, models and mechanisms that do not exist here. Those corrections are not
 * this file's business to invent — they live in `persona-rules.ts`, shared with
 * the build script that materialises the experts we ship in the box, so an
 * expert installed from the market is the same agent as its bundled twin rather
 * than a second dialect of it. This file only decides *when* they run: on the
 * lead persona, on each member persona, and — through {@link correctAssets} —
 * on the markdown the installer writes beside them.
 *
 * What is deliberately NOT done here is the paragraph that outranks a persona's
 * claims about the local tool set. That is said once at runtime, over the tool
 * list the agent actually has (`persona/tool-reality.ts`), because a sentence
 * written into a file at install time would still be asserting a tool inventory
 * a later kernel has changed.
 *
 * Three edits are applied to that text, each one an idiom taken from a shipped
 * composition rather than invented here:
 *
 * 1. The `persona` row's text becomes the expert's persona. The shipped
 *    `standard` already carries this row with a one-line default, and
 *    `dsh-persona` is scope-only precisely so a preset can shadow the
 *    deployment persona (`dsh-persona/lib/index.js:8-15`).
 * 2. A team's members each become a `dsh-tool-subagent` row carrying that
 *    member's persona. The kernel supports this directly: `persona` is a
 *    documented per-child config, and the `spawn` provider declares all four
 *    start-time capabilities including `persona` and `depthLimit`
 *    (`dsh-subagent-spawn-in-process/lib/index.js:23-28`), so the rows mount
 *    rather than throwing.
 * 3. When the expert brings bundled skills, `skill-filesystem` gains a
 *    `customSkillDirs` entry pointing at the preset's own `skills/`. This is
 *    copied verbatim from the shipped `cordis` preset, whose own comment
 *    explains it: "`baseUrl` is the preset's own directory, so the root
 *    resolves wherever the preset is installed."
 *
 * Note what edit 3 does NOT do: it does not turn off `includeDefaultRoots`. The
 * shipped idiom only ADDS a root, so a bundled skill joins the user's own
 * skills rather than replacing them — which is also what the product we are
 * aligned with does (a session there lists tens of skills, of which the summoned
 * expert's are a handful).
 *
 * ## Why text edits and not parse-then-serialise
 *
 * A composition carries `!!js` tags (`disabled: !!js process.platform === …`,
 * and the `customSkillDirs` line above). A general YAML parser rejects the
 * unknown tag, and an emitter cannot round-trip it — parsing would mean
 * teaching a parser the loader's own tag set, then re-emitting a file whose
 * comments and structure carry the kernel's reasoning. So the rows are edited
 * as lines, which is safe here because the root level of a composition is a
 * flat sequence: every row starts at column 0 with `- id: …` and every line
 * belonging to it is indented. {@link rowBody} depends on exactly that and
 * fails loud when it does not hold.
 *
 * The one thing text editing cannot do safely is emit arbitrary text, and this
 * file has to emit two kinds (personas, which are whole markdown documents).
 * They go in as literal block scalars, which is what the shipped `standard`
 * and both of our hand-authored presets use. Reading them from a file through
 * `!!js readFileSync` would dodge the escaping question, but no shipped
 * composition does I/O inside `!!js` — every one of them is a pure expression
 * over `process` and `baseUrl` — so that would be a mechanism of our own.
 * {@link blockScalar} normalises instead, and a defect there cannot install
 * anything silently: the installer's last step asks the kernel whether it can
 * discover what we wrote and rolls back with the loader's own message.
 */

import type { ArchiveEntry } from './targz.ts'
import type { Scrubber } from './persona-rules.ts'
import {
  FABRICATED_NAMES,
  findPhantomTools,
  neutralizeTemplates,
  rewriteIdentity,
  templateVarNames,
  unknownTemplateVars,
  withSkillDocNote,
} from './persona-rules.ts'
import { MEMBER_ALLOW, withTeammateRoster } from './teammate-tools.ts'
import { ArchiveError } from './targz.ts'

/** The persona document at the archive root: the expert, or a team's lead. */
const PERSONA_ENTRY = 'SKILL.md'

/** Directory holding one persona document per team member. */
const MEMBERS_DIR = 'members/'

/** Where bundled skills are written, and what the composition points at. */
export const SKILLS_DIR = 'skills'

/** One team member, as the archive describes them. */
export interface ExpertMember {
  /** Member id, taken from the file name under `members/`. */
  readonly id: string
  /** That member's persona document. */
  readonly persona: string
}

/** An expert's content, once the archive has been checked. */
export interface ExpertContent {
  /** The expert's own persona; a team's is its lead's. */
  readonly persona: string
  /** Team members, empty for a single expert. */
  readonly members: readonly ExpertMember[]
  /** Everything else in the archive, written into the preset as it stands. */
  readonly assets: readonly ArchiveEntry[]
}

/**
 * Read an `expert-content.tar.gz`'s members after {@link readTarGz} has bounded
 * it.
 *
 * The shape is asserted here rather than trusted: an archive missing its
 * persona would compose a preset whose identity is the kernel's default coding
 * agent, which is a working preset presenting itself as someone it is not —
 * the one failure mode that would not surface as an error anywhere later.
 * @param entries - archive members, with relative paths.
 * @returns the content, ready to compose.
 * @throws ArchiveError when the archive is not expert content.
 */
export function readExpertContent(entries: readonly ArchiveEntry[]): ExpertContent {
  const files = entries.filter(entry => entry.kind === 'file')
  const personaEntry = files.find(entry => entry.path === PERSONA_ENTRY)
  if (personaEntry === undefined) {
    throw new ArchiveError(`专家内容包根目录下没有 ${PERSONA_ENTRY}，无法确定这个专家的人设。`)
  }
  const persona = decode(personaEntry)
  if (persona.trim() === '') {
    throw new ArchiveError(`${PERSONA_ENTRY} 是空的，装出来的专家会退回内核默认身份。`)
  }
  const members: ExpertMember[] = []
  const assets: ArchiveEntry[] = []
  for (const entry of entries) {
    if (entry.kind === 'file' && entry.path === PERSONA_ENTRY) continue
    const id = memberIdOf(entry.path)
    if (id !== undefined && entry.kind === 'file') {
      const text = decode(entry)
      // An empty member file is dropped rather than refused: the member would
      // inherit the deployment persona and answer as the generic agent, and one
      // bad member should not cost the user the whole team.
      if (text.trim() !== '') members.push({ id, persona: text })
      continue
    }
    // Member personas are consumed into rows above; everything else — including
    // assets the personas reference — is written into the preset directory.
    if (id === undefined) assets.push(entry)
  }
  members.sort((left, right) => left.id.localeCompare(right.id))
  return { persona, members, assets }
}

/** Decode one archive member as UTF-8 text. */
function decode(entry: ArchiveEntry): string {
  return new TextDecoder().decode(entry.body)
}

/**
 * The member id a path under `members/` names, or undefined for other paths.
 *
 * Only direct `.md` children count. A nested path under `members/` is an asset
 * of that member, not a second member.
 */
function memberIdOf(path: string): string | undefined {
  if (!path.startsWith(MEMBERS_DIR)) return undefined
  const rest = path.slice(MEMBERS_DIR.length)
  return rest.endsWith('.md') && !rest.includes('/') ? rest.slice(0, -'.md'.length) : undefined
}

/** What composing needs beyond the archive itself. */
export interface ComposeOptions {
  /**
   * This package's document corrections.
   *
   * One scrubber for the whole install, personas and assets together: its
   * staleness report is only meaningful once every document of the package has
   * been through it.
   */
  readonly rules: Scrubber
  /**
   * Skill slugs that will be written under `skills/`; empty leaves the skill
   * roots exactly as the kernel shipped them.
   */
  readonly bundledSkills?: readonly string[]
  /**
   * Where to report a persona that still names a tool nothing registers.
   *
   * A report rather than a refusal, and that is the whole reason this is a
   * callback: the build script treats the same finding as fatal because a human
   * is standing there and the package set is curated, while here the user asked
   * for this expert and the runtime paragraph already tells it those names are
   * not real. Refusing the install would cost them the expert to fix a sentence
   * that has already been overruled.
   */
  readonly warn?: (message: string) => void
}

/**
 * Build the composition for one expert.
 * @param standard - the running kernel's `standard` composition text.
 * @param content - the expert's content.
 * @param options - corrections, bundled skills, and where to report findings.
 * @returns composition text to write as `agent.cordis.yml`.
 * @throws Error when the base composition is not the flat row sequence every
 * shipped composition is.
 * @throws ArchiveError when a persona would fail to render as a prompt.
 */
export function composeExpertPreset(
  standard: string,
  content: ExpertContent,
  options: ComposeOptions,
): string {
  const { rules, bundledSkills = [], warn } = options
  // Members first, because the lead's roster names the tools their rows
  // register: assigning those names is what settles both.
  const members = plannedTeammates(content.members, rules, warn)
  const persona = correctPersona(content.persona, rules, PERSONA_ENTRY, warn)
  let text = replacePersona(standard, members.length === 0
    ? persona
    : withTeammateRoster(persona, members.map(member => ({
      toolName: member.toolName,
      label: labelOf(member.persona, member.id),
    }))))
  if (bundledSkills.length > 0) text = addSkillRoot(text)
  if (members.length > 0) text = appendTeammates(text, members)
  assertRenderable(text)
  return text
}

/**
 * Refuse a composition whose prompts the registry could not render.
 *
 * Not a warning like the phantom tools are: an unresolvable `{{…}}` throws
 * inside the registry at prompt-build time, so such an agent cannot take a
 * single turn, and a refusal names the archive instead of leaving the user with
 * a card that greets them and then fails on everything. Checked over the whole
 * composition rather than per persona — which is where the build path checks it
 * too — because the base text carries rows of the kernel's own with variables in
 * them, and a persona's stray braces have already been neutralised by then.
 * @param composition - the finished composition text.
 * @throws ArchiveError naming the variables and what the registry does resolve.
 */
function assertRenderable(composition: string): void {
  const unknown = unknownTemplateVars(composition)
  if (unknown.length === 0) return
  throw new ArchiveError(
    `组装出来的预设引用了 ${unknown.map(name => `{{${name}}}`).join('、')}，`
    + `而提示词变量只有 ${templateVarNames().join('、')} 可用，这样的人设每一轮都会渲染失败，已中止安装。`,
  )
}

/** A member with everything the composition needs decided. */
interface PlannedTeammate extends ExpertMember {
  /** The row's `id`, unique in this composition. */
  readonly rowId: string
  /** The model-facing delegation tool name, unique in this composition. */
  readonly toolName: string
}

/**
 * Correct each member's persona and claim its names.
 *
 * Both name sets are de-duplicated here rather than at the point of use, and the
 * row id needs it for a reason less obvious than the tool name's: two member ids
 * that differ only outside the id alphabet (`video.editor@v2` and
 * `video-editor-v2`) collapse to one row id, and the loader keys entries BY id —
 * the second row would shadow the first and that member would vanish from the
 * team with nothing reported.
 * @param members - members as the archive describes them, in roster order.
 * @param rules - this package's corrections.
 * @param warn - where to report phantom tool mandates.
 * @returns the members, with names claimed and personas corrected.
 */
function plannedTeammates(
  members: readonly ExpertMember[],
  rules: Scrubber,
  warn?: (message: string) => void,
): readonly PlannedTeammate[] {
  const toolNames = new Set<string>()
  const rowIds = new Set<string>()
  return members.map(member => ({
    id: member.id,
    persona: correctPersona(member.persona, rules, `${MEMBERS_DIR}${member.id}.md`, warn),
    rowId: unique(`teammate-${slugify(member.id)}`, rowIds, '-'),
    toolName: delegateToolName(member.id, toolNames),
  }))
}

/**
 * Who a member is, in terms the archive can supply.
 *
 * The manifest a package ships is the better source and it is not in the
 * artifact, so this reads the persona's own first heading — which is where these
 * documents put the member's name, `# 文案创作专家 - 笔澜(Penn)` being the shape.
 * The frontmatter carries the same thing under `displayName`, but nested per
 * language, and reading it would mean a YAML parser in the one file that gets by
 * without one. Falling back to the id is not a degradation worth avoiding: the id
 * is what the imported lead persona's own member table calls that member.
 * @param persona - the member's corrected persona.
 * @param id - the member id, used when the document has no heading.
 * @returns a single-line label.
 */
function labelOf(persona: string, id: string): string {
  const heading = /^#\s+(.+)$/m.exec(persona)
  const text = (heading?.[1] ?? '').trim()
  return text === '' ? id : text.slice(0, MAX_LABEL)
}

/** Cap for a roster label, so one runaway heading cannot swell every prompt. */
const MAX_LABEL = 80

/**
 * Apply the shared corrections to one persona document.
 *
 * Same order as the build script, because the two have to produce the same
 * bytes: identity first, then the package's own fixes, then brace
 * neutralisation last — a fix's replacement text can itself contain braces.
 * @param text - the persona as the archive carries it.
 * @param rules - this package's corrections.
 * @param label - the archive path, for anything reported about this document.
 * @param warn - where to report phantom tool mandates.
 * @returns the corrected persona.
 */
function correctPersona(
  text: string,
  rules: Scrubber,
  label: string,
  warn?: (message: string) => void,
): string {
  const corrected = neutralizeTemplates(rules.scrub(rewriteIdentity(text)))
  if (warn !== undefined) {
    const found = findPhantomTools(corrected, label)
    if (found.length > 0) warn(`${label} 仍在指示调用本机没有的工具：\n${found.join('\n')}`)
  }
  return corrected
}

/**
 * Correct the markdown the installer writes beside the composition.
 *
 * Skill documents describe the same imaginary tool set the personas did, and a
 * teammate is allowed to read them — a scrubbed persona pointing at an
 * unscrubbed skill document just moves the fiction one file along. Only markdown
 * is touched, and only the documents that actually name that tool set get the
 * note; the rest are ordinary craft references where it would be noise.
 *
 * Non-text members pass through untouched, which is why this maps over entries
 * instead of rewriting them in place after the write: an image decoded as UTF-8
 * and re-encoded would not survive.
 * @param entries - archive members bound for the preset directory.
 * @param rules - this package's corrections, shared with the personas.
 * @returns the entries, corrected where they are markdown.
 */
export function correctAssets(
  entries: readonly ArchiveEntry[],
  rules: Scrubber,
): readonly ArchiveEntry[] {
  return entries.map((entry) => {
    if (entry.kind !== 'file' || !entry.path.endsWith('.md')) return entry
    const original = decode(entry)
    const fixed = rules.scrub(original)
    const corrected = FABRICATED_NAMES.test(original) ? withSkillDocNote(fixed) : fixed
    return corrected === original ? entry : { ...entry, body: new TextEncoder().encode(corrected) }
  })
}

/** Rows are located by their `id`, which is a column-0 sequence entry. */
function rowStart(lines: readonly string[], id: string): number {
  const index = lines.findIndex(line => line === `- id: ${id}`)
  if (index === -1) {
    throw new Error(`内核的 standard 组装里找不到 ${id} 行，这一版内核的预设结构与预期不同，已中止组装。`)
  }
  return index
}

/**
 * The line range one row occupies, as `[start, end)`.
 *
 * A row owns every following line that is indented or blank. That holds for
 * the whole shipped set — including block scalars and nested groups, whose
 * lines are indented further — and stops at the next row or at a column-0
 * comment introducing one.
 */
function rowBody(lines: readonly string[], start: number): number {
  let end = start + 1
  while (end < lines.length && (lines[end] === '' || lines[end]!.startsWith('  '))) end += 1
  // Trailing blanks belong to the file's spacing, not to the row.
  while (end > start + 1 && lines[end - 1] === '') end -= 1
  return end
}

/**
 * Replace the `persona` row's config with this expert's persona.
 *
 * The row's `- id:`/`name:` lines are kept and only its config is rewritten, so
 * the kernel keeps owning which package provides the persona.
 */
function replacePersona(standard: string, persona: string): string {
  const lines = standard.split('\n')
  const start = rowStart(lines, 'persona')
  const end = rowBody(lines, start)
  const nameLine = lines[start + 1]
  if (nameLine === undefined || !nameLine.startsWith('  name:')) {
    throw new Error('内核的 standard 组装里 persona 行没有紧跟 name 字段，结构与预期不同，已中止组装。')
  }
  const rewritten = [
    lines[start]!,
    nameLine,
    '  config:',
    `    text: ${blockScalar(persona, 6)}`,
  ]
  return [...lines.slice(0, start), ...rewritten, ...lines.slice(end)].join('\n')
}

/**
 * Point `skill-filesystem` at the preset's own `skills/`.
 *
 * Verbatim from the shipped `cordis` preset. The row may or may not already
 * carry a `config:` mapping (`standard` does not, `cordis` does), so both are
 * handled — extending rather than replacing, because a config key the kernel
 * adds there later must survive an install.
 */
function addSkillRoot(text: string): string {
  const lines = text.split('\n')
  const start = rowStart(lines, 'skill-filesystem')
  const end = rowBody(lines, start)
  const entry = `      - !!js "process.getBuiltinModule('node:url').fileURLToPath(new URL('${SKILLS_DIR}/', baseUrl))"`
  const configAt = lines.slice(start, end).findIndex(line => line === '  config:')
  const existing = lines.slice(start, end).findIndex(line => line === '    customSkillDirs:')
  if (existing !== -1) {
    // The kernel already declares roots here: add ours to the same list.
    return [...lines.slice(0, start + existing + 1), entry, ...lines.slice(start + existing + 1)].join('\n')
  }
  const insertion = configAt === -1
    ? ['  config:', '    customSkillDirs:', entry]
    : ['    customSkillDirs:', entry]
  const at = configAt === -1 ? end : start + configAt + 1
  return [...lines.slice(0, at), ...insertion, ...lines.slice(at)].join('\n')
}

/**
 * Append one delegation row per team member.
 *
 * Appended at the root rather than inserted into the shipped `delegation`
 * group: that group exists to give `workflows` an entry-local realm, and a
 * `dsh-tool-subagent` row injects three registries while providing nothing
 * (`dsh-tool-subagent/lib/index.js:15-19`), so it needs no realm. Appending
 * also means nothing inside the kernel's own group is disturbed.
 *
 * The generic `subagent`/`subagent_fork` rows are left in place. A leader can
 * therefore still spawn an unnamed child, which costs two tool schemas and
 * changes nothing the user sees; removing them would mean editing rows the
 * kernel owns for a benefit nobody asked for.
 *
 * Each row carries `toolFilter.allow`, and the list is shared with the build
 * script rather than written here (`teammate-tools.ts` says which tools and
 * why). It is a whitelist the kernel resolves against its global tool names, so
 * both ways of getting it wrong are quiet: a name the kernel cannot resolve
 * fails the delegation, and a name left off takes that tool away from the member
 * with nothing said — which is exactly how a drawing role came back describing a
 * picture it had not made.
 */
function appendTeammates(text: string, members: readonly PlannedTeammate[]): string {
  const rows = members.map((member) => {
    return [
      `- id: ${member.rowId}`,
      `  name: '@deepseek-ai/dsh-tool-subagent'`,
      '  config:',
      '    provider: spawn',
      `    toolName: ${member.toolName}`,
      // One-shot and foreground: the leader asked for this member's answer and
      // continues from it. `maxDepth: 1` stops a member from re-delegating,
      // which the spawn provider can enforce (it declares `depthLimit`).
      '    backgroundMode: one-shot',
      '    enableRunInBackground: false',
      '    maxDepth: 1',
      `    persona: ${blockScalar(member.persona, 6)}`,
      '    toolFilter:',
      '      allow:',
      ...MEMBER_ALLOW.map(name => `        - ${name}`),
    ].join('\n')
  })
  const header = [
    '',
    '# ── teammates ───────────────────────────────────────────────────────────────',
    '',
    '# One row per member of this expert team, written when the expert was',
    '# installed. Each carries that member\'s persona, which the spawn provider',
    '# applies to the child it creates.',
    '',
  ].join('\n')
  return `${text.replace(/\n*$/, '\n')}${header}${rows.join('\n\n')}\n`
}

/**
 * The model-facing name for delegating to one member.
 *
 * Bounded by the wire, not by the kernel: the tool registry accepts almost any
 * name, but an OpenAI-compatible endpoint — which is what our relay is —
 * rejects a function name that does not match `^[a-zA-Z0-9_-]{1,64}$`, and it
 * rejects the whole request, so one bad member name would break every turn of
 * that session rather than just that delegation. Sanitising, capping, and
 * de-duplicating here is what keeps a member id we did not choose from
 * reaching that check.
 *
 * A hyphen becomes an underscore even though the wire would accept it, and that
 * is not cosmetic: `market/persona-rules.ts` rewrites a persona's own dispatch
 * mandates into tool names with the same substitution, and the build path names
 * its rows that way. Keeping `video-editor` as it stands would register
 * `delegate_video-editor` beside a persona telling the lead to call
 * `delegate_video_editor` — a team whose every delegation fails on a tool that
 * is not there. Caught by the two-path test, not by reading either side alone.
 * @param memberId - the member id from the archive.
 * @param taken - names already used in this composition; added to.
 */
function delegateToolName(memberId: string, taken: Set<string>): string {
  const base = `delegate_${memberId}`.replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 64)
  return unique(base === 'delegate_' ? 'delegate' : base, taken)
}

/**
 * Claim `base`, or the first `base_2`, `base_3`, … that is still free.
 *
 * The suffix eats into the base rather than extending past 64 characters, so a
 * long id cannot produce a name the wire rejects.
 * @param base - preferred name.
 * @param taken - names already claimed; the returned one is added.
 * @param separator - joins the suffix; `-` keeps a row id inside the kebab
 * alphabet the shipped rows use, `_` suits a model-facing tool name.
 */
function unique(base: string, taken: Set<string>, separator = '_'): string {
  let name = base
  for (let suffix = 2; taken.has(name); suffix += 1) {
    const tail = `${separator}${suffix}`
    name = `${base.slice(0, 64 - tail.length)}${tail}`
  }
  taken.add(name)
  return name
}

/** A row id fragment: the kernel's own preset-id alphabet, which is stricter. */
function slugify(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'member'
}

/**
 * Emit arbitrary text as a YAML literal block scalar.
 *
 * `|-` keeps every line as written and drops the trailing newline, which is
 * what a persona wants: it is a document, not a value with meaningful trailing
 * whitespace. Three normalisations make the result independent of what the
 * text happens to contain:
 *
 * - CRLF becomes LF. A block scalar's line breaks are normalised by the parser
 *   anyway, and leaving CR in would put a stray character at the end of every
 *   line of the prompt.
 * - Leading blank lines and indentation on the first line are dropped. A block
 *   scalar whose first content line is indented needs an explicit indentation
 *   indicator, and personas start with `---` frontmatter, so trimming the
 *   front costs nothing and removes the case.
 * - Blank lines stay truly blank rather than becoming lines of spaces, so the
 *   emitted file has no trailing whitespace.
 * @param text - the text to embed.
 * @param indent - column the content is indented to.
 */
function blockScalar(text: string, indent: number): string {
  const pad = ' '.repeat(indent)
  const body = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n').replace(/^[\s]+/, '')
  const lines = body.replace(/\s+$/, '').split('\n')
  return ['|-', ...lines.map(line => (line.trim() === '' ? '' : `${pad}${line}`))].join('\n')
}
