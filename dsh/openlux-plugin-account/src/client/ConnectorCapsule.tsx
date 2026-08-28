/**
 * The composer's connector entry — the icon of the connector carried in with
 * 「去对话」.
 *
 * ## What it is, and what it deliberately is not
 *
 * WorkBuddy's own capsule (`connector-capsule.tsx`) is a *standing* composer
 * entry: it renders even with nothing connected (plug icon + title), shows up
 * to three favicons with a `+N` overflow once connected, and opens an
 * in-place dropdown menu of toggles. Ours diverges on purpose (产品拍板
 * 2026-08-28): the entry appears only after the user presses a connector's
 * 「去对话」, and carries that one connector's icon with no count anywhere.
 * The seat is proof that the tools rode along, not a standing advertisement
 * for the gallery.
 *
 * A press opens a WB-shaped two-row menu: the carried connector with a
 * switch, and 「管理连接器」. The switch OFF means *stop referencing* — the
 * capsule stands down, nothing is disconnected (关掉=不引用,不是断开; the
 * MCP mount stays live and the market still shows it connected). Manage
 * travels through `market-open-request.ts` because this seat cannot hold the
 * overlay store's handle (one scope per handle; the loader refused the plugin
 * when this seat took it).
 *
 * ## Where the data comes from
 *
 * The 「去对话」 press is published by the market (`connector-live.ts`'s
 * tried-connector wire), and the row behind it is the market's own read
 * (`market.connectors`), shared the same way — so a disconnect done in the
 * market hides the capsule without a remount. Icons are not on the installed
 * record — it is a mount manifest, not a card — so they come from the
 * connector catalog, whose host read is ETag-cached and answers a repeat open
 * with one empty 304 (`market/content-cache.ts`).
 */

import { useEffect, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import {
  Button, IconApiOutline14, IconRightUpOutline14, Menu, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { Catalog, CatalogItem, ConnectorTarget } from '../market/wire.ts'
import {
  connectorsLiveSnapshot, publishConnectorsLive, publishTriedConnector,
  triedConnectorSnapshot, watchConnectorsLive, watchTriedConnector,
} from './connector-live.ts'
import { marketItemName } from './market-item-locale.ts'
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
  /** Active locale, read at render time so a switch needs no refetch. */
  readonly language: () => 'zh' | 'en'
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
  // WB's row: name left, switch right; the row itself is the click target.
  row: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '24px',
    width: '100%',
    minWidth: '150px',
  },
  // Hand-rolled switch face — the primitives ship no Switch; state is ours.
  switchTrack: {
    width: '28px',
    height: '16px',
    borderRadius: '8px',
    background: 'var(--dsw-alias-state-success-primary)',
    position: 'relative',
    flex: 'none',
  },
  switchThumb: {
    position: 'absolute',
    top: '2px',
    right: '2px',
    width: '12px',
    height: '12px',
    borderRadius: '50%',
    background: '#fff',
  },
} satisfies Record<string, CSSProperties>

/**
 * Connector catalog rows by slug, shared across every composer that mounts this.
 *
 * Module-level like the market's own snapshot: the catalog answer is the same
 * for every session, and the host read behind it is ETag-cached anyway — this
 * saves re-parsing per conversation view. Keeping the row rather than only its
 * icon also lets a locale change select `name_en`.
 */
let itemsBySlug: ReadonlyMap<string, CatalogItem> | undefined
let itemsRead: Promise<ReadonlyMap<string, CatalogItem>> | undefined

async function readItems(callHost: AccountHostCaller): Promise<ReadonlyMap<string, CatalogItem>> {
  if (itemsBySlug !== undefined) return itemsBySlug
  itemsRead ??= (async () => {
    const reply = await callHost<Catalog>('market.catalog', { type: 'connector' })
    const map = new Map<string, CatalogItem>()
    if (reply.ok) {
      for (const item of reply.value.items) map.set(item.slug, item)
    }
    itemsBySlug = map
    return map
  })()
  return itemsRead
}

