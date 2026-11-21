import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Store } from '../intake/store.mjs'
import { FleetSync } from '../intake/fleets.mjs'

function storeWith(entries, area = 'north') {
  const store = new Store()
  store.applyFull(area, { edition: 'N1', through: { hill: 5 }, entries })
  return store
}

test('跨部门同码冲突按终端可区分范围发现', () => {
  const store = new Store()
  store.applyFull('north', { edition: 'N1', through: { hill: 5 }, entries: [
    { binding: 'B1-hill-K19', point: 'P-42', code: 'K19', issuer: 'hill', action: 'bind' },
  ] })
  store.applyFull('south', { edition: 'S1', through: { city: 9 }, entries: [
    { binding: 'B9-city-K19', point: 'P-99', code: 'K19', issuer: 'city', action: 'bind' },
  ] })
  const fleets = new FleetSync(null, store)

  // 同一终端合用两个部门通讯录、只按短码查号：冲突被发现，两个点位都暂停
  const legacy = fleets.state({ id: 'legacy', key: ['code'], issuers: ['hill', 'city'] })
  legacy.entries = []
  const rows = fleets.desiredRows(legacy)
  assert.equal(rows.length, 0)
  assert.deepEqual([...legacy.pauses.keys()].sort(), ['P-42', 'P-99'])
  assert.ok(legacy.conflicts.some(c => c.resolution === 'conflict'
    && c.bindings.includes('B1-hill-K19') && c.bindings.includes('B9-city-K19')))

  // 能区分版本的终端：两本通讯录并存，无冲突
  const modern = fleets.state({ id: 'modern', key: ['issuer', 'code', 'binding'], issuers: ['hill', 'city'] })
  modern.entries = []
  const modernRows = fleets.desiredRows(modern)
  assert.equal(modernRows.length, 2)
  assert.equal(modern.conflicts.length, 0)
  assert.equal(modern.pauses.size, 0)
})

test('在途单占用旧码且无替代码：只暂停该车队新点派车，其他点位照常', () => {
  const store = storeWith([
    { binding: 'B0-river-K19', point: 'P-19', code: 'K19', issuer: 'river', action: 'retire' },
    { binding: 'B0-river-K20', point: 'P-20', code: 'K20', issuer: 'river', action: 'retire' },
    { binding: 'B1-hill-K19', point: 'P-42', code: 'K19', issuer: 'hill', action: 'bind' },
    { binding: 'B1-hill-K20', point: 'P-21', code: 'K20', issuer: 'hill', action: 'bind' },
  ])
  store.applyJobs([{ job: 'R-7', fleet: 'legacy', point: 'P-19', binding: 'B0-river-K19', code: 'K19', status: 'dispatched' }])
  const fleets = new FleetSync(null, store)
  const legacy = fleets.state({ id: 'legacy', key: ['code'], issuers: ['river', 'hill'] })
  legacy.entries = [
    { binding: 'B0-river-K19', point: 'P-19', code: 'K19', issuer: 'river' },
    { binding: 'B0-river-K20', point: 'P-20', code: 'K20', issuer: 'river' },
  ]
  const rows = fleets.desiredRows(legacy)
  // 旧码留给在途单；K19 新点暂停；K20 照常投递
  assert.ok(rows.some(r => r.why === 'retained' && r.row.code === 'K19' && r.row.point === 'P-19'))
  assert.ok(!rows.some(r => r.row.point === 'P-42'))
  assert.ok(rows.some(r => r.row.point === 'P-21'))
  assert.ok(legacy.pauses.has('P-42'))
  assert.equal(legacy.pauses.has('P-21'), false)
  // 撤回只针对明确停用且未保留的绑定
  const actions = fleets.diff(legacy, rows)
  assert.deepEqual(actions.filter(a => a.op === 'remove').map(a => a.binding.binding), ['B0-river-K20'])
  assert.ok(actions.some(a => a.op === 'upsert' && a.binding.point === 'P-21'))
  // 保留行不产生任何动作（旧单在途，原码不动）
  assert.ok(!actions.some(a => a.binding.binding === 'B0-river-K19'))
})

