/**
 * Which `web_fetch` targets are not public HTTP(S) endpoints.
 *
 * DSH has no answer to that question: `dsh-web-fetch-http` states its own
 * omission ("Private-network and SSRF protection is not implemented"), and no
 * shipped `@deepseek-ai/dsh-*` package carries a private-address classifier or a
 * knob for one. `webRuntime.trustedHosts` is the opposite direction — an inbound
 * `Host` fence for `/api`.
 *
 * So the ranges and the embedded-IPv4 rules are taken from the kernel this
 * product is migrating off, openclaw (`packages/net-policy/src/ip.ts:22-117`,
 * applied in `src/infra/net/ssrf.ts`), down to the same `ipaddr.js` version it
 * pins. That keeps the behaviour a user sees no looser than the generation
 * before it, and keeps this file diffable against a named source instead of
 * being a range table we invented.
 *
 * Pure and network-free on purpose: the provider wrapper feeds it both URL
 * literals and DNS answers — the same classifier on both sides, so a name
 * cannot pass a check its address would fail — and a unit test can walk every
 * range without a resolver.
 *
 * @module dsh-plugin-desktop/web-fetch-policy
 */

import ipaddr from 'ipaddr.js'

type ParsedAddress = ipaddr.IPv4 | ipaddr.IPv6

/** Where the string came from, which is what decides the fake-ip question. */
export interface TargetPolicy {
  /**
   * Tolerate the placeholder ranges a fake-ip proxy stack hands out. Set only
   * for DNS answers.
   *
   * Measured on a development machine behind such a proxy: `example.com`,
   * `github.com`, `api.openlux.ai` and even a nonexistent `.invalid` name all
   * resolve to `198.18.0.x`. sing-box, Clash and Surge answer every domain from
   * a synthetic pool (RFC 2544 `198.18.0.0/15`, and `fc00::/18` on the IPv6
   * side) and then route the real connection by hostname, so classifying those
   * answers as "not public" would refuse the entire web for a configuration
   * common among this product's users. openclaw hit the same wall and exposed
   * `allowRfc2544BenchmarkRange` / `allowIpv6UniqueLocalRange` (#74351), scoped
   * to hostnames it could derive from configured base URLs. `web_fetch` targets
   * are model-chosen, so there is no such hostname to scope by; what is scoped
   * instead is the direction: a placeholder is only ever plausible as a DNS
   * answer, never as a URL the model typed.
   *
   * Deliberately narrower than openclaw on the IPv6 half: only `fc00::/8`, the
   * half RFC 4193 leaves unassigned and the fake-ip pools draw from. Real
   * self-assigned local networks live in `fd00::/8` and stay refused.
   */
  readonly allowFakeIpPlaceholders?: boolean
}

const RFC2544_BENCHMARK: [ipaddr.IPv4, number] = [ipaddr.IPv4.parse('198.18.0.0'), 15]

/**
 * Hostnames that name a local or infrastructure target regardless of what DNS
 * says. openclaw's set (`src/infra/net/ssrf.ts:211-215`).
 */
const BLOCKED_HOSTNAMES = new Map<string, string>([
  ['localhost', 'loopback hostname'],
  ['localhost.localdomain', 'loopback hostname'],
  ['metadata.google.internal', 'cloud metadata hostname'],
])

const BLOCKED_HOSTNAME_SUFFIXES = ['.localhost', '.local', '.internal']

/**
 * Non-global IPv4 ranges, keyed by `ipaddr.js` range name, valued with the
 * wording the model is shown. Same set as openclaw's
 * `BLOCKED_IPV4_SPECIAL_USE_RANGES`; `reserved` is what covers 240/4, the
 * documentation ranges, and the RFC 2544 benchmark block openclaw lists
 * separately only because it exposes an opt-in for fake-ip proxy stacks.
 */
const IPV4_RANGE_REASONS = new Map<string, string>([
  ['unspecified', 'unspecified address'],
  ['broadcast', 'broadcast address'],
  ['multicast', 'multicast address'],
  ['linkLocal', 'link-local address'],
  ['loopback', 'loopback address'],
  ['carrierGradeNat', 'carrier-grade NAT address'],
  ['private', 'private address'],
  ['reserved', 'reserved address'],
])

/**
 * Non-global IPv6 ranges. openclaw's `BLOCKED_IPV6_SPECIAL_USE_RANGES` plus the
 * deprecated site-local block it has to detect by hand against its pinned
 * `ipaddr.js`; 2.4.0 names that range `deprecatedSiteLocal`, so it goes in the
 * table like the rest.
 */