/**
 * Render the entry, or nothing until a 「去对话」 has carried a connector in.
 * @param props - slot runtime, market copy, the overlay store, and the host caller.
 * @returns the button, or null.
 */
export function ConnectorCapsule(
  props: PropsRuntime<'conversation.input.left'>
    & PropsLocale<'openlux.market'>
    & InjectFace<ConnectorCapsuleInjected>,
): ReactNode {
  const { t, callHost, language } = props
  const [target, setTarget] = useState<ConnectorTarget | undefined>(connectorsLiveSnapshot)
  const [tried, setTried] = useState<string | undefined>(triedConnectorSnapshot)
  const [items, setItems] = useState<ReadonlyMap<string, CatalogItem> | undefined>(itemsBySlug)
  const [menuOpen, setMenuOpen] = useState(false)

  // Follow the market's reads; do the first one ourselves when nothing has.
  useEffect(() => {
    const unwatchLive = watchConnectorsLive(() => setTarget(connectorsLiveSnapshot()))
    const unwatchTried = watchTriedConnector(() => setTried(triedConnectorSnapshot()))
    if (connectorsLiveSnapshot() === undefined) {
      void callHost<ConnectorTarget>('market.connectors', {}).then(reply => {
        if (reply.ok) publishConnectorsLive(reply.value)
      })
    }
    return () => {
      unwatchLive()
      unwatchTried()
    }
  }, [callHost])

  // Only the connector the user carried in, and only while its record stands.
  const face = tried === undefined
    ? undefined
    : (target?.installed ?? []).find(row => row.slug === tried)

  useEffect(() => {
    if (face === undefined || items !== undefined) return
    void readItems(callHost).then(setItems)
  }, [face, items, callHost])

  if (face === undefined) return null

  const item = items?.get(face.slug)
  const iconUrl = item?.icon.startsWith('http://') || item?.icon.startsWith('https://')
    ? item.icon
    : undefined
  const faceIcon = iconUrl === undefined
    ? <IconApiOutline14 />
    : <img src={iconUrl} alt="" width={16} height={16} style={styles.icon} />
  const displayName = item === undefined ? face.name : marketItemName(item, language())
  const label = face.live
    ? t('connectorCapsule', { name: displayName })
    : t('connectorCapsuleOffline')
  return (
    <Menu
      open={menuOpen}
      side="top"
      portal
      onClose={() => { setMenuOpen(false) }}
      // WB's two rows: the carried connector with its switch, then manage.
      items={[
        {
          id: 'reference',
          icon: faceIcon,
          label: (
            <span style={styles.row} data-testid={`${CONNECTOR_CAPSULE_ID}-toggle`}>
              <span>{displayName}</span>
              <span style={styles.switchTrack} aria-hidden>
                <span style={styles.switchThumb} />
              </span>
            </span>
          ),
        },
        { type: 'separator', id: 'sep' },
        {
          id: 'manage',
          icon: <IconRightUpOutline14 />,
          label: t('connectorCapsuleManage'),
        },
      ]}
      onSelect={(id) => {
        setMenuOpen(false)
        if (id === 'reference') {
          // Stop referencing; the mount stays live (关掉=不引用,不是断开).
          publishTriedConnector(undefined)
        } else if (id === 'manage') {
          // The overlay's store owner hears this and opens
          // (`market-open-request.ts`: this seat cannot hold the store
          // handle itself, one scope per handle).
          requestMarketOpen('connector')
        }
      }}
      anchor={(
        <Tooltip label={label} side="top" delayMs={500}>
          <Button
            variant="ghost"
            style={styles.button}
            data-testid={CONNECTOR_CAPSULE_ID}
            aria-label={label}
            icon={<span style={styles.stack}>{faceIcon}</span>}
            // Keeps the textarea's caret where it was, like the composer's own chrome.
            onMouseDown={(event) => { event.preventDefault() }}
            onClick={() => { setMenuOpen(open => !open) }}
          />
        </Tooltip>
      )}
    />
  )
}
