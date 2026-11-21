// 采集器：从管理方来源收齐全量册、变动流水和交接声明，从接线台读取救援单。
// 规则要点：
// - 全量册翻页时下一版可能已发出：页与页的 edition/through 必须一致，
//   409 表示翻页中途换版，须从首页重收；重收仍不齐则保持旧数据并标记分段未齐。
// - 序列缺口、失效游标(410)、转发方重送，都按源方证实的切面重新收齐（转全量）。
// - 旧方停发后新方增量可先到：未取得交接声明的一侧只预收；声明须覆盖
//   对应地区、旧方末笔和新方起笔，核实后预收记录才转正。
// - 没有变动的一侧仍继续采集；切面之后的新变动用 through 给出的游标继续跟随。
import { parseCursor, cursorFrom, deepEqual } from './util.mjs'

const MAX_FULL_RESTARTS = 3

export class Collector {
  constructor(client, store) {
    this.client = client
    this.store = store
  }

  async cycle() {
    const sources = await this.client.get('/sources')
    if (sources.status !== 200) return { ok: false, reason: 'sourcesUnavailable' }
    const handoffs = await this.client.get('/handoffs')
    if (handoffs.status === 200) this.store.setHandoffs(handoffs.body)
    for (const region of sources.body.regions ?? []) {
      try {
        await this.syncArea(region)
      } catch (error) {
        this.store.area(region.area).error = String(error?.message ?? error)
      }
    }
    const jobs = await this.client.get('/control/jobs')
    if (jobs.status === 200) this.store.applyJobs(jobs.body)
    return { ok: true }
  }

  async syncArea(region) {
    const area = this.store.area(region.area)
    if (area.needsFull) await this.loadFull(region, area)

    // 跟随各签发方流水：现行签发方必跟；交接中的新方预收；旧方停发后以交接声明为准。
    // 签发方已切换但交接声明未覆盖时，新方增量同样只预收。
    const follow = []
    if (region.activeIssuer && region.updates) {
      const swapped = region.priorIssuer && region.priorIssuer !== region.activeIssuer
      const role = swapped && !area.handover?.complete ? 'incoming' : 'active'
      follow.push({ issuer: region.activeIssuer, updates: region.updates, role })
    }
    if (region.incomingIssuer && region.incomingUpdates) {
      follow.push({ issuer: region.incomingIssuer, updates: region.incomingUpdates, role: 'incoming' })
    }
    for (const item of follow) await this.followStream(region, area, item)

    // 流水暴露的缺口/失效/重送在同一轮内按切面补齐
    if (area.needsFull) await this.loadFull(region, area)

    this.checkHandover(region, area)
  }

  // 全量册：同一批页必须属于同一切面（edition 与 through 完全一致），
  // 不能把两个版本的页拼在一起；收齐后用 through 推进游标，切面之后的
  // 新变动由随后的流水跟随补上，不会丢掉。
  async loadFull(region, area) {
    let url = region.full
    let edition = null
    let through = null
    let entries = []
    let restarts = 0
    while (true) {
      const res = await this.client.get(url)
      if (res.status === 409) {
        // 翻页中途换版：从来源指出的首页重收
        if (++restarts > MAX_FULL_RESTARTS) return this.markIncomplete(area)
        url = res.body?.restart ?? region.full
        edition = through = null
        entries = []
        continue
      }
      if (res.status !== 200 || !res.body?.edition) return this.markIncomplete(area)
      const page = res.body
      if (edition === null) {
        edition = page.edition
        through = page.through
      } else if (page.edition !== edition || !deepEqual(page.through, through)) {
        if (++restarts > MAX_FULL_RESTARTS) return this.markIncomplete(area)
        url = region.full
        edition = through = null
        entries = []
        continue
      }
      entries.push(...(page.entries ?? []))
      if (!page.next) break
      url = page.next
    }
    this.store.applyFull(region.area, { edition, through, entries })
    // through 只给序号；游标前缀从已知游标或流水地址补全
    for (const [issuer, seq] of Object.entries(through)) {
      const stream = this.store.stream(region.area, issuer)
      if (!stream.cursor) {
        const prefix = this.prefixFor(region, issuer)
        if (prefix) stream.cursor = cursorFrom(prefix, seq)
      }
    }
  }

  markIncomplete(area) {
    area.fullState = 'incomplete' // 分段未齐：保留旧数据，下轮继续重收
    return false
  }

