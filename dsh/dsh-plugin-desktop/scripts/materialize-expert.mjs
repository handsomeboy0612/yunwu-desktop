/**
 * Materialize one WorkBuddy expert package into a DSH agent-preset directory.
 * Content stays; the install shape is the kernel's: a preset directory, and a
 * team is one `dsh-tool-subagent` instance per member (distinct toolName,
 * per-child persona, per-child toolFilter). Do not parse agents/*.md at runtime.
 */
import { createRequire } from 'node:module'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
// The rules are shared with the install path, and they live on that side because
// a shipped module can be imported by a build script but not the other way round
// (`openlux-plugin-account/src/market/persona-rules.ts` says what belongs there).
// Imported as source rather than through the package's build output, so that
// regenerating presets never depends on having built the plugin first; node
// strips the types, and that file is written to hold nothing else.
import {
  createScrubber,
  FABRICATED_NAMES,
  findPhantomTools,
  neutralizeTemplates,
  rewriteIdentity,
  templateVarNames,
  unknownTemplateVars,
  withSkillDocNote,
} from '../../openlux-plugin-account/src/market/persona-rules.ts'
// Shared for the same reason, and one step further: this one decides what a
// teammate can call, so the two paths differing would mean the market copy of a
// team is a different agent than the one in the box.
import { MEMBER_ALLOW, withTeammateRoster } from '../../openlux-plugin-account/src/market/teammate-tools.ts'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(join(here, '../package.json'))
const STANDARD = join(
  dirname(require.resolve('@deepseek-ai/dsh/package.json')),
  'config',
  'agent-presets',
  'standard',
  'agent.cordis.yml',
)
// Nothing is shipped from `config/agent-presets` any more — every expert arrives
// from the market — so the default output is a scratch directory a human can look
// at, and the equivalence test in `tests/market-compose.spec.ts` points this at a
// temporary root to compare the two write paths without leaving anything behind.
const OUT_ROOT = process.env.OPENLUX_PRESET_OUT_ROOT ?? join(here, '../config/agent-presets')

const PERSONA_OLD = `    text: >-
      You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.`

const SKILL_OLD = `- id: skill-filesystem
  name: '@deepseek-ai/dsh-skill-filesystem'`

/**
 * Add this preset's own `skills/` as a root, verbatim from the kernel's shipped
 * `cordis` preset (`@deepseek-ai/dsh/config/agent-presets/cordis`).
 *
 * `includeDefaultRoots` is left at its default of `true`, which took a correction:
 * this script used to set it to `false`. The kernel's own preset is the answer to
 * exactly this situation — it ships skills of its own and still only ADDS a root
 * — and the install path had already read it that way. What `false` actually
 * suppresses is `<cwd>/.dsh/skills`, `~/.dsh/skills` and their `.agents`
 * siblings: the user's own skills and the project's, not some pile of ours. Both
 * home roots are absent on this machine and `DSH_BUNDLED_SKILL_DIR` is unset, so
 * it was isolating an expert from nothing while guaranteeing that a skill the
 * user writes stops working the moment they summon one.
 */
const SKILL_NEW = `- id: skill-filesystem
  name: '@deepseek-ai/dsh-skill-filesystem'
  config:
    customSkillDirs:
      - !!js "process.getBuiltinModule('node:url').fileURLToPath(new URL('skills/', baseUrl))"`

const GENERIC_DELEGATE = `    - id: tool-subagent
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: spawn
        toolName: subagent
        backgroundMode: continuable

    - id: tool-subagent-fork
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: fork
        toolName: subagent_fork
        backgroundMode: continuable`

/**
 * ## Where the tool-reality paragraph went
 *
 * Three variants of it used to be inserted here, into every persona this script
 * writes. It is now one globally registered system-prompt section —
 * `openlux-plugin-account/src/persona/tool-reality.ts` — that derives its own
 * tool list from the assembly it is about to be part of.
 *
 * That was not a cleanup. A paragraph written into a document is a snapshot: it
 * claimed a tool set on the day it was generated, for an agent whose visible
 * tools are decided later by a `toolFilter` and by whatever this build registers.
 * Both reference implementations keep this half at runtime and neither writes it
 * into the package — WorkBuddy ships `rules/<name>_rules.md` with
 * `alwaysApply: true` beside an untouched expert, Claude Code installs a
 * plugin's agents verbatim and enforces their declared tools from the host — and
 * the kernel offers the same shape, verified reaching a plain agent, a lead and
 * a delegated member.
 *
 * What stays in this script is what is wrong *in the prose*, which no runtime
 * layer can reach: {@link MECHANICAL_REWRITES} and {@link FABRICATION_FIXES}.
 * The two facts worth their evidence — naming the working directory, and a
 * member's pictures reaching the user only as paths — kept that evidence,
 * carried into the module that now states them.
 */






