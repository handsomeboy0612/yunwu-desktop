/**
 * Host half of the OpenLux account plugin.
 *
 * The browser cannot call the account endpoints itself: sign-in, captcha, and
 * balance all answer without CORS headers. Those requests belong here, and the
 * browser reaches them over a logical RPC channel this plugin owns.
 *
 * Why an own channel instead of Typert Remote, which is the kernel's usual way
 * to expose host methods: the browser face of Typert refuses to mount a
 * namespace unless every parameter and result carries a strict codec
 * (`api/gateway/src/client/index.ts:549-564`), and strict codecs come only from
 * the kernel's own typert generator, seeded by the kernel repository's tsconfig
 * (`typert/generator/README.md:19-21`). A package outside that repository
 * cannot join that pipeline. `connection.rpc.handle` is the extension point
 * meant for exactly this — it registers the HTTP route, validates the request
 * envelope, and enforces the authority policy for us
 * (`client/connection/src/rpc-host.ts:90-115`, contract-tested in that
 * package's `tests/node-half.host.spec.ts:227-418`).
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: merges `ctx.connection` (the Host handle) into this program.
import type {} from '@deepseek-ai/dsh-client-connection'

/**
 * Logical channel owned by this plugin. The browser addresses it as
 * `/openlux/<method>`; `/api` is reserved for the kernel's own surface.
 */
export const ACCOUNT_CHANNEL = '/openlux'

/** Reply shape of the `ping` method. */
export interface AccountPingResult {
  /** Fixed string the caller checks to prove the reply came from this handler. */
  readonly codeword: string
  /** Echo of the caller's note, proving the payload survives the crossing. */
  readonly note: string
  /** Whether the host context carries a credential provider. */
  readonly credentialsAvailable: boolean
}

/**
 * Host plugin body: own one RPC channel for the account endpoints.
 * @param ctx - loader-provided context for this composition entry.
 */
export function apply(ctx: Context): void {
  // `handle` registers through the calling fiber's own effect, so the route
  // and its disposal already follow this plugin's lifetime.
  ctx.connection.rpc.handle(ACCOUNT_CHANNEL, async (endpoint, payload) => {
    switch (endpoint) {
      case 'ping': return ping(ctx, payload)
      default:
        // The error-code union belongs to the kernel and cannot grow a row from
        // out here, so an unroutable endpoint reuses the code the kernel's own
        // envelope check uses for the same class of mistake
        // (`client/connection/src/rpc-host.ts:173-177`). Account *business*
        // failures must not come through here at all: they ride the success arm
        // with their own discriminant, the way the kernel's own services do.
        return {
          ok: false,
          error: {
            code: 'bad-request',
            message: `unknown account endpoint ${JSON.stringify(endpoint)}`,
            details: { issues: [] },
          },
        }
    }
  }, { authority: 'loopback' })
}

/**
 * Report that the browser can reach this channel.
 * @param ctx - host context, inspected for the credential provider.
 * @param payload - caller payload; a `note` string is echoed back.
 * @returns the fixed codeword, the echoed note, and credential availability.
 */
async function ping(ctx: Context, payload: unknown): Promise<{ ok: true; value: AccountPingResult }> {
  const note = (payload as { note?: unknown } | null)?.note
  return {
    ok: true,
    value: {
      codeword: 'AMBER-4471',
      note: typeof note === 'string' ? note : '(无备注)',
      credentialsAvailable: ctx.get('credentials') !== undefined,
    },
  }
}

/**
 * Required services. `webServer` is not named by us directly, but
 * `connection.rpc.handle` registers the route through the *calling* fiber's
 * context, so it has to resolve here.
 */
export const inject = ['connection', 'webServer']