test('替代码未获准前新点暂停；获准后该车队可用替代码接单', () => {
  const entries = [
    { binding: 'B0-river-K19', point: 'P-19', code: 'K19', issuer: 'river', action: 'retire' },
    { binding: 'B1-hill-K19', point: 'P-42', code: 'K19', issuer: 'hill', action: 'bind', replacementCode: 'L42' },
  ]
  // 只有源方候选、声明未批准：暂停
  let store = storeWith(entries)
  store.applyJobs([{ job: 'R-7', fleet: 'legacy', point: 'P-19', binding: 'B0-river-K19', code: 'K19', status: 'dispatched' }])
  let fleets = new FleetSync(null, store)
  let legacy = fleets.state({ id: 'legacy', key: ['code'], issuers: ['river', 'hill'] })
  legacy.entries = [{ binding: 'B0-river-K19', point: 'P-19', code: 'K19', issuer: 'river' }]
  let rows = fleets.desiredRows(legacy)
  assert.ok(!rows.some(r => r.row.point === 'P-42'))
  assert.ok(legacy.pauses.has('P-42'))

  // 声明批准后：替代码行出现，绑定标识仍是新绑定
  store = storeWith(entries)
  store.setHandoffs([{ area: 'north', outgoing: 'river', last: 72, incoming: 'hill', first: 1, approvedAliases: [{ point: 'P-42', code: 'L42' }] }])
  store.applyJobs([{ job: 'R-7', fleet: 'legacy', point: 'P-19', binding: 'B0-river-K19', code: 'K19', status: 'dispatched' }])
  fleets = new FleetSync(null, store)
  legacy = fleets.state({ id: 'legacy', key: ['code'], issuers: ['river', 'hill'] })
  legacy.entries = [{ binding: 'B0-river-K19', point: 'P-19', code: 'K19', issuer: 'river' }]
  rows = fleets.desiredRows(legacy)
  const alias = rows.find(r => r.why === 'alias')
  assert.equal(alias.row.code, 'L42')
  assert.equal(alias.row.binding, 'B1-hill-K19')
  assert.equal(legacy.pauses.size, 0)
})

test('撤回按绑定标识执行，不按当前短码牵连他点', () => {
  const store = storeWith([
    { binding: 'B1-hill-K19', point: 'P-42', code: 'K19', issuer: 'hill', action: 'retire' },
    { binding: 'B2-hill-K19', point: 'P-43', code: 'K19', issuer: 'hill', action: 'bind' },
  ])
  const fleets = new FleetSync(null, store)
  const modern = fleets.state({ id: 'modern', key: ['issuer', 'code', 'binding'], issuers: ['hill'] })
  modern.entries = [
    { binding: 'B1-hill-K19', point: 'P-42', code: 'K19', issuer: 'hill' },
  ]
  const rows = fleets.desiredRows(modern)
  const actions = fleets.diff(modern, rows)
  // remove 只带被撤绑定的标识；同码的新绑定是独立 upsert
  const remove = actions.find(a => a.op === 'remove')
  assert.deepEqual(remove.binding, { binding: 'B1-hill-K19' })
  assert.ok(actions.some(a => a.op === 'upsert' && a.binding.binding === 'B2-hill-K19' && a.binding.point === 'P-43'))
})

test('部分拒收的变更换新传输号重投，回读确认', async () => {
  const store = storeWith([
    { binding: 'B1-hill-K20', point: 'P-21', code: 'K20', issuer: 'hill', action: 'bind' },
  ])
  const sent = []
  let accept = false
  let directory = { revision: 'L6', entries: [] }
  const client = {
    async get(path) {
      if (path === '/fleets') return { status: 200, body: [{ id: 'f', key: ['code'], issuers: ['hill'] }] }
      if (path === '/fleet/f/directory') return { status: 200, body: directory }
      return { status: 404, body: null }
    },
    async post(path, payload) {
      sent.push(payload)
      if (!accept) {
        return { status: 207, body: { transmission: payload.transmission, base: payload.base, revision: 'L6', accepted: [], rejected: [{ binding: 'B1-hill-K20', reason: '车队暂缓编辑 K20' }] } }
      }
      directory = { revision: 'L7', entries: payload.actions.filter(a => a.op === 'upsert').map(a => a.binding) }
      return { status: 200, body: { transmission: payload.transmission, base: payload.base, revision: 'L7', accepted: ['B1-hill-K20'], rejected: [] } }
    },
  }
  const fleets = new FleetSync(client, store)
  await fleets.cycle()
  assert.equal(sent.length, 1)
  assert.equal(fleets.fleets.get('f').deliveries.get('B1-hill-K20').state, 'rejected')
  accept = true
  await fleets.cycle()
  assert.equal(sent.length, 2)
  assert.notEqual(sent[0].transmission, sent[1].transmission) // 重投必须换新传输号
  assert.equal(fleets.fleets.get('f').deliveries.get('B1-hill-K20').state, 'confirmed')
  // 目录已一致：不再产生新传输
  await fleets.cycle()
  assert.equal(sent.length, 2)
})

test('未结清却从接线台列表消失的单不再占用定位码', () => {
  const store = new Store()
  store.applyJobs([{ job: 'R-1', fleet: 'f', point: 'P-1', binding: 'B-1', code: 'K1', status: 'dispatched' }])
  assert.equal(store.inflightJobs().length, 1)
  store.applyJobs([])
  assert.equal(store.inflightJobs().length, 0)
  assert.equal(store.jobs.get('R-1').status, 'unlisted')
  assert.equal(store.jobs.get('R-1').assigned.code, 'K1') // 当时所用仍可查
})
