import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'
import { makeSource } from '../source.mjs'

async function openSource(t) {
  const server = makeSource()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => {
    server.close(resolve)
    server.closeAllConnections()
  }))
  const origin = new URL('http://127.0.0.1:' + server.address().port)
  return (path, method = 'GET', body) => fetch(new URL(path, origin), {
    method, signal: AbortSignal.timeout(3000),
    ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  })
}

test('地区切换期间目录页和流水保有各自切面', async t => {
  const request = await openSource(t)
  assert.deepEqual(await (await request('/ready')).json(), { status: 'ready', step: 0, steps: 4 })
  const old = await (await request('/catalog/north')).json()
  assert.equal(old.through.river, 71)
  assert.equal((await request('/replay', 'PUT', { step: 1 })).status, 200)
  assert.equal((await request('/changes/river?after=r71')).status, 410)
  const [north, incoming, south, absent] = await Promise.all(
    ['/catalog/north', '/changes/hill?after=h0', '/changes/city?after=c30', '/handoffs']
      .map(async path => (await request(path)).json()),
  )
  assert.equal((await request(north.next)).status, 409)
  assert.equal(incoming.records[0].seq, 1)
  assert.equal(south.nextCursor, 'c31')
  assert.deepEqual(absent, [])
  assert.equal((await request('/replay', 'PUT', { step: 2 })).status, 200)
  const front = await (await request('/catalog/north')).json()
  const last = await (await request(front.next)).json()
  const [handoff] = await (await request('/handoffs')).json()
  assert.equal(last.edition, front.edition)
  assert.equal(front.through.river, handoff.last)
  assert.equal(last.through.hill, handoff.first)
  assert.equal(front.entries[0].binding, old.entries[0].binding)
  assert.equal(front.entries[0].action, 'retire')
  assert.equal(last.entries[0].point, 'P-20')
})

test('车队目录可以先于回执更新，接线台结单会独立发布', async t => {
  const request = await openSource(t)
  await request('/replay', 'PUT', { step: 2 })
  const legacy = '/fleet/classic'
  const [job] = await (await request('/control/jobs')).json()
  assert.equal(job.status, 'dispatched')
  const before = await (await request(legacy + '/directory')).json()
  const payload = { base: before.revision, transmission: 'operator-17', actions: [{
    op: 'upsert', binding: { binding: 'operator-row', point: 'P-42', code: 'L42', issuer: 'hill' },
  }] }
  assert.equal((await request(legacy + '/send', 'POST', payload)).status, 503)
  assert.equal((await request(legacy + '/receipts?transmission=operator-17')).status, 202)
  const during = await (await request(legacy + '/directory')).json()
  assert.notEqual(during.revision, before.revision)
  assert.equal(during.entries.find(row => row.binding === job.binding).point, job.point)
  assert.equal(during.entries.find(row => row.binding === 'operator-row').code, 'L42')
  await request('/replay', 'PUT', { step: 3 })
  const receipt = await (await request(legacy + '/receipts?transmission=operator-17')).json()
  assert.deepEqual(receipt.accepted, ['operator-row'])
  const [closed] = await (await request('/control/jobs')).json()
  assert.equal(closed.status, 'closed')
  assert.equal(closed.binding, job.binding)
  const delta = await (await request('/changes/hill?after=h1')).json()
  assert.deepEqual(delta.records.map(record => record.binding.action), ['retire', 'bind'])
  assert.equal((await request(legacy + '/send', 'POST', payload)).status, 200)
  assert.equal((await request(legacy + '/send', 'POST', { ...payload, transmission: 'new-attempt' })).status, 409)
})

test('支持版本的车队分别回执同一传输里的各个绑定', async t => {
  const request = await openSource(t)
  await request('/replay', 'PUT', { step: 2 })
  const fleet = '/fleet/current'
  const prior = await (await request(fleet + '/directory')).json()
  const rows = [
    { binding: 'incoming-row', point: 'P-42', code: 'K19', issuer: 'hill' },
    { binding: 'edit-20', point: 'P-20', code: 'K20', issuer: 'river' },
  ]
  const result = await request(fleet + '/send', 'POST', {
    base: prior.revision, transmission: 'shift-9', actions: rows.map(binding => ({ op: 'upsert', binding })),
  })
  assert.equal(result.status, 207)
  const receipt = await result.json()
  assert.deepEqual(receipt.accepted, ['incoming-row'])
  assert.equal(receipt.rejected[0].binding, 'edit-20')
  const current = await (await request(fleet + '/directory')).json()
  assert.equal(current.entries.filter(row => row.code === 'K19').length, 2)
})
