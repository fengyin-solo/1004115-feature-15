/**
 * 航班保障节点阈值规则（纯前端口径）。
 *
 * 约定：
 * - 按航班号、机尾号、计划到港、实际到港判定保障节点，外加保障节点必须已填报；
 *   只有全部满足标准，才允许进入「保障中」，缺保障节点或缺归属一律不允许保存。
 * - 延误与人工放行冲突时以安全放行为准：「已就绪」是最终结论。
 * - 从航班保障等其它入口发起的动作，要在过站监控清单里同步计时任务；重复确认只生效一次。
 * - 规则调整后只重判未结束航班，已结束（已就绪）航班保持历史口径。
 */
import { allRows, saveRows } from './local-store'
import type { EntryRow } from './types'

export const FLIGHT_READY = '已就绪'
export const FLIGHT_IN_SERVICE = '保障中'
export const FLIGHT_PENDING = '待保障'
export const FLIGHT_DELAYED = '已延误'

export const TURN_WAITING = '待监测'
export const TURN_MONITORING = '监测中'
export const TURN_DONE = '正常完成'
export const TURN_TIMEOUT = '已超时'

/** 节点判定要素：归属（航班号、机尾号）+ 计划/实际到港 + 保障节点。 */
export const NODE_FIELDS = ['航班号', '机尾号', '计划到港', '实际到港', '保障节点'] as const

// 航班号：2 位字母/数字航司代码 + 3~4 位数字序号，例如 CA1858、MU5103。
const FLIGHT_NO_PATTERN = /^[A-Z0-9]{2}\d{3,4}$/
// 机尾号（我国注册号）：B- 开头，4~5 位数字/大写字母，例如 B-6512。
const TAIL_NO_PATTERN = /^B-[0-9A-Z]{4,5}$/
// 实际到港相对计划到港的合理窗口：早到不超过 3 小时，晚到不超过 24 小时。
const ARRIVAL_EARLY_LIMIT_MS = 3 * 60 * 60 * 1000
const ARRIVAL_LATE_LIMIT_MS = 24 * 60 * 60 * 1000

// 规则切换迁移只执行一次，单独存一个标记，业务数据键不动。
const MIGRATION_FLAG_KEY = 'airport-ground-handling:flight-node-rules-v2'

export type NodeCheckResult = { ok: boolean; message: string }

function fieldText(row: EntryRow, field: string): string {
  return String(row[field] ?? '').trim()
}

/** 解析「YYYY-MM-DD HH:mm」「YYYY-MM-DDTHH:mm」及 ISO 时间，无法识别返回 null。 */
export function parseDateTime(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  const text = String(value ?? '').trim()
  if (!text) {
    return null
  }
  const normalized = /^\d{4}-\d{2}-\d{2}[ ]\d{2}:\d{2}/.test(text)
    ? text.replace(' ', 'T')
    : text
  const ms = Date.parse(normalized)
  return Number.isNaN(ms) ? null : ms
}

/** 节点阈值判定：任何一项不达标都不允许保存/进入保障状态。 */
export function checkNodeThreshold(row: EntryRow): NodeCheckResult {
  const flightNo = fieldText(row, '航班号')
  if (!flightNo) {
    return { ok: false, message: '缺少归属信息：航班号为空，不允许保存' }
  }
  if (!FLIGHT_NO_PATTERN.test(flightNo)) {
    return {
      ok: false,
      message: `航班号「${flightNo}」不满足阈值标准（2位字母/数字航司代码 + 3~4位数字序号），不允许进入保障状态`,
    }
  }

  const tailNo = fieldText(row, '机尾号')
  if (!tailNo) {
    return { ok: false, message: '缺少归属信息：机尾号为空，不允许保存' }
  }
  if (!TAIL_NO_PATTERN.test(tailNo)) {
    return {
      ok: false,
      message: `机尾号「${tailNo}」不满足阈值标准（应为 B- 开头的航空器注册号），不允许进入保障状态`,
    }
  }

  const plannedAt = parseDateTime(fieldText(row, '计划到港'))
  if (plannedAt === null) {
    return { ok: false, message: '计划到港不是有效时间，不满足节点阈值，不允许进入保障状态' }
  }
  const actualText = fieldText(row, '实际到港')
  const actualAt = parseDateTime(actualText)
  if (actualAt === null) {
    return { ok: false, message: '实际到港不是有效时间，不满足节点阈值，不允许进入保障状态' }
  }
  if (plannedAt - actualAt > ARRIVAL_EARLY_LIMIT_MS) {
    return {
      ok: false,
      message: `实际到港「${actualText}」早于计划到港超过3小时，不满足节点阈值`,
    }
  }
  if (actualAt - plannedAt > ARRIVAL_LATE_LIMIT_MS) {
    return {
      ok: false,
      message: `实际到港「${actualText}」晚于计划到港超过24小时，不满足节点阈值`,
    }
  }

  const node = fieldText(row, '保障节点')
  if (!node) {
    return { ok: false, message: '缺少保障节点，不允许保存' }
  }
  return { ok: true, message: '节点阈值核验通过' }
}