/**
 * Fail the build if a document still tells an agent to call a tool we never
 * registered.
 *
 * The scan itself is shared with the install path, which only logs its findings
 * (see {@link findPhantomTools} for why the two severities differ). Here it is
 * fatal: these 22 packages are curated, so a mandate that survived every rewrite
 * means a rule needs writing, and there is a human standing at the build.
 * @param text - the materialized document.
 * @param label - what to name in the error.
 * @throws {Error} listing each phantom tool still present, with its line.
 */
function assertNoPhantomTools(text, label) {
  const bad = findPhantomTools(text, label)
  if (bad.length > 0) {
    throw new Error(`materialized preset still instructs agents to call tools that do not exist:\n${bad.join('\n')}`)
  }
}

/**
 * Refuse to write a preset the app would silently drop.
 *
 * This is the check that was missing, and its absence cost a whole team:
 * `mvp-dev-expert-team` was written with a `$&` splice through the middle of a
 * member persona, which parsed as a map with two `name:` keys. The picker showed
 * 18 presets instead of 19 and said nothing — a shape the roster rejects is not
 * an error to the user, it is an absence, and an absence is invisible. Parsing
 * here turns that into a build failure at the line that caused it.
 *
 * Row counting is the second half. A splice can land somewhere that still parses
 * — the anchor is a plugin row, so replacing it with mangled text yields fewer
 * teammates rather than invalid YAML — and a team missing a member is another
 * silent degradation: the lead's roster names somebody it cannot dispatch.
 * @param text - the materialized composition.
 * @param label - preset slug, for the error.
 * @param members - how many teammate rows this preset must have.
 * @throws {Error} on unparseable YAML, a wrong teammate count, or a template
 * variable the prompt registry does not know.
 */
function assertParses(text, label, members) {
  const { parse } = require('yaml')
  let doc
  try {
    doc = parse(text, { logLevel: 'silent' })
  } catch (error) {
    throw new Error(
      `${label}/agent.cordis.yml is not valid YAML, so the app would drop this preset without a message:\n`
      + `  ${String(error.message).split('\n')[0]}`,
    )
  }
  const rows = []
  const walk = (node) => {
    if (Array.isArray(node)) return void node.forEach(walk)
    if (!node || typeof node !== 'object') return
    if (typeof node.name === 'string') rows.push(node)
    Object.values(node).forEach(walk)
  }
  walk(doc)
  const teammates = rows.filter((row) => String(row.config?.toolName ?? '').startsWith('delegate_'))
  if (teammates.length !== members) {
    throw new Error(`${label}: expected ${String(members)} teammate rows, wrote ${String(teammates.length)}`)
  }
  const unknown = unknownTemplateVars(text)
  if (unknown.length > 0) {
    throw new Error(
      `${label}: prompt would fail to render — the registry resolves only ${templateVarNames().join(', ')}, `
      + `but the text asks for ${unknown.map((name) => `{{${name}}}`).join(', ')}`,
    )
  }
}

function yamlBlock(text, indent) {
  const pad = ' '.repeat(indent)
  return text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n').map((line) => pad + line).join('\n')
}

/**
 * Insert imported text into the composition without letting it be read as a
 * replacement pattern.
 *
 * `String.replace` interprets `$&`, `` $` ``, `$'` and `$1` in the *replacement*
 * string, and these personas are somebody else's prose containing somebody
 * else's code. `mvp-dev-expert-team`'s frontend member carries
 * `query.replace(/…/g, '\\$&')` inside a highlight snippet, so the plain form of
 * this call spliced the matched anchor — the whole generic `tool-subagent` row —
 * into the middle of that line. The result parsed as YAML with two `name:` keys
 * in one map, the roster's shape check rejected it, and the preset simply did
 * not appear in the picker: no error anywhere, just a team that does not exist.
 * A replacement function receives no `$` semantics at all.
 * @param text - the document being assembled.
 * @param anchor - the exact substring to replace.
 * @param value - literal text, inserted verbatim.
 * @returns the document with the anchor replaced.
 * @throws {Error} when the anchor is absent, which means the upstream standard
 * preset moved and the rest of this file is guessing.
 */
function spliceLiteral(text, anchor, value) {
  if (!text.includes(anchor)) throw new Error(`anchor missing: ${anchor.split('\n')[0].slice(0, 60)}…`)
  return text.replace(anchor, () => value)
}

