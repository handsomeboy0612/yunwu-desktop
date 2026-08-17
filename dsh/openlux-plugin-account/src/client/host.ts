/**
 * Caller for this package's host half, over the channel the host plugin owns.
 *
 * See `../index.ts` for why this is a private channel rather than a Typert
 * Remote namespace.
 */

import type { ConnectionHandle, RpcResult } from '@deepseek-ai/dsh-api-remotes/client'

/** Logical channel registered by this package's host half. */
const CHANNEL = '/openlux'

/**
 * Call one account method in the host process.
 * @param connection - the `ctx.connection` handle.
 * @param method - endpoint name within this package's channel.
 * @param payload - request body, shaped per endpoint.
 * @param signal - optional caller cancellation.
 * @returns the host result, with transport faults folded into the error arm.
 */
export async function callAccountHost<T>(
  connection: ConnectionHandle,
  method: string,
  payload: unknown,
  signal?: AbortSignal,
): Promise<RpcResult<T>> {
  try {
    // `rpc.call` throws on transport faults but returns the error arm for
    // anything the host itself rejected; callers should only have to read one
    // shape, so the throwing half is folded in here.
    const result = await connection.rpc.call(CHANNEL, method, payload, signal)
    return result as RpcResult<T>
  } catch (error: unknown) {
    return {
      ok: false,
      error: {
        code: 'internal',
        message: error instanceof Error ? error.message : String(error),
        details: {},
      },
    }
  }
}
