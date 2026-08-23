/**
 * Turning a durable attachment reference into something an `<img>` can show.
 *
 * The bytes come from this plugin's own host half rather than from
 * `session.readAttachment`: the kernel authorizes that read by finding the id in
 * a session event's model-visible content, and these images are deliberately not
 * there (`media/read.ts` carries the full account). The reference is what
 * authorizes the read either way — it is content-addressed and verified against
 * the stored object — so the loader hands it over whole.
 *
 * Object URLs are owned here, which means revoking them. A 2K generated image is
 * megabytes of blob per URL, so the cache is bounded and all of it is released
 * when the scope that created it goes away.
 */

import type { ImageLoader } from './MessageImage.tsx'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import { callAccountHost } from './host.ts'
import { IMAGE_READ_ENDPOINT } from '../media/name.ts'

/**
 * How many resolved images stay live.
 *
 * Well above what one screen shows, and far below what a long session could
 * accumulate: the oldest URL is revoked when a new one passes the cap, and a
 * card whose URL was revoked reloads through the atoms' own retry path.
 */
const MAX_LIVE_URLS = 32

/** One scope's loader, and the disposer for the URLs it created. */
export interface ImageLoaders {
  /** The loader every card in this scope shares. */
  readonly load: ImageLoader
  /** Revoke every live URL. */
  readonly dispose: () => void
}

/** One image read, as the host answers it. */
interface ImageBytes {
  readonly data: string
  readonly mediaType: string
}

/**
 * Create the loader for one client scope.
 * @param connection - the `ctx.connection` handle this plugin's channel rides.
 * @returns the loader and its disposer.
 */
export function createImageLoaders(connection: ConnectionHandle): ImageLoaders {
  const urls = new Map<string, Promise<string>>()

  const revoke = (pending: Promise<string>): void => {
    void pending.then(url => { URL.revokeObjectURL(url) }, () => {
      // A load that failed owns no URL.
    })
  }

  const read = async (attachment: ImageAttachmentRef): Promise<string> => {
    const result = await callAccountHost<ImageBytes>(connection, IMAGE_READ_ENDPOINT, attachment)
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    const binary = atob(result.value.data)
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0))
    return URL.createObjectURL(new Blob([bytes], { type: result.value.mediaType }))
  }

  return {
    // Stable identity: the attachment atoms reload whenever the loader function
    // changes, so this must be the same function for the scope's whole life.
    load: (attachment) => {
      const key = String(attachment.attachmentId)
      const cached = urls.get(key)
      if (cached !== undefined) return cached
      const pending = read(attachment)
      urls.set(key, pending)
      // Failures are not cached: the atoms offer a retry control, and a
      // remembered rejection would make it a no-op.
      void pending.catch(() => {
        if (urls.get(key) === pending) urls.delete(key)
      })
      while (urls.size > MAX_LIVE_URLS) {
        const [oldest] = urls.keys()
        if (oldest === undefined) break
        const evicted = urls.get(oldest)
        urls.delete(oldest)
        if (evicted !== undefined) revoke(evicted)
      }
      return pending
    },
    dispose: () => {
      for (const pending of urls.values()) revoke(pending)
      urls.clear()
    },
  }
}