function loadPlugin(src) {
  return JSON.parse(readFileSync(join(src, '.codebuddy-plugin', 'plugin.json'), 'utf8'))
}

/**
 * Read one agent document, tolerating a package whose `plugin.json` names it
 * wrong.
 *
 * Mirrors `admin-server/service/desktop_market/expert_bundle.go:361-384`, which
 * consumes these same packages and already learnt this: try the declared id,
 * then fall back to the only document under `agents/`. Two of the 421 published
 * packages need it — `executing-marketing-campaigns` ships no `agentName` at all
 * and its persona is `marketing-campaign-expert.md`. The fallback cannot pick
 * the wrong document for a team, because a team's `agents/` holds the lead plus
 * every member, so the count is never one.
 * @param src - the package directory.
 * @param agentName - the id `plugin.json` (or the manifest) declares.
 * @returns the document text.
 * @throws {Error} when neither the named file nor a single candidate exists.
 */
function agentDoc(src, agentName) {
  const dir = join(src, 'agents')
  const named = join(dir, `${agentName}.md`)
  if (existsSync(named)) return readFileSync(named, 'utf8')
  const candidates = readdirSync(dir).filter((name) => name.endsWith('.md'))
  if (candidates.length === 1) return readFileSync(join(dir, candidates[0]), 'utf8')
  throw new Error(
    `${src}: agents/${agentName}.md is missing and ${String(candidates.length)} documents are candidates`,
  )
}

/**
 * The skills this package actually ships, read off disk rather than out of
 * `plugin.json`.
 *
 * `plugin.json`'s `skills` array disagrees with the package in 12 of the 421
 * published bundles: 11 ship a skill it does not list (`equity-research`'s
 * `earnings-preview`, six teams' `*-playbook`) and `rum-fullstack-team` lists
 * `tencent-cloud-rum` while shipping `tencent-cloud-rum-zh-2.1`, which made the
 * whole team unmaterializable. The importer reads the bundle for exactly this
 * reason (`expert_bundle.go:436-455`), and requires a non-empty `SKILL.md`
 * (`:522-529`) — which is also what keeps a bare `skills/references/` directory
 * from being mistaken for a skill.
 * @param src - the package directory.
 * @returns directory names under `skills/`, sorted, each holding a real skill.
 */
function discoverSkills(src) {
  const dir = join(src, 'skills')
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => {
      const doc = join(dir, name, 'SKILL.md')
      return existsSync(doc) && readFileSync(doc, 'utf8').trim() !== ''
    })
    .sort()
}

function toolNameFor(memberId) {
  const name = `delegate_${String(memberId).replace(/-/g, '_')}`
  if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error(`bad tool name ${name}`)
  return name
}

/**
 * Every markdown file under a copied skill directory.
 * @param root - the destination skill directory.
 * @returns absolute paths, in no particular order.
 */
function markdownUnder(root) {
  const out = []
  for (const entry of readdirSync(root, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.endsWith('.md')) out.push(join(entry.parentPath, entry.name))
  }
  return out
}

function memberMeta(plugin, id) {
  return (plugin.members ?? []).find((row) => row.id === id) ?? { id }
}

function labelOf(meta) {
  const name = meta.name?.zh || meta.name?.en || meta.id
  const job = meta.profession?.zh || meta.profession?.en
  return job ? `${name} / ${job}` : name
}

/**
 * The lead's roster, with the labels only this path has.
 *
 * A package manifest is the best source for who a member is, and it is the one
 * thing the install path cannot read: the market artifact carries personas, not
 * `plugin.json`. So the block itself is shared and only the labels differ.
 * @param plugin - the package manifest.
 * @param memberIds - members in roster order.
 * @param leadText - the lead's corrected persona.
 * @returns the persona with the roster appended.
 */
function leadWithRoster(plugin, memberIds, leadText) {
  return withTeammateRoster(leadText, memberIds.map((id) => ({
    toolName: toolNameFor(id),
    label: labelOf(memberMeta(plugin, id)),
  })))
}

function memberRows(plugin, src, memberIds, scrub) {
  return memberIds.map((id) => {
    const persona = neutralizeTemplates(scrub(rewriteIdentity(agentDoc(src, id))))
    const allow = MEMBER_ALLOW.map((name) => `            - ${name}`).join('\n')
    return `    - id: teammate-${id}
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: spawn
        toolName: ${toolNameFor(id)}
        backgroundMode: one-shot
        enableRunInBackground: false
        maxDepth: 1
        persona: |-
${yamlBlock(persona, 10)}
        toolFilter:
          allow:
${allow}`
  }).join('\n\n')
}

