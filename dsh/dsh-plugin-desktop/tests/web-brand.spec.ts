import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WINDOW_TITLE } from '../src/brand.ts'
import { BRAND_STYLES, FISH_VIEW_BOX, WORDMARK_VIEW_BOX } from '../src/client/brand-styles.ts'
import { brandIndexHtml } from '../src/web-brand.ts'

const require = createRequire(import.meta.url)
const indexPath = require.resolve('@deepseek-ai/dsh-web-frontend/dist/index.html')
const indexHtml = readFileSync(indexPath, 'utf8')

/** Read the frontend entry chunk the served index actually loads. */
function platformBundle(): string {
  const entry = /<script[^>]+src="(\/assets\/[^"]+\.js)"/u.exec(indexHtml)?.[1]
  if (entry === undefined) throw new Error(`no module entry in ${indexPath}`)
  return readFileSync(join(dirname(indexPath), entry), 'utf8')
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

describe('brand row stylesheet', () => {
  it('hooks onto art the shipped frontend still draws', () => {
    // The stylesheet is the whole rebrand of the two pieces of upstream brand
    // art, and it hangs off their declared aspect boxes. If a frontend bump
    // redraws either one, this fails here rather than quietly putting DeepSeek
    // back in the sidebar and the new-session view.
    const bundle = platformBundle()
    for (const viewBox of [WORDMARK_VIEW_BOX, FISH_VIEW_BOX]) {
      expect(bundle).toContain(viewBox)
      expect(BRAND_STYLES).toContain(`svg[viewBox="${viewBox}"]`)
    }
  })

  it('draws the mark from the route the Host serves', () => {
    expect(BRAND_STYLES).toContain('url("/openlux/brand-mark.png")')
    expect(BRAND_STYLES).toContain(`content: "${WINDOW_TITLE}"`)
  })
})