/** 航班是否已结束：只有安全放行（已就绪）算终态，历史结论不再重判。 */
export function isFinishedFlight(status: string): boolean {
  return status === FLIGHT_READY
}

/** 毫秒差格式化为 hh:mm:ss，负值或非数字按 0 处理。 */
export function formatElapsed(diffMs: number): string {
  if (!Number.isFinite(diffMs) || diffMs <= 0) {
    return '00:00:00'
  }
  const totalSeconds = Math.floor(diffMs / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
}

function nextTurnaroundId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function nextTurnaroundNo(rows: EntryRow[]): string {
  const seq = rows.reduce((max, row) => {
    const matched = /^TURN-(\d+)$/.exec(String(row['过站编号'] ?? ''))
    return matched ? Math.max(max, Number(matched[1])) : max
  }, 0)
  return `TURN-${String(seq + 1).padStart(4, '0')}`
}

export type ClockSyncOutcome = 'created' | 'started' | 'ticking' | 'finished'

/**
 * 启动保障时同步过站计时任务（幂等）：
 * - 清单里没有该航班：新建「监测中」任务并立即开表（以实际到港为计时起点）；
 * - 已有「待监测」任务：启动计时；
 * - 已在监测中或已结束：不动，重复确认只生效一次。
 */
export function syncTurnaroundStart(
  rows: EntryRow[],
  flight: EntryRow,
  now: number = Date.now(),
): { rows: EntryRow[]; outcome: ClockSyncOutcome } {
  const flightNo = fieldText(flight, '航班号')
  // 计时口径统一为实际到港；实际到港异常时退回当前时刻，保证有可用起点。
  const startedAt = parseDateTime(fieldText(flight, '实际到港')) ?? now
  const index = rows.findIndex((row) => fieldText(row, '关联航班') === flightNo)
  if (index < 0) {
    const task: EntryRow = {
      id: nextTurnaroundId(rows),
      status: TURN_MONITORING,
      pending: true,
      abnormal: false,
      过站编号: nextTurnaroundNo(rows),
      关联航班: flightNo,
      计划到港: fieldText(flight, '计划到港'),
      实际到港: fieldText(flight, '实际到港'),
      过站时长: formatElapsed(now - startedAt),
      保障进度: '保障中（随航班保障启动自动同步）',
      异常事项: '',
      过站状态: '',
      计时开始: String(startedAt),
    }
    return { rows: [...rows, task], outcome: 'created' }
  }

  const task = rows[index]
  const status = String(task.status)
  if (status === TURN_MONITORING) {
    return { rows, outcome: 'ticking' }
  }
  if (status === TURN_DONE || status === TURN_TIMEOUT) {
    return { rows, outcome: 'finished' }
  }
  const updated: EntryRow = {
    ...task,
    status: TURN_MONITORING,
    pending: true,
    abnormal: false,
    过站时长: formatElapsed(now - startedAt),
    计时开始: String(startedAt),
  }
  const next = [...rows]
  next[index] = updated
  return { rows: next, outcome: 'started' }
}

/**
 * 安全放行时同步收口过站计时任务（幂等）：
 * - 监测中：置为正常完成并定格过站时长；
 * - 已正常完成/已超时：不动，重复确认只生效一次；
 * - 清单里缺失（历史数据）：补一条正常完成记录，保证两边口径一致。
 */
export function syncTurnaroundFinish(
  rows: EntryRow[],
  flight: EntryRow,
  now: number = Date.now(),
): { rows: EntryRow[]; outcome: ClockSyncOutcome } {
  const flightNo = fieldText(flight, '航班号')
  const index = rows.findIndex((row) => fieldText(row, '关联航班') === flightNo)
  if (index < 0) {
    const startedAt = parseDateTime(fieldText(flight, '实际到港')) ?? now
    const task: EntryRow = {
      id: nextTurnaroundId(rows),
      status: TURN_DONE,
      pending: false,
      abnormal: false,
      过站编号: nextTurnaroundNo(rows),
      关联航班: flightNo,
      计划到港: fieldText(flight, '计划到港'),
      实际到港: fieldText(flight, '实际到港'),
      过站时长: formatElapsed(now - startedAt),
      保障进度: '正常完成（随航班安全放行自动同步）',
      异常事项: '',
      过站状态: '',
      计时开始: String(startedAt),
    }
    return { rows: [...rows, task], outcome: 'created' }
  }

  const task = rows[index]
  const status = String(task.status)
  if (status !== TURN_MONITORING) {
    return { rows, outcome: 'finished' }
  }
  const startedAt = Number(task['计时开始'])
  const updated: EntryRow = {
    ...task,
    status: TURN_DONE,
    pending: false,
    abnormal: false,
    过站时长: Number.isFinite(startedAt) ? formatElapsed(now - startedAt) : '00:00:00',
  }
  const next = [...rows]
  next[index] = updated
  return { rows: next, outcome: 'ticking' }
}

/** 清单展示时给「监测中」记录按当前时间刷新过站时长，落库的仍只是计时起点。 */
export function decorateTurnaroundRows(rows: EntryRow[], now: number = Date.now()): EntryRow[] {
  return rows.map((row) => {
    if (String(row.status) !== TURN_MONITORING) {
      return row
    }
    const startedAt = Number(row['计时开始'])
    if (!Number.isFinite(startedAt)) {
      return row
    }
    return { ...row, 过站时长: formatElapsed(now - startedAt) }
  })
}

/**
 * 规则切换后的一次性重判：
 * - 航班保障只重判未结束航班；已就绪的历史结论保持原口径，一律不动。
 * - 未结束的「保障中」若按新阈值不达标，退回「待保障」，并写明重判原因。
 * - 顺手给老的「监测中」过站记录补计时起点（只补数据，不改结论）。
 */
export function applyFlightRuleMigration(): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    if (window.localStorage.getItem(MIGRATION_FLAG_KEY)) {
      return
    }
  }

  const all = allRows()
  let changed = false

  const flights = (all.flight_ops ?? []).map((row) => {
    const status = String(row.status)
    if (isFinishedFlight(status) || status !== FLIGHT_IN_SERVICE) {
      return row
    }
    const check = checkNodeThreshold(row)
    if (check.ok) {
      return row
    }
    changed = true
    return {
      ...row,
      status: FLIGHT_PENDING,
      pending: true,
      阈值重判说明: `规则调整后重判：${check.message}，已退回待保障`,
    }
  })

  const turns = (all.turnaround ?? []).map((row) => {
    if (String(row.status) !== TURN_MONITORING || row['计时开始']) {
      return row
    }
    changed = true
    const startedAt = parseDateTime(row['实际到港']) ?? Date.now()
    return { ...row, 计时开始: String(startedAt), 过站时长: '00:00:00' }
  })

  if (flights.some((row, index) => row !== (all.flight_ops ?? [])[index])) {
    saveRows('flight_ops', flights)
  }
  if (turns.some((row, index) => row !== (all.turnaround ?? [])[index])) {
    saveRows('turnaround', turns)
  }

  // 无论本次是否有变更都落标记，规则切换只重判一次；之后数据变化不再自动重判。
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(MIGRATION_FLAG_KEY, 'applied')
  }
}
