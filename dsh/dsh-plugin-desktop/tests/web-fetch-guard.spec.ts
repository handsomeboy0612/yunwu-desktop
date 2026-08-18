import { describe, expect, it } from 'vitest'
import { WebError } from '@deepseek-ai/dsh-web'
import type { HttpFetchLimits } from '@deepseek-ai/dsh-web-fetch-http'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import {
  assertPublicFetchTarget,
  Config,
  GUARDED_FETCH_PROVIDER_ID,
  GuardedHttpFetchProvider,
  inject,
  name,
  privateFetchGuard,
} from '../src/web-fetch-guard.ts'
import { blockedTargetReason, blockedUrlReason } from '../src/web-fetch-policy.ts'

const LIMITS = Config({ timeoutMs: 45_000 }) as HttpFetchLimits

function guardOf(url: unknown, toolName = 'web_fetch'): string | undefined {
  return privateFetchGuard({ name: toolName, arguments: { url } } as ToolExecution)
}

function refusingLookup(): Promise<readonly string[]> {
  throw new Error('lookup must not run')
}

describe('IPv4 range classification', () => {
  it('refuses every non-global range openclaw refuses', () => {
    expect(blockedTargetReason('10.0.0.1')).toBe('private address')
    expect(blockedTargetReason('172.16.4.1')).toBe('private address')
    expect(blockedTargetReason('172.31.255.255')).toBe('private address')
    expect(blockedTargetReason('192.168.1.1')).toBe('private address')
    expect(blockedTargetReason('127.0.0.1')).toBe('loopback address')
    expect(blockedTargetReason('127.255.255.255')).toBe('loopback address')
    expect(blockedTargetReason('0.0.0.0')).toBe('unspecified address')
    expect(blockedTargetReason('169.254.169.254')).toBe('link-local address')
    expect(blockedTargetReason('100.64.0.1')).toBe('carrier-grade NAT address')
    expect(blockedTargetReason('100.100.100.200')).toBe('carrier-grade NAT address')
    expect(blockedTargetReason('224.0.0.1')).toBe('multicast address')
    expect(blockedTargetReason('255.255.255.255')).toBe('broadcast address')
    expect(blockedTargetReason('198.18.0.1')).toBe('reserved address')
    expect(blockedTargetReason('203.0.113.9')).toBe('reserved address')
    expect(blockedTargetReason('240.0.0.1')).toBe('reserved address')
  })

  it('allows public unicast', () => {
    expect(blockedTargetReason('8.8.8.8')).toBeUndefined()
    expect(blockedTargetReason('93.184.216.34')).toBeUndefined()
    expect(blockedTargetReason('1.1.1.1')).toBeUndefined()
  })
})

describe('IPv6 range classification', () => {
  it('refuses the special-use ranges, including the ones a library version can miss', () => {
    expect(blockedTargetReason('::1')).toBe('loopback address')
    expect(blockedTargetReason('::')).toBe('unspecified address')
    expect(blockedTargetReason('fc00::1')).toBe('unique-local address')
    expect(blockedTargetReason('fd12:3456::1')).toBe('unique-local address')
    expect(blockedTargetReason('fe80::1')).toBe('link-local address')
    expect(blockedTargetReason('fec0::1')).toBe('site-local address')
    expect(blockedTargetReason('ff02::1')).toBe('multicast address')
    expect(blockedTargetReason('100::1')).toBe('discard-only address')
    expect(blockedTargetReason('2001:2::1')).toBe('benchmarking address')
    expect(blockedTargetReason('2001:20::1')).toBe('reserved address')
    expect(blockedTargetReason('2001:db8::1')).toBe('reserved address')
  })

  it('refuses transition forms that carry a private IPv4 address', () => {
    // The gap this suite was rewritten for: every one of these parses as a
    // public-looking IPv6 literal, and a host with the matching gateway dials
    // the embedded address.
    expect(blockedTargetReason('::ffff:127.0.0.1')).toBe('embeds IPv4 127.0.0.1, a loopback address')
    expect(blockedTargetReason('::ffff:7f00:1')).toBe('embeds IPv4 127.0.0.1, a loopback address')
    expect(blockedTargetReason('::ffff:192.168.0.1')).toBe('embeds IPv4 192.168.0.1, a private address')
    expect(blockedTargetReason('64:ff9b::7f00:1')).toBe('embeds IPv4 127.0.0.1, a loopback address')
    expect(blockedTargetReason('64:ff9b::127.0.0.1')).toBe('embeds IPv4 127.0.0.1, a loopback address')
    expect(blockedTargetReason('64:ff9b:1::a9fe:a9fe'))
      .toBe('embeds IPv4 169.254.169.254, a link-local address')
    expect(blockedTargetReason('2002:7f00:1::')).toBe('embeds IPv4 127.0.0.1, a loopback address')
    expect(blockedTargetReason('2002:a00:1::')).toBe('embeds IPv4 10.0.0.1, a private address')
    // Teredo keeps the client address inverted: 3fff:fdd2 ^ ffff:ffff = c000:022d.
    expect(blockedTargetReason('2001:0:4136:e378:8000:63bf:3fff:fdd2'))
      .toBe('embeds IPv4 192.0.2.45, a reserved address')
    // ISATAP is the one form ipaddr.js reports as ordinary unicast.
    expect(blockedTargetReason('2001:4860:1::5efe:7f00:1'))
      .toBe('embeds IPv4 127.0.0.1, a loopback address')
  })

  it('allows public IPv6 and transition forms carrying a public IPv4', () => {
    expect(blockedTargetReason('2606:2800:220:1:248:1893:25c8:1946')).toBeUndefined()
    expect(blockedTargetReason('64:ff9b::8.8.8.8')).toBeUndefined()
    expect(blockedTargetReason('2002:808:808::')).toBeUndefined()
    expect(blockedTargetReason('::ffff:8.8.8.8')).toBeUndefined()
  })
})

