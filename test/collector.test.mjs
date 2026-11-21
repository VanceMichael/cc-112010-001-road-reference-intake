import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Store } from '../intake/store.mjs'
import { Collector } from '../intake/collector.mjs'

// 用可编排的假来源驱动采集器，覆盖演练数据没有的异常分支
function fakeClient(routes) {
  const calls = []
  return {
    calls,
    async get(path) {
      calls.push(path)
      const hit = routes[path]
      if (!hit) return { status: 404, body: { 原因: '没有这项资料' } }
      const value = typeof hit === 'function' ? hit() : hit
      return { status: value.status ?? 200, body: value.body }
    },
    async post() {
      return { status: 404, body: null }
    },
  }
}

const region = {
  area: 'north',
  activeIssuer: 'river',
  full: '/catalog/north',
  after: 'r71',
  updates: '/changes/river',
}

const fullPage = (edition, through, entries, next = null) => ({
  status: 200,
  body: { edition, area: 'north', through, entries, next },
})

test('序列缺口、转发方重送、失效游标都转为按切面重收', async () => {
  const catalogCalls = client => client.calls.filter(path => path === '/catalog/north').length

  // 序列缺口
  let store = new Store()
  let client = fakeClient({
    '/sources': { body: { regions: [region] } },
    '/handoffs': { body: [] },
    '/catalog/north': fullPage('N6', { river: 71 }, []),
    '/changes/river?after=r71': {
      body: { area: 'north', issuer: 'river', records: [
        { seq: 73, at: 't', binding: { binding: 'B-x', point: 'P-x', code: 'K73', issuer: 'river', action: 'bind' } },
      ], nextCursor: 'r73' },
    },
    '/control/jobs': { body: [] },
  })
  await new Collector(client, store).cycle()
  assert.equal(catalogCalls(client), 2) // 缺口后按源方证实的切面重新收齐
  assert.equal(store.bindings.has('B-x'), false) // 缺口之后的记录不采信

  // 转发方重送：已确认的序号再次出现
  store = new Store()
  client = fakeClient({
    '/sources': { body: { regions: [region] } },
    '/handoffs': { body: [] },
    '/catalog/north': fullPage('N6', { river: 71 }, []),
    '/changes/river?after=r71': {
      body: { area: 'north', issuer: 'river', records: [
        { seq: 70, at: 't', binding: { binding: 'B-y', point: 'P-y', code: 'K70', issuer: 'river', action: 'bind' } },
      ], nextCursor: 'r71' },
    },
    '/control/jobs': { body: [] },
  })
  await new Collector(client, store).cycle()
  assert.equal(catalogCalls(client), 2)
  assert.equal(store.bindings.has('B-y'), false)

  // 失效游标 410
  store = new Store()
  client = fakeClient({
    '/sources': { body: { regions: [region] } },
    '/handoffs': { body: [] },
    '/catalog/north': fullPage('N6', { river: 71 }, []),
    '/changes/river?after=r71': { status: 410, body: { reason: 'cursorExpired', full: '/catalog/north' } },
    '/control/jobs': { body: [] },
  })
  await new Collector(client, store).cycle()
  assert.equal(catalogCalls(client), 2)
  assert.equal(store.area('north').needsFull, false) // 切面收齐，重收完成
})

test('全量册翻页不得拼接两个版本，换版从首页重收', async () => {
  const store = new Store()
  let p2Calls = 0
  const client = fakeClient({
    '/sources': { body: { regions: [region] } },
    '/handoffs': { body: [] },
    '/catalog/north': fullPage('N6', { river: 71 }, [
      { binding: 'B0-river-K19', point: 'P-19', code: 'K19', issuer: 'river', action: 'bind' },
    ], '/catalog/north/N6/p2'),
    '/catalog/north/N6/p2': () => {
      p2Calls += 1
      // 前两页分属不同切面：服务应重收；重收后来源给出同一切面的完整两页
      if (p2Calls === 1) {
        return fullPage('N7', { river: 72 }, [
          { binding: 'B0-river-K20', point: 'P-20', code: 'K20', issuer: 'river', action: 'bind' },
        ])
      }
      return fullPage('N6', { river: 71 }, [
        { binding: 'B0-river-K20', point: 'P-20', code: 'K20', issuer: 'river', action: 'bind' },
      ])
    },
    '/changes/river?after=r71': { body: { area: 'north', issuer: 'river', records: [], nextCursor: 'r71' } },
    '/control/jobs': { body: [] },
  })
  await new Collector(client, store).cycle()
  const area = store.area('north')
  assert.equal(area.fullState, 'ok')
  assert.equal(area.edition, 'N6') // 重收后统一在 N6 切面，没有拼接 N7 的页
  assert.equal(area.through.river, 71)
  assert.equal(store.bindings.get('B0-river-K20').status, 'active')
})

