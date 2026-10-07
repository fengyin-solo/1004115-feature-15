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

    <section class="rule-banner">
      <p class="rule-title">节点阈值规则（规则调整后只重判未结束航班，历史结论保持原口径）</p>
      <ul class="rule-list">
        <li>按航班号、机尾号、计划到港、实际到港判定保障节点，另须已填报保障节点；全部达标才允许进入「保障中」，缺保障节点或归属不允许保存。</li>
        <li>航班号形如 CA1858（2位字母/数字代码 + 3~4位数字），机尾号形如 B-6512（B- 开头注册号）；实际到港相对计划到港早到不超过3小时、晚到不超过24小时。</li>
        <li>延误与人工放行冲突时以安全放行为准：「已就绪」是最终结论，锁定后不再接受标记延误等任何流转。</li>
        <li>启动保障会在过站监控清单同步计时任务，安全放行同步收口为正常完成；重复确认只生效一次。</li>
      </ul>
      <p v-if="rejudgedCount" class="rule-rejudge">本次规则切换已重判 {{ rejudgedCount }} 个未结束航班，原因见对应行「当前状态」下方说明。</p>
    </section>

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
          <td>
            {{ row.status }}
            <span v-if="row['阈值重判说明']" class="cell-note">{{ row['阈值重判说明'] }}</span>
          </td>
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
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无航班保障数据，可先登记航班保障</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条航班保障记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('flight_ops')
const columns = ["航班号", "机尾号", "计划到港", "实际到港", "计划离港", "预计离港", "保障节点", "保障状态"]
const actions = ["启动保障", "确认就绪", "标记延误"]
const statuses = ["待保障", "保障中", "已就绪", "已延误"]
const stats = [{"label": "待保障航班", "value": 0}, {"label": "保障中航班", "value": 0}, {"label": "延误航班", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const rejudgedCount = computed(
  () => rows.value.filter((row) => Boolean(row['阈值重判说明'])).length,
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '航班保障登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
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
