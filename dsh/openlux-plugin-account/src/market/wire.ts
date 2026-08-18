/**
 * Shapes that cross the market RPC channel.
 *
 * They live in their own module because both halves need them and neither half
 * can import the other's: the host modules reach for `node:fs` and the roster
 * service, and the browser bundle compiles against DOM types only. Nothing here
 * imports anything, so a type-only import from either side stays free.
 */

/** Catalog partitions, named as the console's snapshot route names them. */
export type CatalogType = 'expert' | 'skill' | 'connector'

/**
 * One installable archive of one catalog item.
 *
 * No URL, and that is the console's design rather than an omission: a
 * pre-signed link expires, while the snapshot is cached under an ETag and may
 * be days old — putting the expiring thing inside the non-expiring cache means
 * "the link was dead by the time you clicked install", which the ETag cannot
 * express. The digest and size do not expire, so they ride along; the link is
 * signed at the moment of installing (`controller/desktop_market_client.go`,
 * `GetClientDesktopMarketDownloadURL`).
 */
export interface CatalogArtifact {
  readonly format: string
  readonly kernelApi: string
  readonly sha256: string
  readonly size: number
}

/** Why an item cannot be installed by this client. */
export type Unavailable =
  /** The console has no archive built for this kernel API. */
  | 'no-artifact'
  /** The slug cannot be a preset directory name. */
  | 'bad-id'

/** One catalog row, as the gallery renders it. */
export interface CatalogItem {
  /** Catalog identity, and the preset directory id an install would take. */
  readonly slug: string
  readonly name: string
  readonly descriptionZh: string
  readonly descriptionEn: string
  readonly version: string
  readonly icon: string
  readonly categoryId: number
  readonly tags: readonly string[]
  /** Whether this expert is a team; the second-level tab reads it. */
  readonly team: boolean
  readonly featured: boolean
  readonly downloads: number
  readonly artifact?: CatalogArtifact
  readonly unavailable?: Unavailable
}

/** One category, for the filter row. */
export interface CatalogCategory {
  readonly id: number
  readonly name: string
}

/**
 * Why a catalog read produced no fresh rows.
 *
 * A discriminant rather than a sentence: the host cannot write the sentence,
 * because the gallery renders in whichever locale the user picked and the host
 * does not know which that is. What only the host knows travels as data — a
 * status code, or the console's own words when the console supplied them.
 */
export type CatalogFailure =
  /** No `sk-` token yet, so there is nothing to ask the console with. */
  | { readonly kind: 'signed-out' }
  /** The console answered, but not with a catalog. */
  | { readonly kind: 'http'; readonly status: number }
  /** The console refused in the envelope and said why. */
  | { readonly kind: 'refused'; readonly message: string }
  /** The request never reached an answer. */
  | { readonly kind: 'transport'; readonly message: string }

/** One catalog answer. */
export interface Catalog {
  /** Kernel API the artifacts were selected for. */
  readonly kernelApi: string
  readonly items: readonly CatalogItem[]
  readonly categories: readonly CatalogCategory[]
  /** These rows came from cache because the fresh read failed. */
  readonly stale?: boolean
  /** Set when the fresh read failed, whether or not cache saved it. */
  readonly failure?: CatalogFailure
}

/**
 * Archive formats this client can install.
 *
 * `preset-dir` is a whole preset, composition included, so it is written as it
 * arrives — and is therefore built for one kernel API, which the catalog
 * declares. `expert-content` carries an expert's persona and members but no
 * composition: the client builds that from the kernel it is running, so the
 * same archive stays installable across kernel versions.
 */
export const PRESET_DIR_FORMAT = 'preset-dir.tar.gz'
export const EXPERT_CONTENT_FORMAT = 'expert-content.tar.gz'

/** Bundled skills ride this format, one archive per skill catalog item. */
export const SKILL_DIR_FORMAT = 'skill-dir.tar.gz'

/** Which archive format a catalog partition is installed from. */
export function formatFor(type: CatalogType): string | undefined {
  if (type === 'expert') return EXPERT_CONTENT_FORMAT
  return type === 'skill' ? SKILL_DIR_FORMAT : undefined
}

/**
 * One install, as asked for by the gallery.
 *
 * It names an ITEM, never a URL. The host resolves the link itself, for two
 * reasons that agree: the console's download route is what signs links and
 * counts installs, and a main process that fetches a URL handed to it by a
 * renderer is the textbook SSRF sink in an Electron app — the renderer must not
 * be able to choose where the host connects.
 */
export interface InstallRequest {
  /** Catalog partition, which the console needs to find the item. */
  readonly type: CatalogType
  /** Preset id, which becomes the directory name; the catalog owns it. */
  readonly id: string
  /** Display name for the roster, from the catalog row. */
  readonly name?: string
  /** Description for the roster, from the catalog row. */
  readonly description?: string
  /** Which of the formats above the artifact is. */
  readonly format: string
  /** The digest the gallery showed in its confirmation, hex. */
  readonly sha256: string
  readonly itemId: string
  readonly version?: string
  readonly kernelApi?: string
}

/** Why an install did not happen; every one of these is an ordinary outcome. */
export type RefusalReason =
  | 'not-authorable'
  | 'invalid-id'
  | 'already-installed'
  | 'download-failed'
  | 'digest-mismatch'
  | 'bad-archive'
  | 'broken-after-install'
  /** The catalog offered a format this client has no unpacker for. */
  | 'unsupported-format'
  /** Expert content needs a base composition and the roster supplies none. */
  | 'no-base-preset'
  /** The console would not sign a download link for this item. */
  | 'no-download-url'
  /** The console's digest no longer matches what the gallery showed. */
  | 'catalog-stale'

/** How many of an expert's bundled skills came down with it. */
export interface SkillTally {
  readonly installed: number
  readonly total: number
}

/** Result of an install attempt. */
export type InstallOutcome =
  | {
    readonly kind: 'installed'
    readonly id: string
    readonly path: string
    /** Present when the expert declared bundled skills. */
    readonly skills?: SkillTally
    /**
     * Opening questions from the manifest, best first; the summon that follows
     * this install prefills the first one.
     */
    readonly prompts?: readonly string[]
  }
  | { readonly kind: 'refused'; readonly reason: RefusalReason; readonly message: string }

/** An installed preset the gallery needs to know about. */
export interface InstalledPreset {
  readonly id: string
  readonly trust: string
  /** The kernel's own health verdict, verbatim when it has one. */
  readonly broken?: string
  /** Catalog item, when this row was installed by us rather than by hand. */
  readonly itemId?: string
  readonly version?: string
  /** Opening questions recorded at install time, so a summon needs no network. */
  readonly prompts?: readonly string[]
}

/** Where installs land, and what is already there. */
export interface InstallTarget {
  /** Whether this deployment can accept installs at all. */
  readonly authorable: boolean
  /** The directory installs are written to, absent when not authorable. */
  readonly root?: string
  /** Every preset the roster currently supplies, ours or not. */
  readonly installed: readonly InstalledPreset[]
}
