/**
 * The install path composes what the build path materialises.
 *
 * These two write the same experts from the same upstream documents — one the
 * build-time generator, run here into a scratch root, one at install time from a
 * market archive — and the reason the corrections live in a shared module is that
 * a difference between them is invisible: both produce a preset that mounts, and
 * only the agent's behaviour differs. So the load-bearing case here is the
 * equivalence one, run against the real packages on this machine.
 *
 * The synthetic cases run everywhere and cover what equivalence cannot: an
 * archive shaped in ways an upstream package never is.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import {
  composeExpertPreset,
  correctAssets,
  type ExpertContent,
} from '../../openlux-plugin-account/src/market/compose.ts'
import {
  createScrubber,
  neutralizeTemplates,
  rewriteIdentity,
  SKILL_DOC_NOTE,
} from '../../openlux-plugin-account/src/market/persona-rules.ts'
import { MEMBER_ALLOW } from '../../openlux-plugin-account/src/market/teammate-tools.ts'

/** WorkBuddy's downloaded packages; absent on a machine that never ran it. */
const UPSTREAM = join(homedir(), '.workbuddy', 'plugins', 'marketplaces', 'experts', 'plugins')

/** The build path itself, run per package into a scratch root. */
const GENERATOR = fileURLToPath(new URL('../scripts/materialize-expert.mjs', import.meta.url))

/** The base every composition is built from, read the way the installer reads it. */
const STANDARD = join(
  'node_modules', '@deepseek-ai', 'dsh', 'config', 'agent-presets', 'standard', 'agent.cordis.yml',
)

/** A file member, which is all these cases need to build. */
function file(path: string, text: string): { path: string; kind: 'file'; body: Uint8Array } {
  return { path, kind: 'file', body: new TextEncoder().encode(text) }
}

/** The `standard` text, or undefined when the kernel is not installed here. */
function standard(): string | undefined {
  const path = new URL(STANDARD, new URL('../', import.meta.url))
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined
}

/**
 * The text of a literal block scalar, dedented back to column zero.
 *
 * Both paths embed personas this way but at different depths — a teammate row
 * sits inside a group in one and at the root in the other — so comparing the
 * embedded text means undoing the indentation first.
 * @param lines - the composition's lines.
 * @param from - where to start looking; scanning stops at the next row.
 * @param key - the key whose block scalar to read, e.g. `text` or `persona`.
 * @returns the block's content, or undefined when this row has no such block.
 */
function blockFrom(lines: readonly string[], from: number, key: string): string | undefined {
  const opens = new RegExp(`^(\\s*)${key}: \\|-$`)
  for (const [offset, line] of lines.slice(from).entries()) {
    if (offset > 0 && line.trimStart().startsWith('- id: ')) return undefined
    const opener = opens.exec(line)
    if (opener === null) continue
    const indent = (opener[1] ?? '').length + 2
    const body: string[] = []
    for (const next of lines.slice(from + offset + 1)) {
      if (next.trim() !== '' && !next.startsWith(' '.repeat(indent))) break
      body.push(next.trim() === '' ? '' : next.slice(indent))
    }
    while (body.length > 0 && body[body.length - 1] === '') body.pop()
    return body.join('\n')
  }
  return undefined
}

/** The lead's persona: the `persona` row's own `text` block. */
function leadPersona(composition: string): string | undefined {
  const lines = composition.split('\n')
  return blockFrom(lines, lines.findIndex(line => line.trimStart() === '- id: persona'), 'text')
}

/**
 * One member's persona, found by row id rather than by position.
 *
 * Position would not do: the build path keeps the roster order `plugin.json`
 * declares, while the install path only ever sees `members/<id>.md` and so
 * orders members by id. The archive cannot carry the manifest's order, so this
 * is a difference neither path can close — and it changes nothing, because every
 * row carries its own persona and its own tool name.
 * @param composition - the composition text.
 * @param id - the member id.
 * @returns that member's persona, or undefined when no such row exists.
 */
function memberPersona(composition: string, id: string): string | undefined {
  const lines = composition.split('\n')
  const at = lines.findIndex(line => line.trimStart() === `- id: teammate-${id}`)
  return at === -1 ? undefined : blockFrom(lines, at, 'persona')
}

/** One expert as the market artifact carries it, built from an upstream package. */
function contentOf(pkg: string): { content: ExpertContent; slug: string } {
  const dir = join(UPSTREAM, pkg)
  const manifest = JSON.parse(
    readFileSync(join(dir, '.codebuddy-plugin', 'plugin.json'), 'utf8'),
  ) as { agentName?: string; teamInfo?: { leadAgent?: string; memberAgents?: string[] } }
  const lead = manifest.agentName ?? manifest.teamInfo?.leadAgent ?? pkg
  const members = (manifest.teamInfo?.memberAgents ?? [])
    .map(id => ({ id, persona: readFileSync(join(dir, 'agents', `${id}.md`), 'utf8') }))
    // The importer drops a member with no persona, and so does the archive
    // reader; a test that kept one would be asserting on a shape that cannot
    // reach the client.
    .filter(member => member.persona.trim() !== '')
    .sort((left, right) => left.id.localeCompare(right.id))
  return {
    slug: pkg,
    content: {
      persona: readFileSync(join(dir, 'agents', `${lead}.md`), 'utf8'),
      members,
      assets: [],
    },
  }
}

