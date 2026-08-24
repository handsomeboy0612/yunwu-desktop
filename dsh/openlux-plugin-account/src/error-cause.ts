/**
 * Flatten an error's cause chain into one readable line.
 *
 * Node hides the real reason on `cause`: `fetch` reports every transport
 * problem as the same bare `TypeError: fetch failed`, and a plugin that failed
 * to start reports `initial connection or tool synchronization failed` with the
 * HTTP status underneath. Both are one useless sentence until unwrapped, and
 * this text is what a user reads and what the connector row matches on.
 */

/** How far down the chain to walk; deeper than this is noise. */
const DEPTH = 4

/**
 * Name a failure and what it was caused by.
 *
 * `code` is not decoration. The MCP SDK's rejected sign-in reads `Streamable
 * HTTP error: Error POSTing to endpoint: …` and puts the status nowhere but
 * `.code` (`client/streamableHttp.js:16-21,369`), so dropping it would make a
 * revoked authorization indistinguishable from any other refusal.
 * @param error - the thrown value.
 * @returns one line, causes joined with an arrow.
 */
export function causeChain(error: unknown): string {
  const parts: string[] = []
  let current: unknown = error
  for (let depth = 0; depth < DEPTH && current instanceof Error; depth += 1) {
    const code = (current as { code?: unknown }).code
    parts.push(code === undefined ? current.message : `${current.message} (${String(code)})`)
    current = current.cause
  }
  if (parts.length === 0) parts.push(String(error))
  return parts.join(' ← ')
}
