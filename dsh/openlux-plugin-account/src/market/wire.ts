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
  /** Opening questions already carried by the expert catalog's first screen. */
  readonly openingPrompts?: readonly string[]
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

/** One reusable opening question attached to a home scene. */
export interface HomeScenePrompt {
  readonly title: string
  readonly prompt: string
}

/** One expert reference carried by a home recommendation. */
export interface HomeExpertRef {
  readonly id: number
  readonly slug: string
  readonly name: string
}

/** A scene chip and the prompts it may stage into the blank composer. */
export interface HomeScene {
  readonly id: number
  readonly slug: string
  readonly name: string
  readonly mode: string
  readonly iconKey: string
  readonly prompts: readonly HomeScenePrompt[]
  readonly experts: readonly HomeExpertRef[]
}

/** Curated expert recommendation shown on the blank-session home. */
export interface HomeShowcase {
  readonly id: number
  readonly slug: string
  readonly title: string
  readonly subtitle: string
  readonly description: string
  readonly initPrompt: string
  readonly cover: string
  readonly experts: readonly HomeExpertRef[]
}

/** One practice case; its short-lived artifact URL is resolved only on click. */
export interface HomePlaybook {
  readonly id: number
  readonly slug: string
  readonly title: string
  readonly subtitle: string
  readonly description: string
  readonly initPrompt: string
  readonly sceneSlug: string
  readonly cover: string
  readonly artifactType: string
  /** Stable editorial order from the V2 playbook row. */
  readonly sortOrder: number
  readonly experts: readonly HomeExpertRef[]
  readonly tags: readonly string[]
}

/** Independently ETag-revalidated home modules combined for the renderer. */
export interface HomeContent {
  readonly scenes: readonly HomeScene[]
  readonly showcases: readonly HomeShowcase[]
  readonly playbooks: readonly HomePlaybook[]
  readonly stale?: boolean
  readonly failure?: CatalogFailure
}

/** On-demand artifact lease for an HTML, video, or external-link playbook. */
export interface PlaybookArtifact {
  readonly url: string
  readonly artifactType: string
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
  /**
   * The bytes arrived but could not be written where they belong.
   *
   * Its own reason because it is the one refusal the user can act on by
   * retrying: on Windows a directory under an active watcher — which the skill
   * root always is — can refuse an operation while another process holds a
   * handle, and that is a moment, not a verdict.
   */
  | 'write-failed'
  /** A connector's manifest is missing, unparseable, or names no MCP server. */
  | 'bad-manifest'
  /** The connector declares token auth and the gallery sent none. */
  | 'needs-token'
  /** The connector declares a web sign-in and no grant is stored yet. */
  | 'needs-authorization'
  /**
   * The connector's authorization cannot be completed by this client.
   *
   * What is left of this case after connector sign-in shipped: a manifest that
   * declares `oauth` on a *local* server. A bearer token has to ride a request,
   * and a spawned process has none — so unlike a remote endpoint, there is no
   * place the result of a sign-in could go.
   */
  | 'unsupported-auth'
  /** The manifest asks for a transport the bridge does not speak (e.g. `sse`). */
  | 'unsupported-transport'
  /** This deployment has no writable plugin tree to mount into. */
  | 'not-mountable'

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
  /**
   * Display name from the preset's own metadata, absent when it published
   * none — the roster's own field, which is what the kernel's preset selector
   * shows. Carried so a card can name an expert without the catalog: the
   * "my experts" page lists what is on disk, including rows whose catalog
   * entry is gone or was never there.
   */
  readonly name?: string
  /** One line on what this expert is for, when its metadata published one. */
  readonly description?: string
  /** The kernel's own health verdict, verbatim when it has one. */
  readonly broken?: string
  /** Catalog item, when this row was installed by us rather than by hand. */
  readonly itemId?: string
  readonly version?: string
  /** Opening questions recorded at install time, so a summon needs no network. */
  readonly prompts?: readonly string[]
}

