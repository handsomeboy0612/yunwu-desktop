/**
 * OpenLux account plugin, browser half: sign-in as one entry in the shell's
 * first-run queue, the account row at the sidebar foot, the account page behind
 * it, and the market overlay launched from the same foot.
 *
 * The three account surfaces share one store, because each can change what the
 * others show — signing in from the step lights up the row, signing out from
 * the page brings the login page back. The market overlay has its own
 * open/closed store, shared by the launcher button and the frame-wide panel.
 *
 * ## How the foot is divided
 *
 * The foot has one action row and one Settings row, and the action row is a
 * single flex line shared by every entry in it. So the market launcher takes
 * the action row alone, and the account takes the Settings row's content by
 * shadowing the kernel's trigger at a lower priority — one full-width row each,
 * instead of two entries splitting one line. The balance detail then lives in
 * the account section, registered ahead of General so the panel opens on it.
 */

import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
// Type-only: merges the settings shell's slot rows, including
// 'settings.onboarding', into the SlotMap this file registers against.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: same, for the sidebar's 'sidebar.footer.action'.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
// Type-only: same, for the frame-wide 'shell.overlay'.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: merges the locale plugin's `ctx.locale`.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: same, for the tool tree's keyed 'tool.call.toolview'.
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
// Type-only: the rail's two types, for the face the file button is handed.
import type { ComposerAttachment, DraftAttachmentId } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ACCOUNT_SECTION_ID, ACCOUNT_SECTION_ORDER, AccountSection } from './AccountSection.tsx'
import type { AccountSectionInjected } from './AccountSection.tsx'
import { ACCOUNT_TRIGGER_PRIORITY, AccountTrigger } from './AccountTrigger.tsx'
import type { AccountTriggerInjected } from './AccountTrigger.tsx'
import { ATTACH_FILE_ID, ATTACH_FILE_ORDER, AttachFileButton } from './AttachFileButton.tsx'
import type { AttachFileInjected } from './AttachFileButton.tsx'
import { en as filesEn, zh as filesZh, type FilesKey } from './files-locales.ts'
import { callAccountHost } from './host.ts'
import { createImageLoaders } from './image-loader.ts'
import { ImageToolCard, type ImageCardInjected } from './ImageToolCard.tsx'
import { en, zh, type AccountKey } from './locales.ts'
import { en as marketEn, zh as marketZh, type MarketKey } from './market-locales.ts'
import { en as mediaEn, zh as mediaZh, type MediaKey } from './media-locales.ts'
import { IMAGE_SHOW_TOOL_NAME, IMAGE_TOOL_NAME } from '../media/name.ts'
import { MARKET_LAUNCHER_ID, MARKET_LAUNCHER_ORDER, MarketLauncher } from './MarketLauncher.tsx'
import { MARKET_OVERLAY_ID, MARKET_OVERLAY_ORDER, MarketOverlay } from './MarketOverlay.tsx'
import type { MarketOverlayInjected } from './MarketOverlay.tsx'
import { createMarketViewStore } from './market-view-store.ts'
import { modelChoice, watchModelChoice } from './selection.ts'
import { SIGN_IN_ORDER, SIGN_IN_STEP_ID, SignInStep } from './SignInStep.tsx'
import type { SignInStepInjected } from './SignInStep.tsx'
import { AccountStore } from './store.ts'
import { composerFor, SummonController, type SummonRequest } from './summon.ts'

export { ACCOUNT_SECTION_ID, AccountSection } from './AccountSection.tsx'
export type { AccountSectionInjected } from './AccountSection.tsx'
export { ACCOUNT_TRIGGER_ID, AccountTrigger } from './AccountTrigger.tsx'
export type { AccountTriggerInjected } from './AccountTrigger.tsx'
export { SIGN_IN_ID } from './SignInForm.tsx'
export { SIGN_IN_ORDER, SIGN_IN_STEP_ID, SignInStep } from './SignInStep.tsx'
export type { SignInStepInjected } from './SignInStep.tsx'
export { AccountStore } from './store.ts'
export type { AccountView, Balance, BalanceStatus } from './store.ts'
export type { AccountKey } from './locales.ts'
export type { AccountHostCaller } from './types.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Sign-in, challenge, and account-row copy. */
    'openlux.account': AccountKey
    /** Market gallery copy. */
    'openlux.market': MarketKey
    /** Image tool card copy, including the attachment atoms' labels. */
    'openlux.media': MediaKey
    /** The composer file button's copy. */
    'openlux.files': FilesKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'openlux.account'

