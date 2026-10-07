import type { EntryRow } from './types'

// 航班保障节点阈值规则：按航班号、机尾号、计划到港、实际到港判定保障节点，
// 只有满足标准才允许进入保障状态。规则保存在本机浏览器里，调整后只重判未结束航班。
export type FlightOpsRule = {
  /** 实际到港相对计划到港允许的最大偏差（分钟），超出即判定未达标 */
  maxArrivalDelayMinutes: number
  /** 是否要求实际到港已填报才允许进入保障状态 */
  requireActualArrival: boolean
}

export const DEFAULT_FLIGHT_OPS_RULE: FlightOpsRule = {
  maxArrivalDelayMinutes: 30,
  requireActualArrival: true,
}

const RULE_STORAGE_KEY = 'airport-ground-handling:flight-ops-rule'

// 内存缓存：没有 localStorage 的环境（如测试）里，保存过的规则在本次会话内也生效。
let cachedRule: FlightOpsRule | null = null

export function loadFlightOpsRule(): FlightOpsRule {
  if (cachedRule !== null) {
    return { ...cachedRule }
  }
  let rule = { ...DEFAULT_FLIGHT_OPS_RULE }
  if (typeof window !== 'undefined' && window.localStorage) {
    const raw = window.localStorage.getItem(RULE_STORAGE_KEY)
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Partial<FlightOpsRule>
        rule = {
          maxArrivalDelayMinutes:
            typeof parsed.maxArrivalDelayMinutes === 'number' &&
            Number.isFinite(parsed.maxArrivalDelayMinutes) &&
            parsed.maxArrivalDelayMinutes >= 0
              ? parsed.maxArrivalDelayMinutes
              : DEFAULT_FLIGHT_OPS_RULE.maxArrivalDelayMinutes,
          requireActualArrival:
            typeof parsed.requireActualArrival === 'boolean'
              ? parsed.requireActualArrival
              : DEFAULT_FLIGHT_OPS_RULE.requireActualArrival,
        }
      } catch {
        rule = { ...DEFAULT_FLIGHT_OPS_RULE }
      }
    }
  }
  cachedRule = rule
  return { ...rule }
}

export function persistFlightOpsRule(rule: FlightOpsRule): void {
  cachedRule = { ...rule }
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(RULE_STORAGE_KEY, JSON.stringify(rule))
  }
}

export type FlightOpsVerdict = {
  ok: boolean
  reasons: string[]
}

const FLIGHT_NO_PATTERN = /^[A-Z]{2}\d{3,4}$/i
const TAIL_NO_PATTERN = /^B-?\d{4}$/i

/** 把 "2026-10-07 08:30" / "2026-10-07T08:30" / "2026-10-07" 解析成分钟时间戳，无效返回 null */
export function parseTimeMinutes(value: unknown): number | null {
  const text = String(value ?? '').trim()
  if (!text) {
    return null
  }
  const time = new Date(text.replace(' ', 'T')).getTime()
  return Number.isNaN(time) ? null : Math.round(time / 60000)
}

/** 按航班号、机尾号、计划到港、实际到港判定是否满足进入保障状态的标准 */
export function evaluateFlightOps(row: EntryRow, rule: FlightOpsRule): FlightOpsVerdict {
  const reasons: string[] = []
  const flightNo = String(row['航班号'] ?? '').trim()
  if (!FLIGHT_NO_PATTERN.test(flightNo)) {
    reasons.push('航班号缺失或格式不正确')
  }
  const tailNo = String(row['机尾号'] ?? '').trim()
  if (!TAIL_NO_PATTERN.test(tailNo)) {
    reasons.push('机尾号缺失或格式不正确')
  }
  const planned = parseTimeMinutes(row['计划到港'])
  if (planned === null) {
    reasons.push('计划到港缺失或不是有效时间')
  }
  const actual = parseTimeMinutes(row['实际到港'])
  if (actual === null) {
    if (rule.requireActualArrival) {
      reasons.push('实际到港未填报')
    }
  } else if (planned !== null) {
    const delay = actual - planned
    if (delay > rule.maxArrivalDelayMinutes) {
      reasons.push(`实际到港超出阈值 ${delay} 分钟（阈值 ${rule.maxArrivalDelayMinutes} 分钟）`)
    }
  }
  return { ok: reasons.length === 0, reasons }
}

export function verdictText(verdict: FlightOpsVerdict): string {
  return verdict.ok ? '满足标准' : `未达标：${verdict.reasons.join('；')}`
}
