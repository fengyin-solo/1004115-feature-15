<template>
  <section class="page" data-module="flight_ops">
    <header class="page-head">
      <div>
        <h2>航班保障管理</h2>
        <p class="page-desc">维护航班保障，围绕航班号、机尾号、计划到港、实际到港做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记航班保障</button>
        <button class="btn" type="button" @click="exportRows">导出航班保障清单</button>
      </div>
    </header>

    <form class="rule-bar" @submit.prevent="saveRule">
      <span class="rule-title">节点阈值规则</span>
      <label class="rule-item">
        <span>到港偏差阈值（分钟）</span>
        <input v-model.number="ruleForm.maxArrivalDelayMinutes" type="number" min="0" step="1" />
      </label>
      <label class="rule-item checkbox">
        <input v-model="ruleForm.requireActualArrival" type="checkbox" />
        <span>要求实际到港已填报</span>
      </label>
      <button class="btn" type="submit">保存规则并重判</button>
      <span class="rule-hint">按航班号、机尾号、计划到港、实际到港判定；只重判未结束航班，历史结论保持原口径</span>
    </form>
    <p v-if="ruleMessage" class="rule-message">{{ ruleMessage }}</p>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
            <button class="link" type="button" @click="openEdit(row)">编辑</button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无航班保障数据，可先登记航班保障</td>
        </tr>
      </tbody>
    </table>

    <div v-if="showForm" class="modal-mask" @click.self="closeForm">
      <form class="modal-card" @submit.prevent="submitForm">
        <h3>{{ editingId === null ? '登记航班保障' : `编辑航班保障 #${editingId}` }}</h3>
        <label v-for="field in formFields" :key="field" class="modal-item">
          <span>
            {{ field }}
            <em v-if="requiredFields.includes(field)" class="required-mark">*</em>
          </span>
          <input v-model="formValues[field]" :placeholder="`请输入${field}`" />
        </label>
        <p class="modal-hint">缺保障节点或归属时不允许保存；保存后按当前阈值规则重新判定未结束航班</p>
        <p v-if="formError" class="error-text">{{ formError }}</p>
        <div class="modal-actions">
          <button class="btn primary" type="submit">保存</button>
          <button class="btn ghost" type="button" @click="closeForm">取消</button>
        </div>
      </form>
    </div>

    <footer class="page-foot">
      <span>共 {{ total }} 条航班保障记录</span>
      <span v-if="noticeMessage" class="notice-text">{{ noticeMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  createEntry,
  downloadEntries,
  getFlightOpsRule,
  listEntries,
  moduleMeta,
  runAction as applyAction,
  updateEntry,
  updateFlightOpsRule,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('flight_ops')
const columns = ["航班号", "机尾号", "计划到港", "实际到港", "保障节点", "保障归属", "节点判定"]
const actions = ["启动保障", "确认就绪", "标记延误", "安全放行"]
const statuses = ["待保障", "保障中", "已就绪", "已延误"]
const formFields = meta.fields
const requiredFields = ["航班号", "机尾号", "计划到港", "保障节点", "保障归属"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const noticeMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)
const stats = computed(() => [
  { label: '待保障航班', value: rows.value.filter((row) => String(row.status) === '待保障').length },
  { label: '保障中航班', value: rows.value.filter((row) => String(row.status) === '保障中').length },
  { label: '延误航班', value: rows.value.filter((row) => String(row.status) === '已延误').length },
])

const ruleForm = ref({ ...getFlightOpsRule() })
const ruleMessage = ref('')

const showForm = ref(false)
const editingId = ref<number | null>(null)
const formValues = ref<Record<string, string>>({})
const formError = ref('')

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function saveRule() {
  errorMessage.value = ''
  noticeMessage.value = ''
  const threshold = Number(ruleForm.value.maxArrivalDelayMinutes)
  if (!Number.isFinite(threshold) || threshold < 0) {
    ruleMessage.value = '到港偏差阈值必须是不小于 0 的数字'
    return
  }
  const result = updateFlightOpsRule({
    maxArrivalDelayMinutes: Math.floor(threshold),
    requireActualArrival: ruleForm.value.requireActualArrival,
  })
  ruleMessage.value = result.message
  reload()
}

function openCreate() {
  editingId.value = null
  formValues.value = {}
  formError.value = ''
  showForm.value = true
}

function openEdit(row: EntryRow) {
  editingId.value = Number(row.id)
  const values: Record<string, string> = {}
  for (const field of formFields) {
    values[field] = String(row[field] ?? '')
  }
  formValues.value = values
  formError.value = ''
  showForm.value = true
}

function closeForm() {
  showForm.value = false
}

function submitForm() {
  formError.value = ''
  const result =
    editingId.value === null
      ? createEntry(meta.key, formValues.value)
      : updateEntry(meta.key, editingId.value, formValues.value)
  if (!result.ok) {
    formError.value = result.message
    return
  }
  showForm.value = false
  noticeMessage.value = result.message
  reload()
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  noticeMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  noticeMessage.value = result.message
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '航班保障列表读取失败'
  }
}

onMounted(reload)
</script>