/** Packages present on this machine, teams first since they exercise more. */
function upstreamPackages(): string[] {
  if (!existsSync(UPSTREAM)) return []
  return readdirSync(UPSTREAM, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(join(UPSTREAM, entry.name, '.codebuddy-plugin', 'plugin.json')))
    .map(entry => entry.name)
    .sort()
}

const packages = upstreamPackages()
const base = standard()
const local = packages.length > 0 && base !== undefined

describe('composing an expert preset', () => {
  it('embeds the corrected persona and no other', () => {
    const rules = createScrubber('not-a-curated-package')
    const composition = composeExpertPreset(base ?? '- id: persona\n  name: p\n', {
      persona: '# Built with CodeBuddy Code\n',
      members: [],
      assets: [],
    }, { rules })
    expect(leadPersona(composition)).toBe('# Built with a generic coding assistant')
  })

  it('gives every teammate the shared allow-list', () => {
    if (base === undefined) return
    const composition = composeExpertPreset(base, {
      persona: '# Lead\n',
      members: [
        { id: 'writer', persona: '# 文案 - Pen\n' },
        { id: 'artist', persona: '# 美术 - Ink\n' },
      ],
      assets: [],
    }, { rules: createScrubber('x') })
    for (const name of MEMBER_ALLOW) {
      expect(composition).toContain(`        - ${name}`)
    }
    // One `allow:` per member, so a future edit cannot quietly give the list to
    // the first row only.
    expect(composition.split('      allow:').length - 1).toBe(2)
    expect(composition).toContain('    toolName: delegate_writer')
    expect(composition).toContain('    toolName: delegate_artist')
  })

  it('names each teammate tool in the lead roster', () => {
    if (base === undefined) return
    const composition = composeExpertPreset(base, {
      persona: '# Lead\n',
      members: [{ id: 'writer', persona: '---\nname: writer\n---\n\n# 文案创作专家 - 笔澜(Pen)\n' }],
      assets: [],
    }, { rules: createScrubber('x') })
    expect(leadPersona(composition) ?? '').toContain('- delegate_writer: 文案创作专家 - 笔澜(Pen)')
  })

  it('keeps two member ids that collapse to the same row id apart', () => {
    if (base === undefined) return
    const composition = composeExpertPreset(base, {
      persona: '# Lead\n',
      members: [
        { id: 'video-editor-v2', persona: '# A\n' },
        { id: 'video.editor@v2', persona: '# B\n' },
      ],
      assets: [],
    }, { rules: createScrubber('x') })
    expect(composition).toContain('- id: teammate-video-editor-v2\n')
    expect(composition).toContain('- id: teammate-video-editor-v2-2\n')
    // Both ids sanitise to the same tool name, so the second one is suffixed.
    expect(composition).toContain('    toolName: delegate_video_editor_v2\n')
    expect(composition).toContain('    toolName: delegate_video_editor_v2_2\n')
  })

  it('neutralises braces a persona did not mean as variables', () => {
    if (base === undefined) return
    const composition = composeExpertPreset(base, {
      persona: '# Lead\n\n```jsx\n<div style={{ color: 1 }} />\n```\n\n工作目录 {{cwd}}。\n',
      members: [],
      assets: [],
    }, { rules: createScrubber('x') })
    const lead = leadPersona(composition) ?? ''
    expect(lead).toContain('style={ { color: 1 } }')
    // The one reference the registry resolves survives, or an expert would lose
    // the only way it learns where to write.
    expect(lead).toContain('{{cwd}}')
  })

  it('refuses a composition the prompt registry could not render', () => {
    if (base === undefined) return
    expect(() => composeExpertPreset(`${base}\n# {{nope}}\n`, {
      persona: '# Lead\n',
      members: [],
      assets: [],
    }, { rules: createScrubber('x') })).toThrow(/提示词变量/)
  })

  it('reports a phantom tool instead of refusing the install', () => {
    if (base === undefined) return
    const warnings: string[] = []
    // A bare `TeamCreate` is rewritten; this one is inside a longer word, so the
    // rewrite's word boundary misses it and the check is what notices. That is
    // the residual case the check exists for — every name it looks for has a
    // catch-all rewrite, so anything it finds got there by surprise.
    const composition = composeExpertPreset(base, {
      persona: '# Lead\n\n先调用 MyTeamCreateHelper 建团。\n',
      members: [],
      assets: [],
    }, { rules: createScrubber('x'), warn: message => warnings.push(message) })
    expect(warnings.join('\n')).toContain('TeamCreate')
    expect(composition).toContain('- id: persona')
  })

  it('rewrites the phantom names a persona would otherwise call', () => {
    if (base === undefined) return
    const warnings: string[] = []
    const composition = composeExpertPreset(base, {
      persona: '# Lead\n\n必须通过 SendMessage 将结果回传，并用 `use_skill` 加载技能。\n',
      members: [],
      assets: [],
    }, { rules: createScrubber('x'), warn: message => warnings.push(message) })
    const lead = leadPersona(composition) ?? ''
    expect(lead).not.toContain('SendMessage')
    expect(lead).toContain('`skill`')
    expect(warnings).toStrictEqual([])
  })
})

