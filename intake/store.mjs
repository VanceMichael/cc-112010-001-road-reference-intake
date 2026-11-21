// 目录采集的物化状态：绑定、交接声明、救援单。
// 绑定状态语义：
//   active  —— 现行有效（全量册切面或已生效流水证实）
//   retired —— 管理方明确停用（只有 retire 记录才算，旧表漏行不算）
//   pre     —— 预收：交接声明未覆盖前，新签发方的增量只预收不生效
import { parseCursor, cursorFrom } from './util.mjs'

export class Store {
  constructor() {
    this.areas = new Map()     // area -> 区域采集状态
    this.bindings = new Map()  // bindingId -> 绑定记录
    this.jobs = new Map()      // jobId -> 救援单（含分配时快照）
    this.handoffs = []         // 交接声明（按内容去重）
  }

  area(name) {
    if (!this.areas.has(name)) {
      this.areas.set(name, {
        area: name,
        needsFull: true,        // 需要按源方证实的切面重新收齐
        fullState: 'pending',   // pending | ok | incomplete（分段未齐）
        edition: null,
        through: {},            // 切面包含的各签发方末笔
        streams: new Map(),     // issuer -> 流水状态
        handover: null,         // 已核实的交接声明
        error: null,
      })
    }
    return this.areas.get(name)
  }

  stream(areaName, issuer) {
    const area = this.area(areaName)
    if (!area.streams.has(issuer)) {
      area.streams.set(issuer, {
        issuer,
        base: null,        // 流水地址（不含查询串）
        cursor: null,      // 已确认的游标
        lastSeq: -1,       // 已连续收到的末笔序号
        pre: [],           // 预收记录（交接声明未覆盖）
        final: false,      // 旧方已停发
        unavailable: false,
      })
    }
    return area.streams.get(issuer)
  }

  // 应用一条绑定记录。status 为 pre 时表示预收，不进入现行视图。
  applyBinding(areaName, issuer, seq, record, status, source) {
    const id = record.binding
    const previous = this.bindings.get(id)
    const next = {
      binding: id,
      point: record.point,
      code: record.code,
      issuer: record.issuer ?? issuer,
      purpose: record.purpose ?? previous?.purpose ?? null,
      markerKm: record.markerKm ?? previous?.markerKm ?? null,
      replacementCode: record.replacementCode ?? null,
      area: areaName,
      status,
      at: seq != null ? { issuer, seq } : previous?.at ?? null,
      source,
    }
    this.bindings.set(id, next)
    return next
  }

  // 全量册切面落库：只按册内条目 upsert/停用，漏行的旧绑定保持原状，
  // 不能看成管理方注销了它。落库后按 through 推进各签发方游标。
  applyFull(areaName, { edition, through, entries }) {
    const area = this.area(areaName)
    for (const entry of entries) {
      const status = entry.action === 'retire' ? 'retired' : 'active'
      this.applyBinding(areaName, entry.issuer, null, entry, status, 'full')
    }
    area.edition = edition
    area.through = { ...through }
    for (const [issuer, seq] of Object.entries(through)) {
      const stream = this.stream(areaName, issuer)
      stream.lastSeq = Math.max(stream.lastSeq, seq)
      const prefix = stream.cursor ? parseCursor(stream.cursor)?.prefix : null
      if (prefix) stream.cursor = cursorFrom(prefix, stream.lastSeq)
    }
    area.needsFull = false
    area.fullState = 'ok'
    area.error = null
  }

  // 交接声明按内容去重；同一记录可随多个视图重送。
  setHandoffs(list) {
    const seen = new Map()
    for (const item of Array.isArray(list) ? list : []) {
      const key = [item.area, item.outgoing, item.last, item.incoming, item.first].join('/')
      if (!seen.has(key)) seen.set(key, item)
    }
    this.handoffs = [...seen.values()]
  }

  handoffFor(areaName) {
    return this.handoffs.find(item => item.area === areaName) ?? null
  }

  // 只有交接声明中为对应点位批准的替代码才可用；流水里的 replacementCode 只是候选。
  approvedAlias(areaName, point) {
    const handoff = this.handoffFor(areaName)
    const hit = handoff?.approvedAliases?.find(alias => alias.point === point)
    return hit?.code ?? null
  }

  applyJobs(list) {
    const seen = new Set()
    for (const item of Array.isArray(list) ? list : []) {
      seen.add(item.job)
      const existing = this.jobs.get(item.job)
      if (!existing) {
        this.jobs.set(item.job, {
          job: item.job,
          fleet: item.fleet,
          status: item.status,
          // 分配时快照：此后换绑、结单都不影响旧单当时所用的码和点位
          assigned: { binding: item.binding, code: item.code, point: item.point },
          history: [{ status: item.status }],
        })
      } else if (existing.status !== item.status) {
        existing.status = item.status
        existing.history.push({ status: item.status })
      }
    }
    // 接线台列表是在办与已结清单的权威来源：未结清却从列表消失的单不再占用定位码
    for (const job of this.jobs.values()) {
      if (!seen.has(job.job) && job.status !== 'closed' && job.status !== 'unlisted') {
        job.status = 'unlisted'
        job.history.push({ status: 'unlisted' })
      }
    }
  }

  inflightJobs(fleetId = null) {
    return [...this.jobs.values()].filter(job =>
      !['closed', 'unlisted'].includes(job.status) && (fleetId === null || job.fleet === fleetId))
  }

  activeBindings(issuers = null) {
    return [...this.bindings.values()].filter(row =>
      row.status === 'active' && (issuers === null || issuers.includes(row.issuer)))
  }

  // 查询结果区分：现行 active / 明确停用 retired / 分段未齐 incomplete / 暂时查不到 unknown
  lookup({ area = null, issuer = null, code = null, point = null }) {
    const rows = [...this.bindings.values()].filter(row =>
      (area === null || row.area === area) &&
      (issuer === null || row.issuer === issuer) &&
      (code === null || row.code === code) &&
      (point === null || row.point === point))
    const group = status => rows.filter(row => row.status === status)
    const result = {
      active: group('active'),
      retired: group('retired'),
      pending: group('pre'),
      stale: false,
    }
    if (result.active.length) result.status = 'active'
    else if (result.pending.length) result.status = 'incomplete'
    else if (result.retired.length) result.status = 'retired'
    else result.status = 'unknown'
    const areas = new Set(rows.map(row => row.area))
    if (area) areas.add(area)
    result.stale = [...areas].some(name => this.areas.get(name)?.needsFull)
    return result
  }

  areaView() {
    return [...this.areas.values()].map(area => ({
      area: area.area,
      edition: area.edition,
      through: area.through,
      resync: area.needsFull,
      fullState: area.fullState,
      handover: area.handover,
      error: area.error,
      streams: [...area.streams.values()].map(stream => ({
        issuer: stream.issuer,
        cursor: stream.cursor,
        lastSeq: stream.lastSeq,
        preCollected: stream.pre.length,
        final: stream.final,
        unavailable: stream.unavailable,
      })),
    }))
  }
}
