/**
 * The model list this installation is working from, read back from settings.
 *
 * `sync.ts` writes it and three layers are already merged by then — the
 * installed pi-ai catalog, the console's delivery and capability overrides, then
 * whatever the user edited. Reading it back is therefore the cheapest way to ask
 * "what did operations give this machine", and it is the same list the kernel's
 * own request layer consults, so a pick made from here cannot disagree with the
 * gate that admits the request.
 *
 * It lives in its own module because two features need it for different
 * reasons — who can see a picture (`media/vision.ts`) and who can read a
 * document (`media/documents.ts`) — and a second copy of the namespace and the
 * shape would be a second place to be wrong.
 *
 * @module openlux-plugin-account/models/listed
 */

import type { Context } from '@deepseek-ai/cordis'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { ROUTE } from './sync.ts'

/** The adapter section holding this route's model entries. */
const PI_AI_NS = settingsNamespace('llm-pi-ai')

/** One model entry, narrowed to the fields these features read. */
export interface ListedModel {
  /** Model id as the route serves it. */
  readonly id: string
  /**
   * Declared input modalities, when the entry carries them.
   *
   * `text` and `image` are the values this route's catalog uses today. Absence
   * is not "text only" — an entry the user typed by hand has no `input` at all.
   */
  readonly input?: readonly string[]
}

/** The slice of the adapter's section this module reads. */
interface PiAiSection {
  readonly providers?: Record<string, { readonly models?: readonly {
    readonly id?: unknown
    readonly input?: unknown
  }[] } | undefined>
}

/**
 * The models this installation lists, in the order operations put them.
 *
 * Order matters to callers: `sync.ts` merges the console's list ahead of
 * anything local, so the first entry that fits a job is the delivered
 * preference rather than an alphabetical accident.
 * @param ctx - host context.
 * @returns the entries, possibly empty when settings are unavailable.
 */
export function listedModels(ctx: Context): readonly ListedModel[] {
  const settings = ctx.get('settings')
  if (settings === undefined) return []
  const models = (settings.get(PI_AI_NS) as PiAiSection | undefined)?.providers?.[ROUTE]?.models
  if (!Array.isArray(models)) return []
  const listed: ListedModel[] = []
  for (const entry of models) {
    if (typeof entry?.id !== 'string' || entry.id === '') continue
    // Spread rather than a possibly-undefined field: with exact optional
    // property types, "absent" and "present but undefined" are different types,
    // and absent is the one that means "this entry declares nothing".
    listed.push(Array.isArray(entry.input)
      ? {
          id: entry.id,
          input: (entry.input as readonly unknown[]).filter((value): value is string => typeof value === 'string'),
        }
      : { id: entry.id })
  }
  return listed
}
