/** Shared browser-side types for the OpenLux account plugin. */

import type { RpcResult } from '@deepseek-ai/dsh-api-remotes/client'

/**
 * A bound caller for the host half. Components take this rather than the
 * connection itself so they stay testable without a live transport.
 */
export type AccountHostCaller = <T>(
  method: string,
  payload: unknown,
  signal?: AbortSignal,
) => Promise<RpcResult<T>>