/**
 * Turn the generic delegation rows into one row per member.
 *
 * `tool-ralph` and `tool-workflow` are left alone. An earlier version of this
 * function disabled both for teams, with no reason in the code and none in the
 * migration document, while the install path had already ruled on the same class
 * of edit and gone the other way: it keeps the generic `subagent` rows because
 * "removing them would mean editing rows the kernel owns for a benefit nobody
 * asked for" (`openlux-plugin-account/src/market/compose.ts`). Two paths that
 * write the same team cannot hold opposite rules, and between an undocumented
 * restriction and a documented restraint the restraint wins: a leader that can
 * also loop or run a workflow is the kernel's own default.
 * @param composition - the base composition text.
 * @param plugin - the package manifest, for member labels.
 * @param src - the package directory.
 * @param memberIds - members in roster order.
 * @param scrub - the package's document corrections.
 * @returns the composition with teammate rows in place of the generic ones.
 */
function applyTeamDelegation(composition, plugin, src, memberIds, scrub) {
  return spliceLiteral(composition, GENERIC_DELEGATE, memberRows(plugin, src, memberIds, scrub))
}

export function materializeExpert(src, { id, order = 20, outRoot = OUT_ROOT } = {}) {
  const plugin = loadPlugin(src)
  const slug = id ?? String(plugin.name)
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    throw new Error(`preset id ${slug} is not [a-z0-9][a-z0-9-]*`)
  }
  const isTeam = plugin.expertType === 'team'
  const memberIds = isTeam ? [...(plugin.teamInfo?.memberAgents ?? [])] : []
  const agentName = plugin.agentName ?? plugin.teamInfo?.leadAgent ?? slug
  const scrubber = createScrubber(slug)
  const scrub = (text) => scrubber.scrub(text)
  let persona = scrub(rewriteIdentity(agentDoc(src, agentName)))
  if (isTeam) persona = leadWithRoster(plugin, memberIds, persona)
  persona = neutralizeTemplates(persona)

  let composition = readFileSync(STANDARD, 'utf8')
  composition = spliceLiteral(composition, PERSONA_OLD, `    text: |-\n${yamlBlock(persona, 6)}`)
  composition = spliceLiteral(composition, SKILL_OLD, SKILL_NEW)
  if (isTeam) composition = applyTeamDelegation(composition, plugin, src, memberIds, scrub)

  assertNoPhantomTools(composition, 'agent.cordis.yml')
  assertParses(composition, slug, memberIds.length)

  const dest = join(outRoot, slug)
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(join(dest, 'skills'), { recursive: true })
  writeFileSync(join(dest, 'agent.cordis.yml'), composition, 'utf8')
  const name = plugin.displayName?.zh || plugin.displayName?.en || slug
  const description = plugin.displayDescription?.zh || plugin.displayDescription?.en || plugin.description || ''
  writeFileSync(
    join(dest, 'preset.yml'),
    `name: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\norder: ${order}\n`,
    'utf8',
  )

  const skills = discoverSkills(src)
  for (const name of skills) {
    const from = join(src, 'skills', name)
    const to = join(dest, 'skills', name)
    cpSync(from, to, {
      recursive: true,
      filter: (p) => !p.includes(`${'\\'}__pycache__`) && !p.endsWith('.pyc'),
    })
    // The skill documents describe the same imaginary tool set as the personas,
    // and a member is allowed to read them, so they get the same treatment.
    for (const doc of markdownUnder(to)) {
      const original = readFileSync(doc, 'utf8')
      const fixed = scrub(original)
      // Only the documents that name the imaginary tool set get the header; the
      // rest are ordinary craft references and the note would just be noise.
      const scrubbed = FABRICATED_NAMES.test(original) ? withSkillDocNote(fixed) : fixed
      assertNoPhantomTools(scrubbed, doc.slice(dest.length + 1))
      if (scrubbed !== original) writeFileSync(doc, scrubbed, 'utf8')
    }
  }
  // Last, because a fix aimed at one document finds nothing in the others: only
  // after every document of this package has passed through is a rule stale.
  const stale = scrubber.staleReport()
  if (stale !== undefined) throw new Error(stale)
  return {
    dest,
    slug,
    name,
    skillCount: skills.length,
    team: isTeam,
    members: memberIds.map(toolNameFor),
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const src = process.argv[2]
  if (!src) {
    console.error('usage: node materialize-expert.mjs <workbuddy-expert-dir>')
    process.exit(1)
  }
  console.log(JSON.stringify(materializeExpert(src, { order: Number(process.argv[3]) || 20 }), null, 2))
}
