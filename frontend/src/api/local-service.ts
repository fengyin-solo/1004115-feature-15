import { MODULE_BY_KEY } from '@/data/modules'
import {
  applyFlightRuleMigration,
  checkNodeThreshold,
  decorateTurnaroundRows,
  FLIGHT_DELAYED,
  FLIGHT_IN_SERVICE,
  FLIGHT_PENDING,
  FLIGHT_READY,
  formatElapsed,
  isFinishedFlight,
  syncTurnaroundFinish,
  syncTurnaroundStart,
  TURN_DONE,
  TURN_MONITORING,
  TURN_TIMEOUT,
} from '@/data/flight-rules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

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
  applyFlightRuleMigration()
  const stored = key === 'turnaround' ? decorateTurnaroundRows(listRows(key)) : listRows(key)
  const matched = filterRows(stored, filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  applyFlightRuleMigration()
  if (key === 'flight_ops') {
    return runFlightAction(id, action)
  }
  if (key === 'turnaround') {
    return runTurnaroundAction(id, action)
  }
  return runGenericAction(key, id, action)
}

function runGenericAction(key: string, id: number, action: string): ActionResult {
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
  return commitAction(meta, rows, index, action, target)
}

function commitAction(
  meta: ModuleMeta,
  rows: EntryRow[],
  index: number,
  action: string,
  target: string,
): ActionResult {
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
  saveRows(meta.key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

/**
 * 航班保障动作：
 * - 进入保障状态前先过节点阈值（航班号、机尾号、计划/实际到港、保障节点），不达标不允许保存；
 * - 延误与人工放行冲突时以安全放行为准，「已就绪」是最终结论，不再接受任何流转；
 * - 启动保障/安全放行都要同步过站监控清单的计时任务，重复确认只生效一次。
 */
function runFlightAction(id: number, action: string): ActionResult {
  const meta = moduleMeta('flight_ops')
  const rows = listRows(meta.key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const row = rows[index]
  const current = String(row.status)

  // 安全放行优先：已就绪的历史结论锁定，延误或再次启动都不生效。
  if (isFinishedFlight(current)) {
    return {
      ok: false,
      message: `航班 ${row['航班号'] ?? id} 已安全放行（已就绪），结论锁定，不能再${action}；延误与人工放行冲突时以安全放行为准`,
    }
  }

  if (action === '标记延误') {
    if (current === FLIGHT_DELAYED) {
      return { ok: false, message: '该航班已经标记延误，重复确认只生效一次' }
    }
    if (current === FLIGHT_PENDING) {
      return { ok: false, message: '航班尚未进入保障状态，不能标记延误' }
    }
    return commitAction(meta, rows, index, action, FLIGHT_DELAYED)
  }

  if (action === '启动保障') {
    const check = checkNodeThreshold(row)
    if (!check.ok) {
      return { ok: false, message: check.message }
    }
    if (current === FLIGHT_IN_SERVICE) {
      return { ok: false, message: '保障任务已在进行中，重复确认只生效一次' }
    }
    const saved = commitAction(meta, rows, index, action, FLIGHT_IN_SERVICE)
    if (!saved.ok) {
      return saved
    }
    return syncStartTurnaround(row, '已启动保障')
  }

  if (action === '确认就绪') {
    const check = checkNodeThreshold(row)
    if (!check.ok) {
      return { ok: false, message: check.message }
    }
    const saved = commitAction(meta, rows, index, action, FLIGHT_READY)
    if (!saved.ok) {
      return saved
    }
    return syncFinishTurnaround(row, '已安全放行（已就绪）')
  }

  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  return commitAction(meta, rows, index, action, target)
}

function syncStartTurnaround(flight: EntryRow, prefix: string): ActionResult {
  const turnRows = listRows('turnaround')
  const { rows, outcome } = syncTurnaroundStart(turnRows, flight)
  saveRows('turnaround', rows)
  const tail =
    outcome === 'created'
      ? '，已在过站监控清单同步创建计时任务'
      : outcome === 'started'
        ? '，已同步启动待监测航班的过站计时'
        : outcome === 'ticking'
          ? '，过站计时已在进行中（重复确认只生效一次）'
          : '，过站记录已结束，未重复创建'
  return { ok: true, message: `${prefix}${tail}` }
}

function syncFinishTurnaround(flight: EntryRow, prefix: string): ActionResult {
  const turnRows = listRows('turnaround')
  const { rows, outcome } = syncTurnaroundFinish(turnRows, flight)
  saveRows('turnaround', rows)
  const tail =
    outcome === 'created'
      ? '，过站监控清单已补记一条正常完成计时任务'
      : outcome === 'ticking'
        ? '，过站计时已同步定格为正常完成'
        : '，过站记录此前已收口（重复确认只生效一次）'
  return { ok: true, message: `${prefix}${tail}` }
}

/**
 * 过站监控动作：
 * - 开始监测即开计时，重复点击不重置起点（重复确认只生效一次）；
 * - 正常完成/标记超时定格过站时长，已收口记录不再流转。
 */
function runTurnaroundAction(id: number, action: string): ActionResult {
  const meta = moduleMeta('turnaround')
  const rows = listRows(meta.key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const row = rows[index]
  const current = String(row.status)

  if (action === '开始监测') {
    if (current === TURN_MONITORING) {
      return { ok: false, message: '过站计时已在进行中，重复确认只生效一次' }
    }
    if (current === TURN_DONE || current === TURN_TIMEOUT) {
      return { ok: false, message: '过站记录已结束，不能重新开始监测' }
    }
    const updated: EntryRow = {
      ...row,
      status: TURN_MONITORING,
      pending: true,
      abnormal: false,
      计时开始: String(Date.now()),
      过站时长: '00:00:00',
    }
    const next = [...rows]
    next[index] = updated
    saveRows(meta.key, next)
    return { ok: true, message: '过站记录已开始监测，计时启动' }
  }

  if (action === '正常完成' || action === '标记超时') {
    if (current === TURN_DONE || current === TURN_TIMEOUT) {
      return { ok: false, message: `过站记录已${current}，重复确认只生效一次` }
    }
    const target = action === '正常完成' ? TURN_DONE : TURN_TIMEOUT
    const startedAt = Number(row['计时开始'])
    const updated: EntryRow = {
      ...row,
      status: target,
      pending: false,
      abnormal: target === TURN_TIMEOUT,
      过站时长: Number.isFinite(startedAt) ? formatElapsed(Date.now() - startedAt) : '00:00:00',
    }
    const next = [...rows]
    next[index] = updated
    saveRows(meta.key, next)
    return { ok: true, message: `过站记录已${action}，计时定格为「${updated.过站时长}」` }
  }

  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  return commitAction(meta, rows, index, action, target)
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
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
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
