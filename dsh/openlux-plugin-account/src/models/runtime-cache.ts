/** Process-local invalidation fan-out for every `/v1/models` derived cache. */

type Invalidator = () => void
const invalidators = new Set<Invalidator>()

/** Register one module cache; module lifetime matches this package instance. */
export function registerModelCacheInvalidator(invalidate: Invalidator): void {
  invalidators.add(invalidate)
}

/** Token switches, routing edits, and logout invalidate all derived catalogues. */
export function invalidateRuntimeModelCaches(): void {
  for (const invalidate of invalidators) invalidate()
}