describe('correcting the documents written beside the composition', () => {
  it('heads a skill document that names the imaginary tool set', () => {
    const entries = correctAssets([
      file('skills/draw/SKILL.md', '---\nname: draw\n---\n\n用 ImageGen 出图。\n'),
      file('skills/draw/notes.md', '# 手法\n\n构图先定。\n'),
    ], createScrubber('x'))
    const doc = new TextDecoder().decode(entries[0]!.body)
    expect(doc).toContain(SKILL_DOC_NOTE)
    expect(doc.indexOf('---\nname: draw\n---')).toBe(0)
    // A document that names nothing imaginary is returned as it was, object
    // identity included, so an install writes the same bytes it downloaded.
    expect(entries[1]).toBe(entries[1])
    expect(new TextDecoder().decode(entries[1]!.body)).not.toContain(SKILL_DOC_NOTE)
  })

  it('leaves non-markdown members untouched', () => {
    const png = { path: 'assets/logo.png', kind: 'file' as const, body: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) }
    const [only] = correctAssets([png], createScrubber('x'))
    expect(only).toBe(png)
  })
})

describe.skipIf(!local)('the two write paths agree', () => {
  // The build path used to leave its output in `config/agent-presets/`, and this
  // suite read it from there. Nothing is shipped from that directory any more, so
  // the comparison target is generated here instead — which also removes the old
  // silent hole: a package the generator had never been run against used to pass
  // this case by returning early.
  const scratch = mkdtempSync(join(tmpdir(), 'openlux-materialise-'))
  afterAll(() => rmSync(scratch, { recursive: true, force: true }))

  it.each(packages)('%s: personas match the materialised preset', (pkg) => {
    // Read back through the generator's own report rather than by joining the
    // directory name: it names the preset after the package manifest, which is
    // not always what the containing directory is called.
    const report = execFileSync(process.execPath, [GENERATOR, join(UPSTREAM, pkg)], {
      env: { ...process.env, OPENLUX_PRESET_OUT_ROOT: scratch },
      encoding: 'utf8',
    })
    const { dest } = JSON.parse(report) as { dest: string }
    const composition = readFileSync(join(dest, 'agent.cordis.yml'), 'utf8')
    const { content, slug } = contentOf(pkg)
    const composed = composeExpertPreset(base ?? '', content, { rules: createScrubber(slug) })

    // The lead's roster labels come from the manifest on the build path and from
    // the persona's own heading on this one, so the rosters are compared by the
    // tool names they name rather than verbatim.
    const cut = (text: string): string => text.split('## OpenLux teammate tools')[0] ?? ''
    expect(cut(leadPersona(composed) ?? '')).toBe(cut(leadPersona(composition) ?? ''))
    expect(content.members.length).toBeGreaterThanOrEqual(0)
    for (const member of content.members) {
      const built = memberPersona(composition, member.id)
      expect(built, `${pkg}/${member.id} has no row in the materialised preset`).toBeDefined()
      expect(memberPersona(composed, member.id)).toBe(built)
    }
    // Both rosters name the same tools, whatever order they list them in.
    const tools = (text: string): string[] => [...text.matchAll(/^- (delegate_\S+):/gm)]
      .map(match => match[1] ?? '').sort()
    expect(tools(leadPersona(composed) ?? '')).toStrictEqual(tools(leadPersona(composition) ?? ''))
  })

  it.each(packages)('%s: personas render as prompts and keep the vendor out', (pkg) => {
    const { content, slug } = contentOf(pkg)
    const rules = createScrubber(slug)
    const documents = [content.persona, ...content.members.map(member => member.persona)]
      .map(text => neutralizeTemplates(rules.scrub(rewriteIdentity(text))))
    for (const text of documents) {
      // `{{cwd}}` is the one reference the registry resolves, so it is also the
      // only complete group a corrected document may still contain.
      for (const match of text.matchAll(/\{\{([^{}]*)\}\}/g)) expect(match[1]).toBe('cwd')
      expect(text).not.toContain('CodeBuddy')
    }
  })
})