const IPV6_RANGE_REASONS = new Map<string, string>([
  ['unspecified', 'unspecified address'],
  ['loopback', 'loopback address'],
  ['linkLocal', 'link-local address'],
  ['uniqueLocal', 'unique-local address'],
  ['deprecatedSiteLocal', 'site-local address'],
  ['multicast', 'multicast address'],
  ['reserved', 'reserved address'],
  ['benchmarking', 'benchmarking address'],
  ['discard', 'discard-only address'],
  ['orchid2', 'reserved address'],
])

/**
 * IPv6 forms that carry an IPv4 address a transition gateway would dial, and
 * where the address sits. openclaw's `EMBEDDED_IPV4_SENTINEL_RULES` minus the
 * two entries its own `ipaddr.js` already classifies: `::w.x.y.z` parses as
 * `ipv4Mapped` and `64:ff9b:1::/48` as `rfc6052`, both handled above.
 */
const EMBEDDED_IPV4_RULES: ReadonlyArray<{
  matches: (parts: readonly number[]) => boolean
  hextets: (parts: readonly number[]) => readonly [high: number, low: number]
}> = [
  {
    // NAT64 (rfc6052) and SIIT (rfc6145) keep the IPv4 address in the low hextets.
    matches: parts => parts[0] === 0x0064 && parts[1] === 0xff9b,
    hextets: parts => [parts[6] ?? 0, parts[7] ?? 0],
  },
  {
    // 6to4 (2002::/16) carries it right after the prefix.
    matches: parts => parts[0] === 0x2002,
    hextets: parts => [parts[1] ?? 0, parts[2] ?? 0],
  },
  {
    // Teredo (2001:0::/32) stores the client address XOR 0xffff.
    matches: parts => parts[0] === 0x2001 && parts[1] === 0x0000,
    hextets: parts => [(parts[6] ?? 0) ^ 0xffff, (parts[7] ?? 0) ^ 0xffff],
  },
  {
    // ISATAP interface id (`...:0:5efe:w.x.y.z`); the u/g bits may be set. This
    // is the one rule ipaddr.js cannot reach — such an address reports as
    // `unicast`.
    matches: parts => ((parts[4] ?? 1) & 0xfcff) === 0 && parts[5] === 0x5efe,
    hextets: parts => [parts[6] ?? 0, parts[7] ?? 0],
  },
]

/**
 * Why this fetch target is not a public HTTP(S) endpoint, or `undefined` when
 * nothing about the string itself disqualifies it. Accepts a URL hostname or a
 * bare address, so DNS answers go through the same classifier.
 * @param hostnameOrAddress - `URL.hostname`, or one address from a resolver.
 * @param policy - direction-dependent exemptions; see {@link TargetPolicy}.
 * @returns a short reason for the model, or `undefined` to allow.
 */
export function blockedTargetReason(
  hostnameOrAddress: string,
  policy: TargetPolicy = {},
): string | undefined {
  const host = normalizeHostname(hostnameOrAddress)
  if (host === '') return undefined
  return blockedHostnameReason(host) ?? blockedAddressReason(host, policy)
}

/**
 * Why the target of this URL is not public, or `undefined` when the URL is
 * allowed, unparseable, or not HTTP(S) — the last two belong to the provider,
 * which reports them as retrieval failures with its own codes.
 * @param input - a request URL string.
 * @returns a short reason for the model, or `undefined` to allow.
 */
export function blockedUrlReason(input: string): string | undefined {
  const hostname = fetchHostname(input)
  return hostname === undefined ? undefined : blockedTargetReason(hostname)
}

/**
 * The hostname of an HTTP(S) URL, normalized for classification.
 * @param input - a request URL string.
 * @returns the hostname, or `undefined` when the URL is not usable HTTP(S).
 */
export function fetchHostname(input: string): string | undefined {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  const hostname = normalizeHostname(url.hostname)
  return hostname === '' ? undefined : hostname
}

/**
 * The denial text a guarded call returns to the model.
 * @param url - the requested URL.
 * @param reason - the classifier's reason.
 * @returns one sentence naming the target and why it was refused.
 */
export function blockedMessage(url: string, reason: string): string {
  return `Blocked: ${url} is not a public HTTP(S) target (${reason}). `
    + 'web_fetch reaches public pages only; it cannot read this machine or the local network.'
}

