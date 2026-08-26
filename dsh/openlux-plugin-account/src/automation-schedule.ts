import type { AutomationSchedule } from './automation-wire.ts'

const WEEKDAY_MIN = 0
const WEEKDAY_MAX = 6
const HOUR_MAX = 23
const MINUTE_MAX = 59

/** Parse and canonicalize a schedule received over the browser RPC boundary. */
export function automationScheduleOf(value: unknown): AutomationSchedule {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('执行时间格式不正确')
  }
  const raw = value as Record<string, unknown>
  if (raw.kind === 'once') {
    if (!isFiniteInteger(raw.at) || raw.at <= 0) throw new Error('单次执行时间不正确')
    return { kind: 'once', at: raw.at }
  }
  const hour = clockPart(raw.hour, HOUR_MAX, '小时')
  const minute = clockPart(raw.minute, MINUTE_MAX, '分钟')
  if (raw.kind === 'daily') return { kind: 'daily', hour, minute }
  if (raw.kind === 'weekly') {
    if (!Array.isArray(raw.weekdays)) throw new Error('请选择每周执行日')
    const weekdays = [...new Set(raw.weekdays.map((day) => {
      if (!isFiniteInteger(day) || day < WEEKDAY_MIN || day > WEEKDAY_MAX) {
        throw new Error('每周执行日不正确')
      }
      return day
    }))].sort((left, right) => left - right)
    if (weekdays.length === 0) throw new Error('请至少选择一个每周执行日')
    return { kind: 'weekly', weekdays, hour, minute }
  }
  throw new Error('请选择单次、每天或每周执行')
}

/**
 * Return the first occurrence strictly after `after`.
 *
 * Dates are constructed through the native local-time constructor, so changing
 * the operating-system timezone takes effect without storing a competing
 * timezone copy. Native Date also owns DST normalization.
 */
export function nextAutomationRun(schedule: AutomationSchedule, after: number): number | null {
  if (schedule.kind === 'once') return schedule.at > after ? schedule.at : null
  if (schedule.kind === 'daily') {
    for (let offset = 0; offset <= 1; offset += 1) {
      const candidate = localCandidate(after, offset, schedule.hour, schedule.minute)
      if (candidate > after) return candidate
    }
    throw new Error('无法计算下一次每日执行时间')
  }
  const days = new Set(schedule.weekdays)
  for (let offset = 0; offset <= 7; offset += 1) {
    const candidate = localCandidate(after, offset, schedule.hour, schedule.minute)
    if (candidate > after && days.has(new Date(candidate).getDay())) return candidate
  }
  throw new Error('无法计算下一次每周执行时间')
}

/** Stable de-duplication identity for one scheduled local occurrence. */
export function automationOccurrenceKey(
  schedule: AutomationSchedule,
  scheduledFor: number,
): string {
  if (schedule.kind === 'once') return `once:${String(schedule.at)}`
  const date = new Date(scheduledFor)
  const local = [
    String(date.getFullYear()).padStart(4, '0'),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-')
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  return `${schedule.kind}:${local}T${time}`
}

/** Current timezone-offset fingerprint used to notice an OS timezone change. */
export function localTimeFingerprint(at: number = Date.now()): number {
  return new Date(at).getTimezoneOffset()
}

/** Human-readable local timezone name for the page's scheduling disclosure. */
export function localTimeZoneName(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'system-local'
}

function localCandidate(baseTimestamp: number, dayOffset: number, hour: number, minute: number): number {
  const base = new Date(baseTimestamp)
  return new Date(
    base.getFullYear(),
    base.getMonth(),
    base.getDate() + dayOffset,
    hour,
    minute,
    0,
    0,
  ).getTime()
}

function clockPart(value: unknown, max: number, label: string): number {
  if (!isFiniteInteger(value) || value < 0 || value > max) {
    throw new Error(`${label}不正确`)
  }
  return value
}

function isFiniteInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}
