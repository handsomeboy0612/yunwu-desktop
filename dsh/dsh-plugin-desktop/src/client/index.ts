import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type convergence only: locale/theme declarations expose settings slot rows.
// The desktop client does not load or register a settings surface.
// The sidebar and conversation declarations bring the brand seats' keys.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import { applyAdvancedShell } from './advanced-shell.ts'
import { startRendererBootReporter } from './boot-health.ts'
import { BRAND_PRIORITY, BrandMark, BrandName } from './Brand.tsx'
import { keepDocumentTitle } from './document-title.ts'
import { parseDesktopClientEnvironment } from './environment.ts'

export { applyAdvancedShell } from './advanced-shell.ts'
export { BRAND_PRIORITY, BrandMark, BrandName } from './Brand.tsx'
export { brandedTitle, keepDocumentTitle } from './document-title.ts'
export {
  RENDERER_BOOT_REPORT_PATH,
  rendererBootReport,
  sendRendererBootReport,
  startRendererBootReporter,
} from './boot-health.ts'
export type { RendererBootLoader, RendererBootReport } from './boot-health.ts'
export { parseDesktopClientEnvironment } from './environment.ts'
export type { DesktopClientEnvironment, DesktopClientMode, DesktopClientPlatform } from './environment.ts'

/** Services required by Desktop settings and advanced presentation. */
export const inject = [
  'slots',
  'sessions',
  'theme',
]

/** Register desktop-owned client surfaces for the current BrowserWindow mode. @param ctx - browser Cordis context. */
export function apply(ctx: ClientContext): void {
  const environment = parseDesktopClientEnvironment(window.location.search)
  if (!environment) return
  ctx.effect(
    () => startRendererBootReporter(ctx.loader),
    'dsh-plugin-desktop: renderer boot health report',
  )
  // The served title holds until a session is opened; after that the title is
  // the kernel's to write, and it writes upstream's name (`document-title.ts`).
  ctx.effect(() => keepDocumentTitle(), 'dsh-plugin-desktop: window title brand')
  // Both modes render the upstream sidebar and hero, so both seats are taken
  // here rather than inside the advanced branch. Each registration waits on its
  // slot: the declaring packages activate independently of this one.
  ctx.slots.inject('sidebar.brand.mark', () => ctx.slots.register({
    name: 'sidebar.brand.mark',
    priority: BRAND_PRIORITY,
  }, BrandMark))
  ctx.slots.inject('sidebar.brand.name', () => ctx.slots.register({
    name: 'sidebar.brand.name',
    priority: BRAND_PRIORITY,
  }, BrandName))
  ctx.slots.inject('conversation.hero.brand.mark', () => ctx.slots.register({
    name: 'conversation.hero.brand.mark',
    priority: BRAND_PRIORITY,
  }, BrandMark))
  if (environment.mode === 'advanced') applyAdvancedShell(ctx, environment)
}
