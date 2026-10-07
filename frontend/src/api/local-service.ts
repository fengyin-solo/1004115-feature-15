import {
  evaluateFlightOps,
  loadFlightOpsRule,
  parseTimeMinutes,
  persistFlightOpsRule,
  verdictText,
  type FlightOpsRule,
} from '@/data/flight-ops-rule'
import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

const FLIGHT_OPS_KEY = 'flight_ops'
const TURNAROUND_KEY = 'turnaround'
// 航班保障的结束态：已就绪的航班算历史结论，规则调整后不再重判。
const FLIGHT_OPS_FINISHED = '已就绪'

function nowText(): string {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  if (key === FLIGHT_OPS_KEY) {
    return runFlightOpsAction(id, action)
  }
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

/** 其它入口的过站监控清单同步计时任务：启动保障开始计时，确认放行停止计时并结算过站时长。 */
function syncTurnaroundTiming(flightNo: string, event: 'start' | 'finish'): boolean {
  const no = flightNo.trim()
  if (!no) {
    return false
  }
  const rows = listRows(TURNAROUND_KEY)
  let changed = false
  const next = rows.map((row) => {
    if (String(row['关联航班'] ?? '').trim() !== no) {
      return row
    }
    if (event === 'start' && row.status === '待监测') {
      changed = true
      return { ...row, status: '监测中', pending: true, 保障进度: '保障中', 计时开始: nowText() }
    }
    if (event === 'finish' && row.status === '监测中') {
      changed = true
      const started = parseTimeMinutes(row['计时开始'])
      const now = parseTimeMinutes(nowText())
      const minutes = started === null || now === null ? null : Math.max(0, now - started)
      return {
        ...row,
        status: '正常完成',
        pending: false,
        保障进度: '已就绪',
        过站时长: minutes === null ? row['过站时长'] : `${minutes}分钟`,
      }
    }
    return row
  })
  if (changed) {
    saveRows(TURNAROUND_KEY, next)
  }
  return changed
}

/** 航班保障专用流转：节点阈值判定、延误与安全放行冲突、确认幂等、过站监控同步计时。 */
function runFlightOpsAction(id: number, action: string): ActionResult {
  const meta = moduleMeta(FLIGHT_OPS_KEY)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(FLIGHT_OPS_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const row = rows[index]
  const current = String(row.status)
  const commit = (updated: EntryRow) => {
    const next = [...rows]
    next[index] = updated
    saveRows(FLIGHT_OPS_KEY, next)
  }

  // 重复确认只生效一次：确认类动作以放行确认时间做幂等，已确认过的直接拒绝。
  if ((action === '确认就绪' || action === '安全放行') && row['放行确认时间']) {
    return { ok: false, message: `${meta.entity}已确认放行，重复确认不生效` }
  }

  if (action === '启动保障') {
    if (current !== '待保障') {
      return { ok: false, message: `只有「待保障」的${meta.entity}才能启动保障` }
    }
    const verdict = evaluateFlightOps(row, loadFlightOpsRule())
    if (!verdict.ok) {
      return { ok: false, message: `节点阈值未达标，不允许进入保障状态：${verdict.reasons.join('；')}` }
    }
    commit({ ...row, status: target, pending: true, abnormal: false, 节点判定: verdictText(verdict) })
    const synced = syncTurnaroundTiming(String(row['航班号'] ?? ''), 'start')
    return {
      ok: true,
      message: synced
        ? `${meta.entity}已启动保障，过站监控清单已同步开始计时`
        : `${meta.entity}已启动保障`,
    }
  }

  if (action === '标记延误') {
    if (current === FLIGHT_OPS_FINISHED) {
      return { ok: false, message: `${meta.entity}已放行结束，不能再标记延误` }
    }
    commit({ ...row, status: target, pending: true, abnormal: true })
    return { ok: true, message: `${meta.entity}已标记延误` }
  }

  if (action === '确认就绪') {
    if (current === FLIGHT_OPS_FINISHED) {
      return { ok: false, message: `${meta.entity}已是「已就绪」，重复确认不生效` }
    }
    if (current === '已延误') {
      return { ok: false, message: `${meta.entity}处于延误状态，与人工放行冲突时以「安全放行」为准` }
    }
    if (current !== '保障中') {
      return { ok: false, message: `只有「保障中」的${meta.entity}才能确认就绪` }
    }
    commit({
      ...row,
      status: target,
      pending: false,
      abnormal: false,
      放行方式: '正常确认',
      放行确认时间: nowText(),
    })
    const synced = syncTurnaroundTiming(String(row['航班号'] ?? ''), 'finish')
    return {
      ok: true,
      message: synced
        ? `${meta.entity}已确认就绪，过站监控清单已同步停止计时`
        : `${meta.entity}已确认就绪`,
    }
  }

  if (action === '安全放行') {
    if (current === FLIGHT_OPS_FINISHED) {
      return { ok: false, message: `${meta.entity}已放行，重复确认不生效` }
    }
    if (current !== '保障中' && current !== '已延误') {
      return { ok: false, message: `只有「保障中」或「已延误」的${meta.entity}才能安全放行` }
    }
    // 延误与人工放行冲突时以安全放行为准：放行结论覆盖延误标记。
    const overrodeDelay = current === '已延误'
    commit({
      ...row,
      status: target,
      pending: false,
      abnormal: false,
      放行方式: overrodeDelay ? '人工安全放行（覆盖延误）' : '人工安全放行',
      放行确认时间: nowText(),
    })
    syncTurnaroundTiming(String(row['航班号'] ?? ''), 'finish')
    return {
      ok: true,
      message: overrodeDelay
        ? `延误与人工放行冲突，已按安全放行执行，当前状态「${target}」`
        : `${meta.entity}已安全放行`,
    }
  }

  return { ok: false, message: `${meta.entity}暂不支持「${action}」` }
}

/** 登记保存：航班保障缺保障节点或归属时不允许保存。 */
export function createEntry(key: string, values: Record<string, string>): ActionResult {
  const meta = moduleMeta(key)
  const check = validateEntryValues(key, values)
  if (check) {
    return { ok: false, message: check }
  }
  const rows = listRows(key)
  const id = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  const row: EntryRow = { id, status: meta.statuses[0], pending: true, abnormal: false }
  for (const field of meta.fields) {
    row[field] = String(values[field] ?? '').trim()
  }
  if (key === FLIGHT_OPS_KEY) {
    row['节点判定'] = verdictText(evaluateFlightOps(row, loadFlightOpsRule()))
  }
  saveRows(key, [...rows, row])
  return { ok: true, message: `${meta.entity}已登记，编号 ${id}` }
}

/** 修改保存：保留状态与确认记录，航班保障重新判定节点结论。 */
export function updateEntry(key: string, id: number, values: Record<string, string>): ActionResult {
  const meta = moduleMeta(key)
  const check = validateEntryValues(key, values)
  if (check) {
    return { ok: false, message: check }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const row: EntryRow = { ...rows[index] }
  for (const field of meta.fields) {
    row[field] = String(values[field] ?? '').trim()
  }
  if (key === FLIGHT_OPS_KEY && String(row.status) !== FLIGHT_OPS_FINISHED) {
    row['节点判定'] = verdictText(evaluateFlightOps(row, loadFlightOpsRule()))
  }
  const next = [...rows]
  next[index] = row
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已保存，编号 ${id}` }
}

function validateEntryValues(key: string, values: Record<string, string>): string | null {
  if (key !== FLIGHT_OPS_KEY) {
    return null
  }
  const blank = (field: string) => String(values[field] ?? '').trim() === ''
  // 缺保障节点或归属时不允许保存
  if (blank('保障节点')) {
    return '缺保障节点，不允许保存'
  }
  if (blank('保障归属')) {
    return '缺保障归属，不允许保存'
  }
  for (const field of ['航班号', '机尾号', '计划到港']) {
    if (blank(field)) {
      return `缺${field}，不允许保存`
    }
  }
  return null
}

export function getFlightOpsRule(): FlightOpsRule {
  return loadFlightOpsRule()
}

/** 保存阈值规则：规则调整后只重判未结束航班，已结束航班的历史结论保持原口径。 */
export function updateFlightOpsRule(rule: FlightOpsRule): ActionResult {
  persistFlightOpsRule(rule)
  const rows = listRows(FLIGHT_OPS_KEY)
  let rejudged = 0
  let kept = 0
  const next = rows.map((row) => {
    if (String(row.status) === FLIGHT_OPS_FINISHED) {
      kept += 1
      return row
    }
    rejudged += 1
    return { ...row, 节点判定: verdictText(evaluateFlightOps(row, rule)) }
  })
  saveRows(FLIGHT_OPS_KEY, next)
  return {
    ok: true,
    message: `规则已保存，重判未结束航班 ${rejudged} 条，历史结论保持原口径 ${kept} 条`,
  }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