/** One skill sitting in the kernel's user skill root. */
export interface InstalledSkill {
  /** Directory name, which is also the catalog slug when we installed it. */
  readonly slug: string
  /** `name` from the front matter, else the directory name. */
  readonly name: string
  /** Whether this one arrived through the gallery rather than by hand. */
  readonly managed: boolean
  readonly version?: string
  /**
   * Whether the kernel will still surface this skill.
   *
   * False when the front matter has `user-invocable: false` or
   * `disable-model-invocation: true` — the two invocation keys
   * `dsh-skill-filesystem` actually honours. Closing a skill writes both so it
   * leaves the model catalog and the slash menu without deleting the directory.
   */
  readonly enabled: boolean
}

/**
 * Where standalone skills land, and what is already there.
 *
 * Separate from {@link InstallTarget} because the two answer different
 * questions from different owners: presets come from the roster service and can
 * be unauthorable, while the skill root is a plain directory the kernel scans
 * (`dsh-skill-filesystem`, user root, watched) and is therefore always
 * writable. The list is every directory in that root, ours or not, because what
 * the model sees is the whole root — and that count is what a user about to add
 * one more is entitled to see (the catalog is rendered per skill, so it is paid
 * for on every request).
 */
export interface SkillTarget {
  readonly root: string
  readonly installed: readonly InstalledSkill[]
}

/**
 * One connector the user has connected.
 *
 * The record is ours because the kernel keeps none: a live MCP server is a
 * loader entry and nothing more, so "which of these did the user connect, and
 * from what catalog row" has no other home. The old shell kept the same list
 * for the same reason (`src/main/market/connector-installer.ts`: 「MCP 配置落在
 * 内核 openclaw.json…故用 market-connectors.json 单独登记」), the difference
 * being that ours also carries the server config, because our own record is
 * what re-mounts it on the next launch.
 */
export interface InstalledConnector {
  /** Catalog slug, which is what a card is marked against. */
  readonly slug: string
  /** MCP namespace; the model's tools are `mcp__<serverName>__*`. */
  readonly serverName: string
  readonly name: string
  readonly version?: string
  /** ISO timestamp, for a stable order in the list. */
  readonly connectedAt: string
  /** Whether the entry is mounted in the running app right now. */
  readonly live: boolean
  /** Why it is not mounted, when it is not. */
  readonly failure?: string
  /**
   * Whether that failure is a dead web sign-in.
   *
   * Its own field rather than a read of `failure`, because the row turns it
   * into an action — signing in again in place — and matching on a sentence
   * would break the first time the sentence is reworded or translated.
   */
  readonly needsAuthorization?: boolean
  /**
   * The command or endpoint this runs.
   *
   * For the rows no catalog entry describes: one the user pasted, and one the
   * console has since dropped from the shelf. Without it such a row could show
   * nothing but its own name.
   */
  readonly summary?: string
}

/** What is connected, and whether this deployment can connect anything. */
export interface ConnectorTarget {
  /**
   * Whether connectors can be mounted at all.
   *
   * False in a deployment with no writable plugin tree — a browser build, or a
   * host whose loader is read-only. The gallery then shows the shelf without
   * install buttons rather than failing one press at a time.
   */
  readonly mountable: boolean
  readonly installed: readonly InstalledConnector[]
  /**
   * How many of the user's own servers are live.
   *
   * A count rather than rows: the user's connectors are managed in their own
   * config file, the way WorkBuddy's are, so the gallery offers one button to
   * that file instead of cards it could not honestly edit.
   */
  readonly custom: number
}

/**
 * What handing the user's own connector file to the OS did.
 *
 * Three-way rather than a boolean because the middle case is common and needs
 * its own sentence: on a machine with no application associated with `.json`,
 * the file gets revealed in its folder instead of opened.
 */
export interface CustomOpen {
  readonly path: string
  readonly did: 'opened' | 'revealed' | 'nothing'
}

/** One server from the user's file, with its verdict. */
export interface CustomConnectorRow {
  readonly name: string
  readonly live: boolean
  readonly problem?: string
}

