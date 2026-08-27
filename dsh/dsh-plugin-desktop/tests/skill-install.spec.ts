/**
 * Standalone skill installs, in the cases a real-machine run cannot show.
 *
 * The happy paths were driven through the running app on 2026-08-24 (gallery
 * install, local import, removal, and the model's own catalog picking a new
 * skill up mid-session), so what is left here is the shape of the refusals and
 * the two pieces of arithmetic that go wrong silently: which directory name a
 * skill lands under, and what the roster count is derived from. Everything runs
 * against a scratch `$DSH_HOME`, because the subject reads the kernel's own home
 * resolver rather than taking a root.
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  importLocalSkill, readSkillTarget, removeSkill, setSkillEnabled, skillRoot,
} from '../../openlux-plugin-account/src/market/skill-install.ts'

/**
 * The host context, as the subject sees it.
 *
 * Taken off the subject rather than imported from `@deepseek-ai/cordis`: this
 * package and the plugin each resolve their own copy of cordis, and two copies
 * of one structural type are two nominal types to the compiler — so importing
 * it here fails to assign for a reason that has nothing to do with the test.
 */
type Host = Parameters<typeof importLocalSkill>[0]

/** A context that only has to carry a logger. */
const ctx = { logger: { info: () => {} } } as unknown as Host

const roots: string[] = []
let home = ''
let previousHome: string | undefined

beforeEach(() => {
  previousHome = process.env.DSH_HOME
  home = mkdtempSync(join(tmpdir(), 'openlux-skill-'))
  roots.push(home)
  process.env.DSH_HOME = home
})

afterEach(() => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Write one skill directory on disk. */
function writeSkill(root: string, name: string, front: string, extra?: Record<string, string>): string {
  const directory = join(root, name)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'SKILL.md'), front, 'utf8')
  for (const [path, body] of Object.entries(extra ?? {})) {
    mkdirSync(join(directory, path, '..'), { recursive: true })
    writeFileSync(join(directory, path), body, 'utf8')
  }
  return directory
}

describe('skill root', () => {
  it('is the kernel user root, and an absent one reads as empty rather than failing', async () => {
    expect(skillRoot()).toBe(join(home, 'skills'))

    const target = await readSkillTarget()
    expect(target).toEqual({ root: join(home, 'skills'), installed: [] })
  })

  it('lists every skill in the root, not only the ones we installed', async () => {
    const root = skillRoot()
    writeSkill(root, 'ours', '---\nname: Ours\n---\n')
    writeFileSync(join(root, 'ours', 'openlux-market.json'),
      JSON.stringify({ itemId: 'ours', version: '1', installedAt: '2026-01-01T00:00:00.000Z' }), 'utf8')
    writeSkill(root, 'by-hand', '---\nname: By Hand\n---\n')
    // Neither of these is a skill: the provider looks for SKILL.md, and so does
    // the list the user is shown.
    mkdirSync(join(root, 'not-a-skill'), { recursive: true })
    mkdirSync(join(root, '.leftover'), { recursive: true })

    const target = await readSkillTarget()

    expect(target.installed).toEqual([
      { slug: 'by-hand', name: 'By Hand', managed: false, enabled: true },
      { slug: 'ours', name: 'Ours', managed: true, version: '1', enabled: true },
    ])
  })

  it('falls back to the directory name when the front matter cannot be read shallowly', async () => {
    const root = skillRoot()
    writeSkill(root, 'block-scalar', '---\nname: >-\n  Folded Name\n---\n')
    writeSkill(root, 'no-front-matter', '# Just a heading\n')
    writeSkill(root, 'quoted', '---\nname: "Quoted Name"\n---\n')

    const names = (await readSkillTarget()).installed.map(skill => `${skill.slug}=${skill.name}`)

    expect(names).toEqual([
      'block-scalar=block-scalar',
      'no-front-matter=no-front-matter',
      'quoted=Quoted Name',
    ])
  })
})

