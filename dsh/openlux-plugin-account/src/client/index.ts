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
// No `bindSnapshotSelector` import: rc.2 deleted `dsh-client-web-react` and the
// binder moved inside the renderer without an export. A plugin now hands the
// bare store over in a `hooks` compartment and the renderer binds it into a
// `use<Name>` selector before the component sees it.
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
// Type-only: merges the trigger registry's `ctx.inputTriggers`, which owns the
// file-reference source registered below.
import type {} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
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
import {
  HiddenPresetRow, HiddenPresetSection, PRESET_ROW_ID, PRESET_ROW_ORDER, PRESET_ROW_PRIORITY,
  PRESET_SECTION_ID, PRESET_SECTION_ORDER, PRESET_SECTION_PRIORITY,
} from './HiddenPresetSeats.tsx'
import { PRESET_CHIP_PRIORITY, PresetChip } from './PresetChip.tsx'
import type { PresetChipInjected } from './PresetChip.tsx'
import { PRESET_SETTINGS_NS, PresetRoster } from './preset-roster.ts'
import { modelChoice, watchModelChoice } from './selection.ts'
import { SIGN_IN_ORDER, SIGN_IN_STEP_ID, SignInStep } from './SignInStep.tsx'
import type { SignInStepInjected } from './SignInStep.tsx'
import { AccountStore } from './store.ts'
import { composerFor, SummonController, type SummonRequest } from './summon.ts'
import { appendFileReference, fileReferenceSource } from './file-reference.ts'
import { installFileChipStyle } from './file-chip-style.ts'
import { installFooterRowStyle } from './footer-row-style.ts'

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
    inject: (): AccountTriggerInjected => ({ t, store, hooks: { account: store } }),
  }, AccountTrigger))

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: ACCOUNT_SECTION_ID,
    order: ACCOUNT_SECTION_ORDER,
    // A thunk rather than a string: the shell re-resolves nav labels on locale
    // change instead of subscribing to it (`ui-settings-general`).
    label: () => t('nav'),
    locale: NS,
    inject: (): AccountSectionInjected => ({ callHost, t, store, hooks: { account: store } }),
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

  // The chip verb rides along on the same scope, because it is the same face:
  // an attachment shows up as one inline reference over the draft rather than a
  // path in prose (`file-reference.ts`). Unfilled, the button writes the path
  // as it always did — which is also what a failed CAS falls back to, so the
  // two paths are the same code either way.
  let attach: ((sessionId: SessionId, path: string) => boolean) | undefined

  ctx.inject(['sessions'], (scope: ClientContext) => {
    scope.effect(() => {
      notice = (sessionId, level, text) => { composerFor(scope, sessionId)?.notify(level, text) }
      attach = (sessionId, path) => appendFileReference(composerFor(scope, sessionId), path)
      return () => {
        notice = undefined
        attach = undefined
      }
    }, 'openlux-files: composer notices')
  })

  // Serialization owner for those chips: at submit time each occurrence's range
  // is replaced by *its own source's* model form, and an occurrence whose source
  // is not registered blocks the send instead of degrading
  // (`ui-input-trigger`'s `serializeReference`). So this registration is not
  // decoration — it is what turns `@deck_342.pptx` back into the absolute path
  // the model can open.
  ctx.inject(['inputTriggers'], (scope: ClientContext) => {
    scope.effect(() => scope.inputTriggers.registerSource(fileReferenceSource), 'openlux-files: file reference source')
  })

  // And the pill they are drawn as. Attribute selectors over the mirror layer,
  // which is all that layer can carry (`file-chip-style.ts` measures why).
  ctx.effect(() => installFileChipStyle(), 'openlux-files: file chip style')

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
      reference: path => attach?.(sessionId, path) ?? false,
      selection: () => modelChoice(ctx, sessionId),
      watchSelection: listener => watchModelChoice(ctx, sessionId, listener),
      railImages: ids => rail?.draftImages(ids) ?? [],
      releaseRailImage: (id) => { rail?.releaseDraftImage(id) },
    }),
  }, AttachFileButton))

  // The hero's preset seat. The kernel's own occupant is a dropdown of every
  // composition the deployment has, which puts `标准模式` / `PTC模式` /
  // `创造模式` in front of the user as if they were a question; those three are
  // how this product is assembled. So this registration takes the seat at a
  // lower priority — the kernel's documented override knob for an occupied
  // single slot, the same one the account row uses — and draws WorkBuddy's
  // shape instead: nothing at all on the default, one dismissible chip when a
  // summoned expert is running (`PresetChip.tsx` cites both sides).
  const roster = new PresetRoster(connection)

  // The roster's default can move under us — writing it is a settings write, not
  // a preset call, so nothing in the roster RPC reports it. The chip's whole rule
  // is «say nothing on the default», so a stale default makes it name a preset
  // the user is already on. The kernel's own seat solves this by listening to the
  // host's settings broadcast for exactly this namespace, and this is that same
  // subscription (`ui-agent-preset`: `remote.$on('settings/document-updated')`
  // filtered to `agent-presets`, then `seat.load()`).
  ctx.inject(['remote'], (scope: ClientContext) => {
    scope.effect(
      () => scope.remote.$on('settings/document-updated', ns => {
        if (ns !== PRESET_SETTINGS_NS) return
        void roster.load()
      }),
      'openlux-market: roster follows the default',
    )
  })

  ctx.slots.inject('conversation.hero.agentPreset', () => ctx.slots.register({
    name: 'conversation.hero.agentPreset',
    priority: PRESET_CHIP_PRIORITY,
    locale: MARKET_NS,
    inject: (): PresetChipInjected => ({
      hooks: { presetRoster: roster },
      read: () => { void roster.load() },
      clear: (sessionId) => { void backToDefault(sessionId) },
    }),
  }, PresetChip))

  /**
   * Take one session off its expert and back onto the default composition.
   * @param sessionId - the session the chip was drawn for.
   * @returns once the switch settled, or its refusal reached the composer.
   */
  async function backToDefault(sessionId: SessionId): Promise<void> {
    const refused = await roster.clear(sessionId)
    // The kernel refuses a session that has already run a turn. The chip only
    // exists on the new-session screen, so this is a race (a turn started while
    // the pointer was travelling) rather than a shape the user can aim at.
    if (refused !== undefined) notice?.(sessionId, 'error', refused)
  }

  const marketView = createMarketViewStore()

  // The two settings seats that exposed Agent presets, taken and left blank —
  // no page, no nav row, no way to change the default. `HiddenPresetSeats.tsx`
  // carries the reasoning; publishing no `label` is what keeps the nav quiet.
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: PRESET_SECTION_ID,
    order: PRESET_SECTION_ORDER,
    priority: PRESET_SECTION_PRIORITY,
  }, HiddenPresetSection))
  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: PRESET_ROW_ID,
    order: PRESET_ROW_ORDER,
    priority: PRESET_ROW_PRIORITY,
  }, HiddenPresetRow))

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

  // The foot is a single nowrap row upstream, and the cordis dock joins it
  // whenever a session registers a plugin — which an authoring session does.
  ctx.effect(() => installFooterRowStyle(), 'openlux-market: footer row')

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: MARKET_OVERLAY_ID,
    order: MARKET_OVERLAY_ORDER,
    locale: MARKET_NS,
    store: marketView,
    inject: marketFace,
  }, MarketOverlay))
}
