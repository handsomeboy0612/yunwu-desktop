/**
 * Product identity on the served Web surface.
 *
 * Upstream bakes the DeepSeek Harness identity into the prebuilt frontend: the
 * `<title>` in `dsh-web-frontend/dist/index.html` and the `BrandWordmark` svg
 * exported by the platform module layer. Neither takes configuration, and the
 * sidebar shell owns its brand row outright — `sidebar.workspaces`,
 * `sidebar.settings`, and `sidebar.footer.action` are the only holes it
 * declares — so there is no row to register a wordmark into.
 *
 * What the kernel does offer is `webServer.tapIndex`: a pure html-to-html
 * transform the dist server applies to every index response. The title is the
 * whole native surface too, because the compatibility window follows
 * `document.title`, and the frontend derives its per-session titles from
 * whatever the document already says (`useRef(document.title)`). Rewriting the
 * served markup therefore fixes the taskbar, the titlebar, and the session
 * titles in one place. The brand row art is a stylesheet, in the client bundle.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { BRAND_MARK_ROUTE, WINDOW_TITLE } from './brand.ts'

const TITLE_ELEMENT = /<title>[^<]*<\/title>/iu

/**
 * Rewrite the served index document to this product's identity.
 * @param html - the index.html body as the dist server read it.
 * @returns the body with our title in place of the upstream one.
 */
export function brandIndexHtml(html: string): string {
  return html.replace(TITLE_ELEMENT, `<title>${WINDOW_TITLE}</title>`)
}

/**
 * Serve the brand mark and brand the index document.
 * @param ctx - Host context carrying the Web carrier.
 */
export function installWebBrand(ctx: Context): void {
  const markPath = fileURLToPath(new URL('../build/openlux-mark.png', import.meta.url))
  const mark = readFileSync(markPath)
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: BRAND_MARK_ROUTE,
      handler: (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { allow: 'GET, HEAD' })
          res.end()
          return
        }
        res.writeHead(200, {
          'content-type': 'image/png',
          'content-length': String(mark.byteLength),
          // The renderer reloads far more often than this file changes, and the
          // asset ships inside the application: a revalidation on a loopback
          // socket costs less than a stale wordmark after an update.
          'cache-control': 'no-cache',
        })
        res.end(req.method === 'HEAD' ? undefined : mark)
      },
    }),
    'dsh-plugin-desktop: brand mark route',
  )
  ctx.effect(
    () => ctx.webServer.tapIndex(brandIndexHtml),
    'dsh-plugin-desktop: index document brand',
  )
}
