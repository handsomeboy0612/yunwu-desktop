import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { BRAND_MARK_ROUTE, WINDOW_TITLE, WORDMARK_BADGE, WORDMARK_TEXT } from '../src/brand.ts'
import { brandedTitle } from '../src/client/document-title.ts'
import { brandIndexHtml } from '../src/web-brand.ts'

const require = createRequire(import.meta.url)
const indexPath = require.resolve('@deepseek-ai/dsh-web-frontend/dist/index.html')
const indexHtml = readFileSync(indexPath, 'utf8')

/** Read the client entry the desktop plugin registers its seats from. */
function clientSource(): string {
  return readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')
}

describe('served index document', () => {
  it('carries this product identity instead of the upstream one', () => {
    const branded = brandIndexHtml(indexHtml)

    expect(indexHtml).toContain('<title>DeepSeek Harness</title>')
    expect(branded).toContain(`<title>${WINDOW_TITLE}</title>`)
    expect(branded).not.toContain('DeepSeek Harness')
  })

  it('leaves the rest of the document to the frontend build', () => {
    const branded = brandIndexHtml(indexHtml)

    expect(branded.replace(`<title>${WINDOW_TITLE}</title>`, ''))
      .toBe(indexHtml.replace('<title>DeepSeek Harness</title>', ''))
  })
})

describe('window title once a session owns it', () => {
  // The served title only survives until a session is selected: from then on
  // the kernel writes `${session} · DeepSeek Harness` from a literal baked into
  // its published bundle, which is why this rewrite exists at all.
  it('keeps the session name and replaces the product name', () => {
    expect(brandedTitle(`会话标题 · DeepSeek Harness`)).toBe(`会话标题 · ${WINDOW_TITLE}`)
  })

  it('returns the same string when there is nothing to change', () => {
    // The observer writes only on a difference; an equal result is what stops
    // its own write from calling it again.
    const settled = `会话标题 · ${WINDOW_TITLE}`
    expect(brandedTitle(settled)).toBe(settled)
  })
})

describe('brand seats', () => {
  it('takes every seat the shell declares for brand art', () => {
    // The predecessor of this check read the frontend bundle for the art's
    // aspect boxes, because the rebrand was a stylesheet hooked onto them. It
    // passed through the rc.2 upgrade while the sidebar went back to saying
    // DeepSeek: upstream split mark from name, the name-only variant crops its
    // viewBox, and the full-size art the assertion looked for was still in the
    // bundle — just not what the sidebar drew. Registrations are checkable
    // without guessing what the art looks like, so that is what this reads.
    const client = clientSource()
    for (const seat of [
      'sidebar.brand.mark',
      'sidebar.brand.name',
      'conversation.hero.brand.mark',
    ]) {
      expect(client).toContain(`ctx.slots.inject('${seat}'`)
      expect(client).toContain(`name: '${seat}'`)
    }
  })

  it('claims the occupied seats by priority rather than by luck', () => {
    // The shipped pack (`dsh-client-ui-brand-official`) registers all three at
    // the default 0, and equal priority on a single slot throws. A positive
    // number would leave the official art rendering. Read as text rather than
    // imported: this project runs in the Node environment, and the module is a
    // component file.
    const component = readFileSync(new URL('../src/client/Brand.tsx', import.meta.url), 'utf8')
    const priority = /export const BRAND_PRIORITY = (-?\d+)/u.exec(component)?.[1]
    expect(priority).toBeDefined()
    expect(Number(priority)).toBeLessThan(0)
    expect(clientSource()).toContain('priority: BRAND_PRIORITY')
  })

  it('names the product rather than the upstream one', () => {
    // Two pieces, matching the art's own shape: a lettered name plus a filled
    // edition tag where upstream puts HARNESS.
    expect(WORDMARK_TEXT).toBe('OpenLux')
    expect(WORDMARK_BADGE).toBe('Agent')
    for (const word of [WORDMARK_TEXT, WORDMARK_BADGE, WINDOW_TITLE]) {
      expect(word).not.toMatch(/deepseek|harness/iu)
    }
    expect(BRAND_MARK_ROUTE).toBe('/openlux/brand-mark.png')
  })
})
