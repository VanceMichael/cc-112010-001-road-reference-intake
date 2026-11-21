// 车队投递：把各车队能使用的变动交付到它们的目录接口，并按实际确认与目录回查核实。
// 规则要点：
// - 每个车队只有一本可见通讯录，按键字段查号；跨部门短码冲突按终端实际
//   能区分的范围（该车队的键）发现，包括一个终端合用多个部门通讯录的情况。
// - 只认识短码的车队仍有旧点在途单时，原码保留给这些单；管理方批准的
//   替代码可让这类车队接新点的单；替代码未获准或未确认时只暂停该车队
//   有关新点的派车，其他点位照常。
// - 撤回必须指明撤的是哪条绑定（remove 只带 binding 标识），不能靠当前
//   短码把另一处仍在用的点一并移掉。
// - 发送过的变更按车队的实际回执和目录回查核实：回执可能暂缓可见，
//   目录可能先于回执更新，也可能断开后已经改好。
import { keyOf, shortHash } from './util.mjs'

export class FleetSync {
  constructor(client, store) {
    this.client = client
    this.store = store
    this.fleets = new Map() // fleetId -> 投递状态
  }

  state(info) {
    if (!this.fleets.has(info.id)) {
      this.fleets.set(info.id, {
        id: info.id,
        key: info.key,
        issuers: info.issuers,
        revision: null,
        entries: [],
        transmissions: new Map(), // transmission -> { status, base, actions, receipt }
        deliveries: new Map(),    // binding -> { state, code, point, why, via, detail }
        pauses: new Map(),        // point -> 暂停原因（前单未结且无可用替代码）
        conflicts: [],            // 终端可区分范围内发现的短码冲突
      })
    }
    const state = this.fleets.get(info.id)
    state.key = info.key
    state.issuers = info.issuers
    return state
  }

  async cycle() {
    const list = await this.client.get('/fleets')
    if (list.status !== 200 || !Array.isArray(list.body)) return { ok: false }
    for (const info of list.body) {
      const state = this.state(info)
      await this.refresh(state)
      await this.pollReceipts(state)
      const desired = this.desiredRows(state)
      const actions = this.diff(state, desired)
      if (actions.length) await this.send(state, actions)
      await this.refresh(state)
      this.verify(state, desired)
    }
    return { ok: true }
  }

  async refresh(state) {
    const res = await this.client.get(`/fleet/${state.id}/directory`)
    if (res.status !== 200 || !Array.isArray(res.body?.entries)) return
    state.revision = res.body.revision
    state.entries = res.body.entries
  }

  async pollReceipts(state) {
    for (const [id, record] of state.transmissions) {
      if (record.status !== 'pending') continue
      const res = await this.client.get(`/fleet/${state.id}/receipts?transmission=${encodeURIComponent(id)}`)
      if (res.status === 200) this.recordReceipt(record, res.body)
      else if (res.status === 404) record.status = 'lost' // 回执丢失：下轮按目录回查重算
      // 202：回执还不可见，保持 pending
    }
  }

  recordReceipt(record, receipt) {
    record.receipt = receipt
    record.status = receipt?.rejected?.length ? 'partial' : 'confirmed'
  }

  // 计算车队应当持有的行：现行绑定 + 在途单保留行 + 批准的替代码行。
  desiredRows(state) {
    const rows = []
    state.pauses.clear()
    state.conflicts = []
    for (const binding of this.store.activeBindings(state.issuers)) {
      rows.push({
        row: { binding: binding.binding, point: binding.point, code: binding.code, issuer: binding.issuer },
        why: 'active',
      })
    }
    // 在途单保留：旧绑定已停用而车队目录里仍有该行，且终端按键无法区分新旧时保留原码
    const present = new Map(state.entries.map(entry => [entry.binding, entry]))
    for (const job of this.store.inflightJobs(state.id)) {
      const binding = this.store.bindings.get(job.assigned.binding)
      if (!binding || binding.status !== 'retired' || !present.has(binding.binding)) continue
      const retained = { binding: binding.binding, point: binding.point, code: binding.code, issuer: binding.issuer }
      const clash = rows.find(item => keyOf(item.row, state.key) === keyOf(retained, state.key))
      if (!clash) continue // 终端能区分新旧版本，无需保留，正常撤回旧行
      if (clash.why === 'retained') { // 两笔在途单争同一个键：只能留先到的，如实记录
        if (clash.row.binding !== binding.binding) {
          state.conflicts.push({
            fleet: state.id, key: keyOf(retained, state.key),
            bindings: [clash.row.binding, binding.binding], resolution: 'conflict',
          })
        }
        continue
      }
      rows.push({ row: retained, why: 'retained', job: job.job })
      const alias = this.store.approvedAlias(binding.area, clash.row.point)
      if (alias) {
        state.conflicts.push({
          fleet: state.id, key: keyOf(retained, state.key),
          bindings: [binding.binding, clash.row.binding], resolution: 'alias', alias,
        })
        clash.row = { ...clash.row, code: alias }
        clash.why = 'alias'
      } else {
        rows.splice(rows.indexOf(clash), 1)
        state.pauses.set(clash.row.point, `前单 ${job.job} 未结，短码 ${binding.code} 保留给旧点，替代码未获准`)
        state.conflicts.push({
          fleet: state.id, key: keyOf(retained, state.key),
          bindings: [binding.binding, clash.row.binding], resolution: 'pause',
        })
      }
    }
    // 终端可区分范围内的其余冲突（如两个部门同码、同一终端合用两本通讯录）：
    // 键一旦冲突即被标记，该键上的现行点位都暂停投递，在途单保留行不受影响。
    const byKey = new Map()
    const poisoned = new Set()
    const kept = []
    const pauseIfActive = item => {
      if (item.why === 'active') {
        state.pauses.set(item.row.point, `短码 ${item.row.code} 在终端 ${state.id} 上与其他签发方冲突`)
      }
    }
    for (const item of rows) {
      const key = keyOf(item.row, state.key)
      const held = byKey.get(key)
      if (held && held.row.binding === item.row.binding) continue
      if (held || poisoned.has(key)) {
        poisoned.add(key)
        state.conflicts.push({
          fleet: state.id, key, resolution: 'conflict',
          bindings: [held?.row.binding, item.row.binding].filter(Boolean),
        })
        if (held) {
          pauseIfActive(held)
          const at = kept.indexOf(held)
          if (at !== -1 && held.why === 'active') kept.splice(at, 1)
        }
        pauseIfActive(item)
        if (item.why !== 'active') kept.push(item) // 在途单保留行必须留下
        continue
      }
      byKey.set(key, item)
      kept.push(item)
    }
    return kept
  }

