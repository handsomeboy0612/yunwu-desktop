/**
 * Keep this product's name in the window title after a session takes it over.
 *
 * `web-brand.ts` rewrites the served `<title>`, which is what the taskbar and
 * the empty-session window read. The moment a session is selected, though, the
 * kernel's `DocumentTitle` writes `${session} · ${productTitle}` — and that
 * `productTitle` is a literal baked into the published bundle
 * (`ui-renderer/lib/client.js`: `const productTitle = "DeepSeek Harness"`),
 * with no setting, no slot and no injected constant behind it. So the served
 * title is correct exactly until the user opens a conversation.
 *
 * Rather than patch that package, this watches the element it writes and puts
 * our name back. Cheap for what it is: the title changes only when the current
 * session changes, and the rewrite is skipped when nothing matched, so the
 * observer's own write cannot loop.
 *
 * @module dsh-plugin-desktop/client/document-title
 */

import { WINDOW_TITLE } from '../brand.ts'

/** The name upstream bakes in, as it appears in the rendered title. */
const UPSTREAM_TITLE = /DeepSeek Harness/gu

/**
 * This product's spelling of one window title.
 *
 * Returns the same string when there is nothing to change, which is what keeps
 * the observer below from answering its own write.
 * @param current - the title as it stands.
 * @returns the title this product should show.
 */
export function brandedTitle(current: string): string {
  return current.replace(UPSTREAM_TITLE, WINDOW_TITLE)
}

/**
 * Start keeping the title.
 * @returns the disposer; wrap the call in `ctx.effect`.
 */
export function keepDocumentTitle(): () => void {
  if (typeof document === 'undefined') return () => {}
  const rebrand = (): void => {
    const wanted = brandedTitle(document.title)
    if (wanted !== document.title) document.title = wanted
  }
  rebrand()
  // `head` rather than the title element: React replaces the text node, and a
  // document that somehow arrives without a `<title>` still gets one watched
  // when the kernel writes `document.title` and the browser creates it.
  const observer = new MutationObserver(rebrand)
  observer.observe(document.head, { childList: true, subtree: true, characterData: true })
  return () => { observer.disconnect() }
}