test('翻页持续换版则分段未齐，旧数据保留', async () => {
  const store = new Store()
  store.applyFull('north', { edition: 'N5', through: { river: 70 }, entries: [
    { binding: 'B0-river-K19', point: 'P-19', code: 'K19', issuer: 'river', action: 'bind' },
  ] })
  const area = store.area('north')
  area.needsFull = true
  const client = fakeClient({
    '/sources': { body: { regions: [region] } },
    '/handoffs': { body: [] },
    '/catalog/north': fullPage('N6', { river: 71 }, [], '/catalog/north/N6/p2'),
    '/catalog/north/N6/p2': { status: 409, body: { reason: 'editionReplaced', restart: '/catalog/north' } },
    '/changes/river?after=r71': { status: 410, body: { reason: 'cursorExpired' } },
    '/control/jobs': { body: [] },
  })
  await new Collector(client, store).cycle()
  assert.equal(area.fullState, 'incomplete')
  assert.equal(area.needsFull, true)
  assert.equal(store.bindings.get('B0-river-K19').status, 'active') // 旧切面数据保留
})

test('旧表漏行不算管理方注销，只有明确 retire 才停用', async () => {
  const store = new Store()
  store.applyFull('north', { edition: 'N6', through: { river: 71 }, entries: [
    { binding: 'B0-river-K19', point: 'P-19', code: 'K19', issuer: 'river', action: 'bind' },
    { binding: 'B0-river-K20', point: 'P-20', code: 'K20', issuer: 'river', action: 'bind' },
  ] })
  // 下一版册里 K20 一行缺失：不得看成注销
  store.applyFull('north', { edition: 'N7', through: { river: 72 }, entries: [
    { binding: 'B0-river-K19', point: 'P-19', code: 'K19', issuer: 'river', action: 'bind' },
  ] })
  assert.equal(store.bindings.get('B0-river-K20').status, 'active')
  // 明确 retire 才停用
  store.applyFull('north', { edition: 'N8', through: { river: 73 }, entries: [
    { binding: 'B0-river-K19', point: 'P-19', code: 'K19', issuer: 'river', action: 'bind' },
    { binding: 'B0-river-K20', point: 'P-20', code: 'K20', issuer: 'river', action: 'retire' },
  ] })
  assert.equal(store.bindings.get('B0-river-K20').status, 'retired')
})

test('交接声明未覆盖时新方增量只预收，覆盖后转正', async () => {
  const store = new Store()
  const handoverRegion = {
    area: 'north',
    activeIssuer: 'river',
    incomingIssuer: 'hill',
    full: '/catalog/north',
    after: 'r71',
    updates: '/changes/river',
    incomingUpdates: '/changes/hill?after=h0',
  }
  const hillSeq1 = {
    seq: 1, at: 't',
    binding: { binding: 'B1-hill-K19', point: 'P-42', code: 'K19', issuer: 'hill', action: 'bind', replacementCode: 'L42' },
  }
  const routes = {
    '/sources': { body: { regions: [handoverRegion] } },
    '/handoffs': { body: [] },
    '/catalog/north': fullPage('N6', { river: 71 }, [
      { binding: 'B0-river-K19', point: 'P-19', code: 'K19', issuer: 'river', action: 'bind' },
    ]),
    '/changes/river?after=r71': { body: { area: 'north', issuer: 'river', records: [], nextCursor: 'r71' } },
    '/changes/hill?after=h0': { body: { area: 'north', issuer: 'hill', records: [hillSeq1], nextCursor: 'h1' } },
    '/control/jobs': { body: [] },
  }
  const client = fakeClient(routes)
  const collector = new Collector(client, store)
  await collector.cycle()
  // 没有声明：P-42 仍是分段未齐，不进入现行视图
  assert.equal(store.lookup({ point: 'P-42' }).status, 'incomplete')
  assert.equal(store.lookup({ area: 'north', code: 'K19' }).active[0].point, 'P-19')

  // 声明未覆盖旧方末笔（要求 72，切面只到 71）：仍不转正
  routes['/handoffs'] = { body: [
    { area: 'north', outgoing: 'river', last: 72, incoming: 'hill', first: 1, approvedAliases: [] },
  ] }
  await collector.cycle()
  assert.equal(store.lookup({ point: 'P-42' }).status, 'incomplete')

  // 切面推进到旧方末笔后，声明确认，预收转正
  routes['/catalog/north'] = fullPage('N7', { river: 72 }, [
    { binding: 'B0-river-K19', point: 'P-19', code: 'K19', issuer: 'river', action: 'retire' },
  ])
  store.area('north').needsFull = true
  await collector.cycle()
  assert.equal(store.area('north').handover.complete, true)
  assert.equal(store.lookup({ point: 'P-42' }).status, 'active')
  assert.equal(store.lookup({ area: 'north', code: 'K19' }).retired[0].binding, 'B0-river-K19')
})