describe('local import', () => {
  it('lands the chosen directory itself, subtree and all, under its declared name', async () => {
    const source = writeSkill(mkdtempSync(join(tmpdir(), 'openlux-src-')), 'picked-folder',
      '---\nname: my-local-skill\n---\n', { 'references/notes.md': 'nested' })
    roots.push(join(source, '..'))

    const outcome = await importLocalSkill(ctx, source)

    expect(outcome).toEqual({
      kind: 'installed',
      id: 'my-local-skill',
      path: join(skillRoot(), 'my-local-skill'),
    })
    expect(readdirSync(join(skillRoot(), 'my-local-skill')).sort()).toEqual(['SKILL.md', 'references'])
    // A hand-picked directory is the user's own, so nothing marks it as ours.
    const installed = (await readSkillTarget()).installed
    expect(installed).toEqual([{ slug: 'my-local-skill', name: 'my-local-skill', managed: false, enabled: true }])
  })

  it('names the directory when the front matter does not, and refuses a name that cannot be one', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'openlux-src-'))
    roots.push(parent)
    const unnamed = writeSkill(parent, 'from-folder-name', '# no front matter\n')
    // Nothing here can become a directory name in the slug alphabet: not the
    // declared name, and not the folder it was picked from either.
    const unusable = writeSkill(parent, '\u4e2d\u6587\u76ee\u5f55',
      '---\nname: \u4e2d\u6587\u6280\u80fd\n---\n')

    expect(await importLocalSkill(ctx, unnamed)).toMatchObject({ kind: 'installed', id: 'from-folder-name' })
    expect(await importLocalSkill(ctx, unusable)).toMatchObject({ kind: 'refused', reason: 'invalid-id' })
  })

  it('refuses a directory that is not a skill, and refuses to overwrite one that is', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'openlux-src-'))
    roots.push(parent)
    const notSkill = join(parent, 'plain-folder')
    mkdirSync(notSkill, { recursive: true })
    writeFileSync(join(notSkill, 'readme.md'), 'hello', 'utf8')

    expect(await importLocalSkill(ctx, notSkill)).toMatchObject({ kind: 'refused', reason: 'bad-archive' })

    const twice = writeSkill(parent, 'twice', '---\nname: twice\n---\n')
    expect(await importLocalSkill(ctx, twice)).toMatchObject({ kind: 'installed' })
    expect(await importLocalSkill(ctx, twice)).toMatchObject({ kind: 'refused', reason: 'already-installed' })
    // The refusal is not a rollback of the first install.
    expect((await readSkillTarget()).installed).toHaveLength(1)
  })

  it('leaves nothing half-written behind when a second import refuses', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'openlux-src-'))
    roots.push(parent)
    const source = writeSkill(parent, 'clean-up', '---\nname: clean-up\n---\n')
    await importLocalSkill(ctx, source)
    await importLocalSkill(ctx, source)

    expect(readdirSync(skillRoot())).toEqual(['clean-up'])
  })
})

describe('removal', () => {
  it('removes one skill and refuses anything that is not a slug in the root', async () => {
    const root = skillRoot()
    writeSkill(root, 'goes', '---\nname: Goes\n---\n')
    writeSkill(root, 'stays', '---\nname: Stays\n---\n')

    expect(await removeSkill('../stays')).toBe(false)
    expect(await removeSkill('..')).toBe(false)
    expect(await removeSkill('nothing-here')).toBe(false)
    expect(await removeSkill('goes')).toBe(true)

    expect(readdirSync(root)).toEqual(['stays'])
  })
})

describe('enablement', () => {
  it('reads omitted invocation keys as enabled, and both close-keys as closed', async () => {
    const root = skillRoot()
    writeSkill(root, 'open', '---\nname: Open\n---\n')
    writeSkill(root, 'shut', '---\nname: Shut\nuser-invocable: false\ndisable-model-invocation: true\n---\n')
    writeSkill(root, 'yes-no', '---\nname: YesNo\nuser-invocable: yes\ndisable-model-invocation: false\n---\n')

    const bySlug = Object.fromEntries((await readSkillTarget()).installed.map(row => [row.slug, row.enabled]))
    expect(bySlug).toEqual({ open: true, shut: false, 'yes-no': true })
  })

  it('closes and reopens by writing the kernel invocation pair, without deleting the directory', async () => {
    const root = skillRoot()
    writeSkill(root, 'toggle-me', '---\nname: Toggle Me\ndescription: stays\n---\nbody\n')

    expect(await setSkillEnabled('toggle-me', false)).toBe(true)
    const closed = readFileSync(join(root, 'toggle-me', 'SKILL.md'), 'utf8')
    expect(closed).toContain('user-invocable: false')
    expect(closed).toContain('disable-model-invocation: true')
    expect(closed).toContain('description: stays')
    expect(closed).toMatch(/---\nbody/)
    expect((await readSkillTarget()).installed).toEqual([
      { slug: 'toggle-me', name: 'Toggle Me', managed: false, enabled: false },
    ])

    expect(await setSkillEnabled('toggle-me', true)).toBe(true)
    const opened = readFileSync(join(root, 'toggle-me', 'SKILL.md'), 'utf8')
    expect(opened).toContain('user-invocable: true')
    expect(opened).toContain('disable-model-invocation: false')
    expect((await readSkillTarget()).installed[0]?.enabled).toBe(true)
  })

  it('refuses a path that is not a slug in the root', async () => {
    expect(await setSkillEnabled('../etc', false)).toBe(false)
    expect(await setSkillEnabled('missing', true)).toBe(false)
  })
})