  prefixFor(region, issuer) {
    const stream = this.store.stream(region.area, issuer)
    const known = stream.cursor && parseCursor(stream.cursor)
    if (known) return known.prefix
    const url = issuer === region.activeIssuer ? region.updates
      : issuer === region.incomingIssuer ? region.incomingUpdates : null
    return url?.match(/[?&]after=([A-Za-z]+)\d+/)?.[1] ?? null
  }

  async followStream(region, area, { issuer, updates, role }) {
    const stream = this.store.stream(region.area, issuer)
    const parsed = new URL(updates, 'http://source')
    stream.base = parsed.pathname
    if (!stream.cursor) {
      stream.cursor = parsed.searchParams.get('after')
        ?? (issuer === region.activeIssuer ? region.after : null)
    }
    if (!stream.cursor || stream.final) return
    // 游标即“已确认到第几笔”的凭证：以游标序号对齐连续性检查的起点
    const cursorSeq = parseCursor(stream.cursor)?.seq
    if (cursorSeq != null && stream.lastSeq < cursorSeq) stream.lastSeq = cursorSeq
    // 区域待重收时，现行一侧暂停（游标可能失效）；新方一侧仍可预收，
    // 预收记录不进现行视图，切面收齐后由 through 重新对齐。
    if (area.needsFull && role !== 'incoming') return

    const res = await this.client.get(`${stream.base}?after=${stream.cursor}`)
    if (res.status === 410) { // 失效游标：按源方证实的切面重新收齐
      area.needsFull = true
      return
    }
    if (res.status === 404) { // 暂时查不到：保持现状，下轮再试
      stream.unavailable = true
      return
    }
    if (res.status !== 200 || !Array.isArray(res.body?.records)) return
    stream.unavailable = false

    const fresh = []
    for (const record of res.body.records) {
      if (typeof record.seq !== 'number') return
      if (record.seq <= stream.lastSeq) { // 转发方重送：不能去重了事，转全量收齐
        area.needsFull = true
        return
      }
      if (record.seq !== stream.lastSeq + fresh.length + 1) { // 序列缺口
        area.needsFull = true
        return
      }
      fresh.push(record)
    }
    for (const record of fresh) {
      stream.lastSeq = record.seq
      if (role === 'incoming' && !area.handover?.complete) {
        // 没取得声明的一侧只预收，不进入现行视图
        stream.pre.push(record)
        this.store.applyBinding(region.area, issuer, record.seq, record.binding, 'pre', 'stream')
      } else {
        const status = record.binding.action === 'retire' ? 'retired' : 'active'
        this.store.applyBinding(region.area, issuer, record.seq, record.binding, status, 'stream')
      }
    }
    if (typeof res.body.nextCursor === 'string') {
      const parsedCursor = parseCursor(res.body.nextCursor)
      const own = parseCursor(stream.cursor)
      if (parsedCursor && own && parsedCursor.prefix === own.prefix) {
        stream.cursor = res.body.nextCursor // 游标连同签发方使用，前缀必须一致
      } else if (parsedCursor && !own) {
        stream.cursor = res.body.nextCursor
      }
    }
  }

  // 交接声明须覆盖对应地区、旧方末笔和新方起笔；核实后预收转正，旧方停发。
  checkHandover(region, area) {
    if (area.handover?.complete) return
    const handoff = this.store.handoffFor(region.area)
    if (!handoff) return
    const outgoing = this.store.stream(region.area, handoff.outgoing)
    const incoming = this.store.stream(region.area, handoff.incoming)
    const outSeq = Math.max(outgoing.lastSeq, area.through[handoff.outgoing] ?? -1)
    const inSeq = Math.max(incoming.lastSeq, area.through[handoff.incoming] ?? -1)
    if (outSeq < handoff.last) return   // 旧方末笔尚未由切面或流水证实
    if (inSeq < handoff.first) return   // 新方起笔尚未收齐

    for (const record of incoming.pre.filter(item => item.seq >= handoff.first)) {
      const status = record.binding.action === 'retire' ? 'retired' : 'active'
      this.store.applyBinding(region.area, handoff.incoming, record.seq, record.binding, status, 'stream')
    }
    incoming.pre = []
    outgoing.final = true
    area.handover = { ...handoff, complete: true }
  }
}