/** The market overlay's own namespace; a launcher label is read outside the panel. */
const MARKET_NS = 'openlux.market'

/** The image card's own namespace. */
const MEDIA_NS = 'openlux.media'

/** The composer file button's own namespace. */
const FILES_NS = 'openlux.files'

/**
 * The conversation service in the two members the rail re-route needs.
 *
 * Narrowed by hand because the face the kernel publishes on `ctx.conversation`
 * is narrower still: `IConversation` is the send/cancel side, while the draft
 * image registry lives on the `ConversationController` that fills it. Reaching
 * the wider object is a cast either way; this states which two members the cast
 * is being made for.
 */
interface DraftImageFace {
  draftImages(ids: readonly DraftAttachmentId[]): readonly ComposerAttachment[]
  releaseDraftImage(id: DraftAttachmentId): void
}

/**
 * Required services. Both target slots are declared by other plugins whose
 * activation order relative to this one is not constrained, so each
 * registration waits on its slot through `slots.inject()`.
 */
export const inject = ['slots', 'connection', 'locale']

/**
 * Register the sign-in step, the sidebar account row, and the market overlay.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'openlux-account: copy dictionaries')
  ctx.effect(() => ctx.locale.register(MARKET_NS, { zh: marketZh, en: marketEn }), 'openlux-market: copy dictionaries')
  ctx.effect(() => ctx.locale.register(MEDIA_NS, { zh: mediaZh, en: mediaEn }), 'openlux-media: copy dictionaries')
  ctx.effect(() => ctx.locale.register(FILES_NS, { zh: filesZh, en: filesEn }), 'openlux-files: copy dictionaries')
  const marketText = ctx.locale.bind(MARKET_NS)

  const connection = ctx.get('connection') as ConnectionHandle
  const callHost: AccountSectionInjected['callHost'] =
    (method, args, signal) => callAccountHost(connection, method, args, signal)
  const store = new AccountStore(callHost)
  const useAccount = bindSnapshotSelector(store) as AccountSectionInjected['useAccount']
  // One bound translate for every face; copy freshness rides the locale
  // revision rather than a re-registration.
  const t = ctx.locale.bind(NS) as SignInStepInjected['t']

  ctx.slots.inject('settings.onboarding', () => ctx.slots.register({
    name: 'settings.onboarding',
    id: SIGN_IN_STEP_ID,
    order: SIGN_IN_ORDER,
    inject: (): SignInStepInjected => ({ callHost, t, store }),
  }, SignInStep))

  // The foot's bottom row: the kernel keeps the button and the click (it opens
  // the settings panel), we replace what the row says. Priority is the kernel's
  // own override knob for an occupied single slot; registering at its default 0
  // would throw instead.
  ctx.slots.inject('settings.trigger', () => ctx.slots.register({
    name: 'settings.trigger',
    priority: ACCOUNT_TRIGGER_PRIORITY,
    locale: NS,
    inject: (): AccountTriggerInjected => ({ t, store, useAccount }),
  }, AccountTrigger))

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: ACCOUNT_SECTION_ID,
    order: ACCOUNT_SECTION_ORDER,
    // A thunk rather than a string: the shell re-resolves nav labels on locale
    // change instead of subscribing to it (`ui-settings-general`).
    label: () => t('nav'),
    locale: NS,
    inject: (): AccountSectionInjected => ({ callHost, t, store, useAccount }),
  }, AccountSection))

  // Summoning needs the session and workspace services: the binding is filled
  // while that scope lives, and the overlay simply offers install-only copy in
  // a composition that lacks them. Same shape as the kernel's own creator-draft
  // entry (`ui-agent-preset`).
  let summon: ((request: SummonRequest) => void) | undefined

  // The composer notice strip, reached the same way and for the same reason:
  // `sessions` is not in this plugin's own inject list, so touching `ctx.sessions`
  // outside a scope that has it throws. Left unfilled, a refusal still reaches
  // the button's own label — the strip is the louder of the two, not the only one.
  let notice: ((sessionId: SessionId, level: 'info' | 'error', text: string) => void) | undefined

  ctx.inject(['sessions'], (scope: ClientContext) => {
    scope.effect(() => {
      notice = (sessionId, level, text) => { composerFor(scope, sessionId)?.notify(level, text) }
      return () => { notice = undefined }
    }, 'openlux-files: composer notices')
  })

  // The rail's pictures, reached the same way: `conversation` is the root
  // singleton that owns the draft-image registry, and the input state carries
  // only ids. Left unfilled, the button simply never re-routes a rail — the
  // kernel's send-time refusal is then what the user gets, as before.
  let rail: DraftImageFace | undefined

  ctx.inject(['conversation'], (scope: ClientContext) => {
    scope.effect(() => {
      rail = scope.get('conversation') as unknown as DraftImageFace
      return () => { rail = undefined }
    }, 'openlux-files: rail pictures')
  })

  ctx.inject(['sessions', 'workspaces'], (scope: ClientContext) => {
    const controller = new SummonController(scope)
    scope.effect(() => {
      // The pick may predate the session that takes it: the workspace connect
      // either creates a blank session or reuses one, and nothing hands back
      // its id — so the request is applied by whoever sees the list change.
      const stop = scope.sessions.list.subscribe(() => { void controller.apply() })
      summon = (request: SummonRequest) => { controller.summon(request) }
      return () => {
        summon = undefined
        stop()
      }
    }, 'openlux-market: summon flow')
  })

  // The card's pictures are read over this plugin's own channel rather than the
  // session's, so the row needs nothing beyond the connection every other face
  // here already uses.
  const images = createImageLoaders(connection)
  ctx.effect(() => () => { images.dispose() }, 'openlux-media: image URLs')
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview',
    key: IMAGE_TOOL_NAME,
    locale: MEDIA_NS,
    inject: (): ImageCardInjected => ({ load: images.load, kind: 'generate' }),
  }, ImageToolCard))

  // The second name gets the same row: a shown picture and a generated one are
  // the same thing to a reader, and the slot is keyed by wire tool name, so
  // without this registration `image_show` would fall back to the generic row
  // and print its attachment references as JSON.
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview',
    key: IMAGE_SHOW_TOOL_NAME,
    locale: MEDIA_NS,
    inject: (): ImageCardInjected => ({ load: images.load, kind: 'show' }),
  }, ImageToolCard))

  // The composer's file button. The seat is the kernel's own place for a small
  // always-visible control beside the resident chrome, so the button sits with
  // the access-mode and plan controls rather than replacing anything.
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: ATTACH_FILE_ID,
    order: ATTACH_FILE_ORDER,
    locale: FILES_NS,
    // A strict session slot's inject receives the framework-resolved session id,
    // which is what routes a refusal to the composer the user is looking at.
    inject: (sessionId): AttachFileInjected => ({
      callHost,
      notify: (level, text) => { notice?.(sessionId, level, text) },
      selection: () => modelChoice(ctx, sessionId),
      watchSelection: listener => watchModelChoice(ctx, sessionId, listener),
      railImages: ids => rail?.draftImages(ids) ?? [],
      releaseRailImage: (id) => { rail?.releaseDraftImage(id) },
    }),
  }, AttachFileButton))

  const marketView = createMarketViewStore()
  const marketFace = (): MarketOverlayInjected => ({
    callHost,
    language: () => (ctx.locale.getSnapshot().active === 'en' ? 'en' : 'zh'),
    ...summon === undefined ? {} : { summon },
  })

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: MARKET_LAUNCHER_ID,
    order: MARKET_LAUNCHER_ORDER,
    label: () => marketText('nav'),
    locale: MARKET_NS,
    store: marketView,
  }, MarketLauncher))

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: MARKET_OVERLAY_ID,
    order: MARKET_OVERLAY_ORDER,
    locale: MARKET_NS,
    store: marketView,
    inject: marketFace,
  }, MarketOverlay))
}
