import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'
import { makeSource } from '../source.mjs'
import { createIntakeService } from '../intake/service.mjs'

async function openPair(t) {
  const source = makeSource()
  source.listen(0, '127.0.0.1')
  await once(source, 'listening')
  const intake = createIntakeService({ source: `http://127.0.0.1:${source.address().port}` })
  intake.listen(0, '127.0.0.1')
  await once(intake, 'listening')
  t.after(() => new Promise(resolve => {
    source.close(() => intake.close(resolve))
    source.closeAllConnections()
    intake.closeAllConnections()
  }))
  const sourceBase = `http://127.0.0.1:${source.address().port}`
  const intakeBase = `http://127.0.0.1:${intake.address().port}`
  const call = async (path, method = 'GET') => {
    const res = await fetch(new URL(path, intakeBase), { method, signal: AbortSignal.timeout(3000) })
    return { status: res.status, body: await res.json() }
  }
  const replay = step => fetch(new URL('/replay', sourceBase), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ step }),
    signal: AbortSignal.timeout(3000),
  })
  return { call, replay }
}

test('演练全程：采集、交接、投递与派车就绪', async t => {
  const { call, replay } = await openPair(t)

  // 第 0 轮：基线收齐，车队目录与来源一致
  let sync = (await call('/sync', 'POST')).body
  assert.equal(sync.ok, true)
  let areas = (await call('/areas')).body
  assert.equal(areas.find(a => a.area === 'north').through.river, 71)
  assert.equal(areas.find(a => a.area === 'south').through.city, 30)
  assert.equal(areas.every(a => !a.resync), true)
  let lookup = (await call('/lookup?area=north&code=K19')).body
  assert.equal(lookup.status, 'active')
  assert.equal(lookup.active[0].point, 'P-19')
  assert.equal((await call('/lookup?area=north&code=K99')).status, 404) // 暂时查不到
  let plan = (await call('/plan?point=P-19')).body
  assert.deepEqual(plan.fleets.map(f => f.status), ['ready', 'ready'])
  let job = (await call('/jobs/R-101')).body
  assert.equal(job.status, 'dispatched')
  assert.deepEqual(job.assigned, { binding: 'B0-river-K19', code: 'K19', point: 'P-19' })
  let fleets = (await call('/fleets')).body
  assert.ok(fleets.find(f => f.id === 'classic').entries.some(e => e.code === 'K88'))

  // 第 1 轮：旧方游标失效、全量册分段未齐；新方增量只预收；南区照常采集
  await replay(1)
  await call('/sync', 'POST')
  areas = (await call('/areas')).body
  const north1 = areas.find(a => a.area === 'north')
  assert.equal(north1.resync, true)
  assert.equal(north1.fullState, 'incomplete')
  assert.equal(north1.streams.find(s => s.issuer === 'hill').preCollected, 1)
  lookup = (await call('/lookup?area=north&code=K19')).body
  assert.equal(lookup.status, 'active') // 旧切面仍可用，但已标记待重收
  assert.equal(lookup.stale, true)
  assert.equal(lookup.pending[0].binding, 'B1-hill-K19')
  const p42 = (await call('/points/P-42')).body
  assert.equal(p42.status, 'incomplete') // 分段未齐：区别于明确停用与查不到
  assert.equal((await call('/lookup?area=south&code=K89')).body.status, 'active')
  plan = (await call('/plan?point=P-42')).body
  assert.deepEqual(plan.fleets.map(f => f.status), ['awaiting-source', 'awaiting-source'])
  fleets = (await call('/fleets')).body
  assert.equal(fleets.find(f => f.id === 'classic').entries.find(e => e.code === 'K19').point, 'P-19')

  // 第 2 轮：交接声明覆盖旧方末笔与新方起笔，预收转正；按车队能力分别投递
  await replay(2)
  await call('/sync', 'POST')
  areas = (await call('/areas')).body
  const north2 = areas.find(a => a.area === 'north')
  assert.equal(north2.resync, false)
  assert.equal(north2.handover.complete, true)
  assert.equal(north2.handover.last, 72)
  assert.equal(north2.handover.first, 1)
  lookup = (await call('/lookup?area=north&code=K19')).body
  assert.equal(lookup.status, 'active')
  assert.equal(lookup.active[0].point, 'P-42')
  assert.ok(lookup.retired.some(row => row.binding === 'B0-river-K19'))
  assert.equal((await call('/points/P-19')).body.status, 'retired') // 明确停用
  // 只认短码的 classic：旧码留给在途单，新点用批准的替代码 L42
  plan = (await call('/plan?point=P-42')).body
  const classic42 = plan.fleets.find(f => f.fleet === 'classic')
  const current42 = plan.fleets.find(f => f.fleet === 'current')
  assert.equal(classic42.status, 'ready')
  assert.equal(classic42.code, 'L42')
  assert.equal(current42.status, 'ready')
  assert.equal(current42.code, 'K19')
  // K20 无替代码需求（无在途单），current 拒收 K20 编辑 → 等终端确认
  plan = (await call('/plan?point=P-21')).body
  assert.equal(plan.fleets.find(f => f.fleet === 'classic').status, 'ready')
  const current21 = plan.fleets.find(f => f.fleet === 'current')
  assert.equal(current21.status, 'awaiting-confirm')
  const conflicts = (await call('/conflicts')).body
  assert.ok(conflicts.some(c => c.fleet === 'classic' && c.resolution === 'alias' && c.alias === 'L42'))
  fleets = (await call('/fleets')).body
  const classic2 = fleets.find(f => f.id === 'classic')
  assert.equal(classic2.entries.find(e => e.code === 'K19').point, 'P-19') // 在途单保留原码
  assert.equal(classic2.entries.find(e => e.code === 'L42').point, 'P-42')
  assert.ok(classic2.transmissions.some(tr => tr.status === 'pending')) // 回执暂不可读

  // 第 3 轮：旧单结清、前一份变更回执可读，又收到新的换绑
  await replay(3)
  await call('/sync', 'POST')
  lookup = (await call('/lookup?area=north&code=K19')).body
  assert.equal(lookup.active[0].point, 'P-43')
  assert.equal((await call('/points/P-42')).body.status, 'retired')
  job = (await call('/jobs/R-101')).body
  assert.equal(job.status, 'closed')
  assert.deepEqual(job.assigned, { binding: 'B0-river-K19', code: 'K19', point: 'P-19' }) // 当时所用
  plan = (await call('/plan?point=P-43')).body
  assert.deepEqual(plan.fleets.map(f => [f.fleet, f.status, f.code]), [
    ['classic', 'ready', 'K19'],
    ['current', 'ready', 'K19'],
  ])
  fleets = (await call('/fleets')).body
  const classic3 = fleets.find(f => f.id === 'classic')
  assert.equal(classic3.entries.find(e => e.code === 'K19').point, 'P-43')
  assert.ok(!classic3.entries.some(e => e.code === 'L42')) // 按绑定撤回，不误移他点
  assert.equal(classic3.entries.find(e => e.code === 'K20').point, 'P-21')
  assert.ok(classic3.transmissions.every(tr => tr.status === 'confirmed'))
  const current3 = fleets.find(f => f.id === 'current')
  assert.ok(current3.entries.some(e => e.binding === 'B2-hill-K19' && e.point === 'P-43'))
  assert.ok(current3.entries.some(e => e.binding === 'B1-hill-K20' && e.point === 'P-21')) // 拒收后重投成功
  assert.ok(!current3.entries.some(e => e.binding === 'B1-hill-K19'))

  // 幂等：同一轮再同步不产生新传输
  const before = fleets.flatMap(f => f.transmissions.map(tr => tr.transmission)).sort()
  await call('/sync', 'POST')
  const after = (await call('/fleets')).body.flatMap(f => f.transmissions.map(tr => tr.transmission)).sort()
  assert.deepEqual(after, before)
})