describe('fake-ip placeholder ranges', () => {
  const resolved = { allowFakeIpPlaceholders: true } as const

  it('refuses the placeholder ranges as URL literals', () => {
    expect(blockedTargetReason('198.18.0.76')).toBe('reserved address')
    expect(blockedTargetReason('198.19.255.255')).toBe('reserved address')
    expect(blockedTargetReason('fc00::1')).toBe('unique-local address')
    expect(blockedUrlReason('http://198.18.0.76/')).toBe('reserved address')
  })

  it('accepts them as DNS answers, which is the only way a proxy stack produces them', () => {
    expect(blockedTargetReason('198.18.0.76', resolved)).toBeUndefined()
    expect(blockedTargetReason('198.19.255.255', resolved)).toBeUndefined()
    expect(blockedTargetReason('fc00::1', resolved)).toBeUndefined()
    expect(blockedTargetReason('fc12:3456::1', resolved)).toBeUndefined()
  })

  it('still refuses real local networks in a DNS answer', () => {
    expect(blockedTargetReason('127.0.0.1', resolved)).toBe('loopback address')
    expect(blockedTargetReason('192.168.1.1', resolved)).toBe('private address')
    expect(blockedTargetReason('169.254.169.254', resolved)).toBe('link-local address')
    expect(blockedTargetReason('100.64.0.1', resolved)).toBe('carrier-grade NAT address')
    expect(blockedTargetReason('203.0.113.9', resolved)).toBe('reserved address')
    // fd00::/8 is the half RFC 4193 assigns to real local networks.
    expect(blockedTargetReason('fd12:3456::1', resolved)).toBe('unique-local address')
    expect(blockedTargetReason('::1', resolved)).toBe('loopback address')
  })
})

describe('hostname classification', () => {
  it('refuses local and infrastructure names in any spelling', () => {
    expect(blockedTargetReason('localhost')).toBe('loopback hostname')
    expect(blockedTargetReason('LocalHost')).toBe('loopback hostname')
    expect(blockedTargetReason('localhost.')).toBe('loopback hostname')
    expect(blockedTargetReason('localhost.localdomain')).toBe('loopback hostname')
    expect(blockedTargetReason('metadata.google.internal')).toBe('cloud metadata hostname')
    expect(blockedTargetReason('foo.localhost')).toBe('internal hostname suffix')
    expect(blockedTargetReason('printer.local')).toBe('internal hostname suffix')
    expect(blockedTargetReason('api.internal')).toBe('internal hostname suffix')
  })

  it('leaves ordinary hostnames alone', () => {
    expect(blockedTargetReason('example.com')).toBeUndefined()
    expect(blockedTargetReason('1password.com')).toBeUndefined()
    expect(blockedTargetReason('192-168-1-1.nip.io')).toBeUndefined()
  })
})

describe('fail-closed parsing', () => {
  it('refuses address-shaped strings it cannot read canonically', () => {
    expect(blockedTargetReason('2130706433')).toBe('non-canonical IPv4 literal')
    expect(blockedTargetReason('127.1')).toBe('non-canonical IPv4 literal')
    expect(blockedTargetReason('192.168.1')).toBe('non-canonical IPv4 literal')
    expect(blockedTargetReason('0177.0.0.1')).toBe('non-canonical IPv4 literal')
    expect(blockedTargetReason('0x7f.0.0.1')).toBe('non-canonical IPv4 literal')
    expect(blockedTargetReason('::::')).toBe('malformed IPv6 literal')
  })

  it('reaches those literals through the range table once a URL has folded them', () => {
    // WHATWG parsing normalizes legacy IPv4 spellings before any of our code
    // runs, so through a URL these are plain loopback — the branch above is for
    // resolver answers and direct callers of the classifier.
    expect(blockedUrlReason('http://2130706433/')).toBe('loopback address')
    expect(blockedUrlReason('http://127.1/')).toBe('loopback address')
    expect(blockedUrlReason('http://0x7f.0.0.1/')).toBe('loopback address')
    expect(blockedUrlReason('http://017700000001/')).toBe('loopback address')
    expect(blockedUrlReason('http://0/')).toBe('unspecified address')
  })
})

