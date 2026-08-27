/**
 * The composer's connector entry — WorkBuddy's capsule beside the «+».
 *
 * ## The result being reproduced
 *
 * After 「去对话」 lands a connector's example in the composer, WorkBuddy's
 * input row shows the connector itself: a small button carrying its icon
 * (`connector-capsule.tsx`), which is both the proof that the tools rode
 * along and the way back to managing them. Ours draws the same fact — the
 * icon of a connected connector beside the composer chrome — and a press
 * opens the market on the connector tab, where connect / disconnect / repair
 * already live. WorkBuddy's capsule opens its own dropdown menu instead;
 * that menu's acts are our market tab's acts, so the destination differs in
 * chrome, not in behaviour. The press travels through `market-open-request.ts`
 * because this seat cannot hold the overlay store's handle (one scope per
 * handle; the loader refused the plugin when this seat took it).
 *
 * ## Where the data comes from
 *
 * The connected rows are the market's own read (`market.connectors`),
 * shared through `connector-live.ts` so a connect done in the market shows
 * up here without a remount. Icons are not on the installed record — it is
 * a mount manifest, not a card — so they come from the connector catalog,
 * whose host read is ETag-cached and answers a repeat open with one empty
 * 304 (`market/content-cache.ts`).
 *
 * ## When it shows
 *
 * Only while at least one connector is recorded. The empty composer row is
 * the kernel's own chrome; an always-on button for a feature the user has
 * never touched would be the gallery advertising itself in every session.
 */

import { useEffect, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { Button, IconApiOutline14, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { Catalog, ConnectorTarget } from '../market/wire.ts'
import {
  connectorsLiveSnapshot, publishConnectorsLive, watchConnectorsLive,
} from './connector-live.ts'
import { requestMarketOpen } from './market-open-request.ts'
import type { AccountHostCaller } from './types.ts'

/** Slot id; also the DOM marker. */
export const CONNECTOR_CAPSULE_ID = 'openlux-connector-capsule'

/** Right after the file button (order 0), which is the row's own subject. */
export const CONNECTOR_CAPSULE_ORDER = 1

/** The business face this entry needs. */
export interface ConnectorCapsuleInjected {
  /** Calls this plugin's host channel. */
  readonly callHost: AccountHostCaller
}

const styles = {
  // The composer's chrome buttons are 28px squares (`AttachFileButton.tsx`).
  button: {
    width: '28px',
    height: '28px',
    padding: 0,
    justifyContent: 'center',
    borderRadius: '8px',
  },
  stack: { position: 'relative', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' },
  icon: { width: '16px', height: '16px', borderRadius: '50%', objectFit: 'cover', display: 'block' },
  badge: {
    position: 'absolute',
    right: '-7px',
    top: '-6px',
    minWidth: '12px',
    height: '12px',
    padding: '0 2px',
    borderRadius: '6px',
    background: 'var(--dsw-alias-interactive-bg-hover)',
    color: 'var(--dsw-alias-label-secondary)',
    fontSize: '9px',
    lineHeight: '12px',
    textAlign: 'center',
  },
} satisfies Record<string, CSSProperties>

/**
 * Connector icons by slug, shared across every composer that mounts this.
 *
 * Module-level like the market's own snapshot: the catalog answer is the same
 * for every session, and the host read behind it is ETag-cached anyway — this
 * only saves re-parsing per conversation view.
 */
let iconsBySlug: ReadonlyMap<string, string> | undefined
let iconsRead: Promise<ReadonlyMap<string, string>> | undefined

async function readIcons(callHost: AccountHostCaller): Promise<ReadonlyMap<string, string>> {
  if (iconsBySlug !== undefined) return iconsBySlug
  iconsRead ??= (async () => {
    const reply = await callHost<Catalog>('market.catalog', { type: 'connector' })
    const map = new Map<string, string>()
    if (reply.ok) {
      for (const item of reply.value.items) {
        if (item.icon.startsWith('http://') || item.icon.startsWith('https://')) {
          map.set(item.slug, item.icon)
        }
      }
    }
    iconsBySlug = map
    return map
  })()
  return iconsRead
}

/**
 * Render the entry, or nothing while no connector is recorded.
 * @param props - slot runtime, market copy, the overlay store, and the host caller.
 * @returns the button, or null.
 */
export function ConnectorCapsule(
  props: PropsRuntime<'conversation.input.left'>
    & PropsLocale<'openlux.market'>
    & InjectFace<ConnectorCapsuleInjected>,
): ReactNode {
  const { t, callHost } = props
  const [target, setTarget] = useState<ConnectorTarget | undefined>(connectorsLiveSnapshot)
  const [icons, setIcons] = useState<ReadonlyMap<string, string> | undefined>(iconsBySlug)

  // Follow the market's reads; do the first one ourselves when nothing has.
  useEffect(() => {
    const unwatch = watchConnectorsLive(() => setTarget(connectorsLiveSnapshot()))
    if (connectorsLiveSnapshot() === undefined) {
      void callHost<ConnectorTarget>('market.connectors', {}).then(reply => {
        if (reply.ok) publishConnectorsLive(reply.value)
      })
    }
    return unwatch
  }, [callHost])

  const recorded = target?.installed ?? []
  const shown = recorded.filter(row => row.live)
  const face = shown[0] ?? recorded[0]

  useEffect(() => {
    if (face === undefined || icons !== undefined) return
    void readIcons(callHost).then(setIcons)
  }, [face, icons, callHost])

  if (face === undefined) return null

  const iconUrl = icons?.get(face.slug)
  const count = shown.length
  const label = count > 0
    ? t('connectorCapsule', { count })
    : t('connectorCapsuleOffline')
  return (
    <Tooltip label={label} side="top" delayMs={500}>
      <Button
        variant="ghost"
        style={styles.button}
        data-testid={CONNECTOR_CAPSULE_ID}
        aria-label={label}
        icon={(
          <span style={styles.stack}>
            {iconUrl === undefined
              ? <IconApiOutline14 />
              : <img src={iconUrl} alt="" width={16} height={16} style={styles.icon} />}
            {count > 1 && <span style={styles.badge}>{count}</span>}
          </span>
        )}
        // Keeps the textarea's caret where it was, like the composer's own chrome.
        onMouseDown={(event) => { event.preventDefault() }}
        // The overlay's store owner hears this and opens (`market-open-request.ts`:
        // this seat cannot hold the store handle itself, one scope per handle).
        onClick={() => { requestMarketOpen('connector') }}
      />
    </Tooltip>
  )
}