/**
 * Lowercase, strip the trailing dots that make `localhost.` a distinct string,
 * and unwrap the brackets `URL.hostname` keeps on IPv6 literals. openclaw's
 * `normalizeHostname` (`src/infra/net/hostname.ts`).
 * @param value - a raw hostname or address.
 * @returns the normalized form, or `''` when there is nothing to classify.
 */
function normalizeHostname(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/\.+$/u, '')
  if (normalized.startsWith('[') && normalized.endsWith(']')) return normalized.slice(1, -1)
  return normalized
}

function blockedHostnameReason(host: string): string | undefined {
  const exact = BLOCKED_HOSTNAMES.get(host)
  if (exact !== undefined) return exact
  return BLOCKED_HOSTNAME_SUFFIXES.some(suffix => host.endsWith(suffix))
    ? 'internal hostname suffix'
    : undefined
}

function blockedAddressReason(host: string, policy: TargetPolicy): string | undefined {
  const address = parseCanonicalAddress(host)
  if (address !== undefined) {
    if (address.kind() === 'ipv4') return ipv4Reason(address as ipaddr.IPv4, policy)
    const ipv6 = address as ipaddr.IPv6
    const direct = ipv6Reason(ipv6, policy)
    if (direct !== undefined) return direct
    const embedded = embeddedIpv4(ipv6)
    if (embedded === undefined) return undefined
    const reason = ipv4Reason(embedded, policy)
    return reason === undefined ? undefined : `embeds IPv4 ${embedded.toString()}, a ${reason}`
  }
  // Fail closed on anything address-shaped we could not parse canonically. A
  // target that arrives through `fetchHostname` has already been through the
  // WHATWG parser, which folds `2130706433`, `0x7f.0.0.1` and `127.1` into
  // dotted-quad and rejects `999.1.1.1` outright — these two branches exist for
  // the resolver side and for callers of the exported classifier.
  if (host.includes(':')) return ipaddr.isValid(host) ? undefined : 'malformed IPv6 literal'
  return looksLikeIpv4Literal(host) ? 'non-canonical IPv4 literal' : undefined
}

function ipv4Reason(address: ipaddr.IPv4, policy: TargetPolicy): string | undefined {
  if (policy.allowFakeIpPlaceholders === true && address.match(RFC2544_BENCHMARK)) return undefined
  return IPV4_RANGE_REASONS.get(address.range())
}

function ipv6Reason(address: ipaddr.IPv6, policy: TargetPolicy): string | undefined {
  const isFakeIpPool = ((address.parts[0] ?? 0) >>> 8) === 0xfc
  if (policy.allowFakeIpPlaceholders === true && isFakeIpPool) return undefined
  return IPV6_RANGE_REASONS.get(address.range())
}

/**
 * Parse only forms whose meaning is unambiguous: dotted-quad IPv4 and valid
 * IPv6 (including embedded-IPv4 spellings). Legacy IPv4 shorthand is left for
 * the fail-closed branch instead of being silently widened.
 */
function parseCanonicalAddress(host: string): ParsedAddress | undefined {
  if (ipaddr.IPv4.isValid(host)) {
    return ipaddr.IPv4.isValidFourPartDecimal(host) ? ipaddr.IPv4.parse(host) : undefined
  }
  return ipaddr.IPv6.isValid(host) ? ipaddr.IPv6.parse(host) : undefined
}

function embeddedIpv4(address: ipaddr.IPv6): ipaddr.IPv4 | undefined {
  if (address.isIPv4MappedAddress()) return address.toIPv4Address()
  for (const rule of EMBEDDED_IPV4_RULES) {
    if (!rule.matches(address.parts)) continue
    const [high, low] = rule.hextets(address.parts)
    return ipaddr.IPv4.parse(
      [(high >>> 8) & 0xff, high & 0xff, (low >>> 8) & 0xff, low & 0xff].join('.'),
    )
  }
  return undefined
}

/**
 * True for strings that read as an IPv4 address without being one: numeric or
 * hex-prefixed parts, or an empty part. Hostnames like `example.com` must stay
 * hostnames. openclaw's `looksLikeUnsupportedIpv4Literal`.
 */
function looksLikeIpv4Literal(host: string): boolean {
  const parts = host.split('.')
  if (parts.length === 0 || parts.length > 4) return false
  if (parts.some(part => part.length === 0)) return true
  return parts.every(part => /^[0-9]+$/u.test(part) || /^0x[0-9a-f]+$/iu.test(part))
}