describe('blockedUrlReason', () => {
  it('classifies the URL target and defers what is not ours', () => {
    expect(blockedUrlReason('http://127.0.0.1:43120/openlux/brand-mark.png')).toBe('loopback address')
    expect(blockedUrlReason('https://localhost/secret')).toBe('loopback hostname')
    expect(blockedUrlReason('http://[::1]/')).toBe('loopback address')
    expect(blockedUrlReason('http://[64:ff9b::7f00:1]/'))
      .toBe('embeds IPv4 127.0.0.1, a loopback address')
    expect(blockedUrlReason('https://example.com/')).toBeUndefined()
    expect(blockedUrlReason('not a url')).toBeUndefined()
    expect(blockedUrlReason('ftp://127.0.0.1/')).toBeUndefined()
    expect(blockedUrlReason('file:///etc/passwd')).toBeUndefined()
  })
})

describe('privateFetchGuard', () => {
  it('denies a private web_fetch target and names it', () => {
    const reason = guardOf('http://127.0.0.1/openlux/brand-mark.png')
    expect(reason).toContain('not a public HTTP(S) target')
    expect(reason).toContain('127.0.0.1')
    expect(reason).toContain('loopback address')
  })

  it('ignores other tools, other argument shapes, and public targets', () => {
    expect(guardOf('http://127.0.0.1/', 'image_generate')).toBeUndefined()
    expect(guardOf('https://example.com/')).toBeUndefined()
    expect(guardOf(42)).toBeUndefined()
    expect(privateFetchGuard({ name: 'web_fetch', arguments: null } as ToolExecution)).toBeUndefined()
  })
})

describe('assertPublicFetchTarget', () => {
  it('refuses a private literal without consulting DNS', async () => {
    await expect(assertPublicFetchTarget('http://127.0.0.1:9/', refusingLookup))
      .rejects.toMatchObject({ code: 'WEB_BLOCKED_URL' })
    await expect(assertPublicFetchTarget('http://[2002:7f00:1::]/', refusingLookup))
      .rejects.toMatchObject({ code: 'WEB_BLOCKED_URL' })
  })

  it('refuses a public name whose answers include a private address', async () => {
    const lookup = async (): Promise<readonly string[]> => ['93.184.216.34', '127.0.0.1']
    await expect(assertPublicFetchTarget('http://evil.example/', lookup))
      .rejects.toSatisfy((error: unknown) => {
        expect(error).toBeInstanceOf(WebError)
        expect((error as WebError).code).toBe('WEB_BLOCKED_URL')
        expect((error as Error).message).toContain('127.0.0.1')
        return true
      })
  })

  it('classifies resolver answers with the same table as literals', async () => {
    const lookup = async (): Promise<readonly string[]> => ['64:ff9b::a9fe:a9fe']
    await expect(assertPublicFetchTarget('https://metadata.example/', lookup))
      .rejects.toMatchObject({ code: 'WEB_BLOCKED_URL' })
  })

  it('allows a name whose answers are all public unicast', async () => {
    const lookup = async (): Promise<readonly string[]> => ['93.184.216.34', '2606:2800:220:1::1']
    await expect(assertPublicFetchTarget('https://example.com/page', lookup)).resolves.toBeUndefined()
  })

  it('allows a fake-ip answer, which is what this product sees behind a proxy stack', async () => {
    const lookup = async (): Promise<readonly string[]> => ['198.18.0.76']
    await expect(assertPublicFetchTarget('https://example.com/', lookup)).resolves.toBeUndefined()
  })

  it('leaves resolver failures to the inner fetch', async () => {
    const lookup = async (): Promise<readonly string[]> => {
      throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' })
    }
    await expect(assertPublicFetchTarget('https://no-such-host.invalid/', lookup))
      .resolves.toBeUndefined()
  })
})

describe('composition row', () => {
  it('registers under the id the composition names, over both seams', () => {
    expect(name).toBe('openlux-web-fetch-guard')
    expect(inject).toEqual(['web', 'tools'])
    const provider = new GuardedHttpFetchProvider(LIMITS)
    expect(provider.id).toBe(GUARDED_FETCH_PROVIDER_ID)
    expect(provider.available()).toBe(true)
  })

  it('takes its transport caps from upstream schema defaults', () => {
    const resolved = Config({ timeoutMs: 45_000 })
    expect(resolved.timeoutMs).toBe(45_000)
    expect(resolved.maxRedirects).toBeTypeOf('number')
    expect(resolved.maxResponseBytes).toBeTypeOf('number')
    expect(resolved.userAgent).toBeTypeOf('string')
  })

  it('refuses loopback before the inner transport connects', async () => {
    const provider = new GuardedHttpFetchProvider(LIMITS, refusingLookup)
    await expect(provider.fetch({ url: 'http://127.0.0.1:1/' }))
      .rejects.toMatchObject({ code: 'WEB_BLOCKED_URL', name: 'WebError' })
  })
})
