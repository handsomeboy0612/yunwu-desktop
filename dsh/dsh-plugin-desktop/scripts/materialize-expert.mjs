/**
 * Materialize one WorkBuddy expert package into a DSH agent-preset directory.
 * Content stays; the install shape is the kernel's: a preset directory, and a
 * team is one `dsh-tool-subagent` instance per member (distinct toolName,
 * per-child persona, per-child toolFilter). Do not parse agents/*.md at runtime.
 */
import { createRequire } from 'node:module'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(join(here, '../package.json'))
const STANDARD = join(
  dirname(require.resolve('@deepseek-ai/dsh/package.json')),
  'config',
  'agent-presets',
  'standard',
  'agent.cordis.yml',
)
const OUT_ROOT = join(here, '../config/agent-presets')

const PERSONA_OLD = `    text: >-
      You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.`

const SKILL_OLD = `- id: skill-filesystem
  name: '@deepseek-ai/dsh-skill-filesystem'`

const SKILL_NEW = `- id: skill-filesystem
  name: '@deepseek-ai/dsh-skill-filesystem'
  config:
    includeDefaultRoots: false
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

/** Portable allow-list: only tools the standard preset always registers. */
const MEMBER_ALLOW = ['skill', 'read', 'write', 'edit']

function yamlBlock(text, indent) {
  const pad = ' '.repeat(indent)
  return text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n').map((line) => pad + line).join('\n')
}

function rewriteIdentity(text) {
  return text
    .replaceAll('"CodeBuddy Code"', '"a generic coding assistant"')
    .replaceAll('"CodeBuddy"', '"a generic coding assistant"')
    .replaceAll('CodeBuddy Code', 'a generic coding assistant')
    .replaceAll('CodeBuddy', 'a generic coding assistant')
}

function loadPlugin(src) {
  return JSON.parse(readFileSync(join(src, '.codebuddy-plugin', 'plugin.json'), 'utf8'))
}

function toolNameFor(memberId) {
  const name = `delegate_${String(memberId).replace(/-/g, '_')}`
  if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error(`bad tool name ${name}`)
  return name
}

function memberMeta(plugin, id) {
  return (plugin.members ?? []).find((row) => row.id === id) ?? { id }
}

function labelOf(meta) {
  const name = meta.name?.zh || meta.name?.en || meta.id
  const job = meta.profession?.zh || meta.profession?.en
  return job ? `${name} / ${job}` : name
}

function leadWithRoster(plugin, memberIds, leadText) {
  const lines = [
    '',
    '## OpenLux teammate tools',
    'Delegate by calling these tools. Do not answer in a teammate\'s place.',
  ]
  for (const id of memberIds) {
    lines.push(`- ${toolNameFor(id)}: ${labelOf(memberMeta(plugin, id))}`)
  }
  return `${leadText.replace(/\n$/, '')}\n${lines.join('\n')}\n`
}

function memberRows(plugin, src, memberIds) {
  return memberIds.map((id) => {
    const persona = rewriteIdentity(readFileSync(join(src, 'agents', `${id}.md`), 'utf8'))
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

function applyTeamDelegation(composition, plugin, src, memberIds) {
  if (!composition.includes(GENERIC_DELEGATE)) throw new Error('generic delegate anchor missing')
  let next = composition.replace(GENERIC_DELEGATE, memberRows(plugin, src, memberIds))
  next = next.replace(
    `    - id: tool-ralph
      name: '@deepseek-ai/dsh-tool-ralph'`,
    `    - id: tool-ralph
      name: '@deepseek-ai/dsh-tool-ralph'
      disabled: true`,
  )
  next = next.replace(
    `    - id: tool-workflow
      name: '@deepseek-ai/dsh-tool-workflow'`,
    `    - id: tool-workflow
      name: '@deepseek-ai/dsh-tool-workflow'
      disabled: true`,
  )
  return next
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
  let persona = rewriteIdentity(readFileSync(join(src, 'agents', `${agentName}.md`), 'utf8'))
  if (isTeam) persona = leadWithRoster(plugin, memberIds, persona)

  let composition = readFileSync(STANDARD, 'utf8')
  if (!composition.includes(PERSONA_OLD)) throw new Error('persona anchor missing in standard preset')
  if (!composition.includes(SKILL_OLD)) throw new Error('skill-filesystem anchor missing in standard preset')
  composition = composition.replace(PERSONA_OLD, `    text: |-\n${yamlBlock(persona, 6)}`)
  composition = composition.replace(SKILL_OLD, SKILL_NEW)
  if (isTeam) composition = applyTeamDelegation(composition, plugin, src, memberIds)

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

  const skills = Array.isArray(plugin.skills) ? plugin.skills : []
  for (const rel of skills) {
    const from = join(src, rel.replace(/^\.\//, ''))
    const to = join(dest, 'skills', from.split(/[/\\]/).pop())
    cpSync(from, to, {
      recursive: true,
      filter: (p) => !p.includes(`${'\\'}__pycache__`) && !p.endsWith('.pyc'),
    })
  }
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
