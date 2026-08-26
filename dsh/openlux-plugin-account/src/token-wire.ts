/** RPC-safe token-management shapes shared by the account host and client. */

export type RoutingPriority = '' | 'auto' | 'price' | 'speed' | 'success_rate'

export interface TokenQuotaUnit {
  readonly perUnit: number
  readonly symbol: string
  readonly rate: number
  readonly tokens: boolean
}

export interface ManagedToken {
  readonly id: number
  readonly name: string
  readonly maskedKey: string
  readonly status: number
  readonly routingPriority: RoutingPriority
  /** Ordered channel-group ids; order is the manual-routing fallback priority. */
  readonly groupIds: readonly number[]
  readonly groupNames: readonly string[]
  readonly unlimitedQuota: boolean
  readonly remainQuota: number
  readonly usedQuota: number
  readonly createdTime: number
  readonly accessedTime: number
  readonly expiredTime: number
}

export interface TokenListSnapshot {
  readonly tokens: readonly ManagedToken[]
  readonly currentId?: number
  readonly credentialWritable: boolean
  readonly credentialSource?: string
  readonly quotaUnit: TokenQuotaUnit
}

export interface TokenGroup {
  readonly id: number
  readonly name: string
  readonly label: string
  readonly description: string
  readonly ratio: number
  readonly availability: 'healthy' | 'degraded' | 'unhealthy' | 'unavailable' | 'unknown'
}

export interface TokenDraft {
  readonly name: string
  readonly routingPriority: RoutingPriority
  readonly groupIds: readonly number[]
  readonly unlimitedQuota: boolean
  readonly remainQuota: number
  readonly expiredTime: number
}

export interface TokenUpdateDraft {
  readonly id: number
  readonly changes: Partial<TokenDraft>
}