  // 与车队当前目录比对：缺的/不一致的 upsert，明确停用且未保留的按绑定撤回。
  diff(state, desired) {
    const actions = []
    const currentByKey = new Map(state.entries.map(entry => [keyOf(entry, state.key), entry]))
    const retainedIds = new Set(desired.filter(item => item.why === 'retained').map(item => item.row.binding))
    for (const entry of state.entries) {
      const known = this.store.bindings.get(entry.binding)
      if (known?.status === 'retired' && !retainedIds.has(entry.binding)) {
        actions.push({ op: 'remove', binding: { binding: entry.binding } })
      }
    }
    for (const { row } of desired) {
      const current = currentByKey.get(keyOf(row, state.key))
      if (current && current.binding === row.binding && current.point === row.point
          && current.code === row.code && current.issuer === row.issuer) continue
      actions.push({ op: 'upsert', binding: row })
    }
    return actions
  }

  async send(state, actions) {
    const base = state.revision
    const baseId = `t-${state.id}-${base}-${shortHash(actions)}`
    const known = state.transmissions.get(baseId)
    if (known && ['pending', 'confirmed'].includes(known.status)) return
    // 部分拒收/失败/回执丢失的传输：内容不变时同号重发只会拿到旧回执，
    // 需要换新传输号重投；首次发送或网络未达后的同号重发是安全幂等的。
    const transmission = known ? `${baseId}#${(state.retries = (state.retries ?? 0) + 1)}` : baseId
    const res = await this.client.post(`/fleet/${state.id}/send`, { base, transmission, actions })
    if (res.status === 200 || res.status === 207) {
      const record = { status: null, base, actions, receipt: res.body }
      this.recordReceipt(record, res.body)
      state.transmissions.set(transmission, record)
    } else if (res.status === 503) {
      // 车队已收下但回执暂不可读：目录可能已改好，靠回查与后续回执核实
      state.transmissions.set(transmission, { status: 'pending', base, actions, receipt: null })
    } else if (res.status === 409) {
      // base 过时或同号内容变化：重读目录，下轮按新 base 重算
      state.transmissions.set(transmission, { status: 'failed', base, actions, receipt: res.body })
      await this.refresh(state)
    }
  }

  // 核实：目录回查为准，回执给出逐条实收结果与拒收原因。
  verify(state, desired) {
    const currentByKey = new Map(state.entries.map(entry => [keyOf(entry, state.key), entry]))
    for (const { row, why } of desired) {
      const current = currentByKey.get(keyOf(row, state.key))
      const present = current && current.binding === row.binding && current.point === row.point
        && current.code === row.code
      const record = this.transmissionFor(state, row.binding)
      const accepted = record?.receipt?.accepted?.includes(row.binding)
      const rejected = record?.receipt?.rejected?.find(item => item.binding === row.binding)
      state.deliveries.set(row.binding, {
        binding: row.binding,
        point: row.point,
        code: row.code,
        why,
        state: present ? 'confirmed' : rejected ? 'rejected' : record ? 'sent' : 'missing',
        via: present ? (accepted ? 'receipt+readback' : 'readback') : null,
        detail: rejected?.reason ?? null,
      })
    }
  }

  transmissionFor(state, binding) {
    let found = null
    for (const record of state.transmissions.values()) {
      if (record.actions?.some(action => action.binding.binding === binding)) found = record
    }
    return found
  }

  fleetView() {
    return [...this.fleets.values()].map(state => ({
      id: state.id,
      key: state.key,
      issuers: state.issuers,
      revision: state.revision,
      entries: state.entries,
      deliveries: [...state.deliveries.values()],
      pauses: [...state.pauses.entries()].map(([point, reason]) => ({ point, reason })),
      conflicts: state.conflicts,
      transmissions: [...state.transmissions.entries()].map(([id, record]) => ({
        transmission: id,
        status: record.status,
        base: record.base,
        accepted: record.receipt?.accepted ?? null,
        rejected: record.receipt?.rejected ?? null,
      })),
    }))
  }
}