/** What one re-read of the user's own connector file did. */
export interface CustomConnectorSync {
  readonly live: number
  /** One line per server that would not start, or per parse failure. */
  readonly problems: readonly string[]
  /** The file itself, shown so it can be found without the opener. */
  readonly path: string
  /** Every named server in file order; empty when the file did not parse. */
  readonly rows: readonly CustomConnectorRow[]
}

/** The user's connector file as text, for the dialog's in-app editor. */
export interface CustomConnectorFile {
  readonly path: string
  readonly content: string
}

/**
 * What saving the editor's text did.
 *
 * A refusal is a value, not an error: every message is a sentence the dialog
 * shows next to the editor, and the file on disk is untouched when one comes
 * back. A save carries the text as written — normalized when the host had to
 * hoist a nested `mcpServers` — plus the re-read that followed.
 */
export type CustomConnectorSave =
  | { readonly kind: 'refused'; readonly message: string }
  | { readonly kind: 'saved'; readonly content: string; readonly sync: CustomConnectorSync }

/** One connect, as asked for by the gallery. */
export interface ConnectorRequest {
  /** Catalog slug; the manifest is read host-side from it. */
  readonly slug: string
  readonly name?: string
  readonly version?: string
  /** The secret, when the manifest declares `auth.mode: 'token'`. */
  readonly token?: string
}

/**
 * One connect from a pasted config rather than the shelf.
 *
 * WorkBuddy's equivalent button opens the MCP config file in the editor it is
 * hosted in; with no editor to open, the same payload arrives as text — the
 * server object MCP servers publish in their own READMEs.
 */
export interface CustomConnectorRequest {
  /** The server object, or a `{ mcpServers: { <name>: … } }` wrapper. */
  readonly json: string
  /** MCP namespace; when absent, read from the pasted wrapper's key. */
  readonly serverName?: string
  /** Display name for the row; defaults to the namespace. */
  readonly name?: string
}

/**
 * What the gallery must know before it can offer a connect.
 *
 * Read from the manifest, which the snapshot withholds — so this is a separate
 * round trip, made when the user opens a connector rather than for the whole
 * shelf.
 */
export interface ConnectorRequirement {
  readonly slug: string
  /** `none` connects on one press; `token` needs a field; `oauth` needs a browser. */
  readonly mode: 'none' | 'token' | 'oauth'
  /** What to call the field, from the manifest (`auth.label`). */
  readonly label?: string
  /** For `oauth` only: whether a grant is already stored, so the row can connect. */
  readonly authorized?: boolean
  /** Why this connector cannot be connected at all, when it cannot. */
  readonly refusal?: string
}

/** What starting a web sign-in produced. */
export type ConnectorAuthorizationStart =
  /** Open this page; the attempt runs on and settles on its own. */
  | { readonly kind: 'opened'; readonly url: string }
  /** Nothing was started, and this is why. */
  | { readonly kind: 'refused'; readonly message: string }

/**
 * How a sign-in ended, polled by the gallery while the browser is open.
 *
 * Polled rather than pushed because the attempt outlives the request that
 * started it: the host answers with the URL as soon as there is one, so the
 * renderer can open the browser, and the outcome arrives minutes later.
 */
export type ConnectorAuthorizationState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'pending' }
  | { readonly kind: 'authorized' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'failed'; readonly message: string }

/**
 * How putting an already-connected connector back up ended.
 *
 * Its own shape rather than an `InstallOutcome`, because nothing is installed:
 * the record was there before the press and is still there after a refusal.
 */
export type RemountOutcome =
  | { readonly kind: 'mounted' }
  | { readonly kind: 'refused'; readonly message: string }

/** Where installs land, and what is already there. */
export interface InstallTarget {
  /** Whether this deployment can accept installs at all. */
  readonly authorable: boolean
  /** The directory installs are written to, absent when not authorable. */
  readonly root?: string
  /** Every preset the roster currently supplies, ours or not. */
  readonly installed: readonly InstalledPreset[]
}
