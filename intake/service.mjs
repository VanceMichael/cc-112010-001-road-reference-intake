// 目录采集与交接服务：对管理方来源采集，对车队目录接口交付，
// 对接线员提供查询与派车就绪视图。
import { createServer } from 'node:http'
import { Store } from './store.mjs'
import { Collector } from './collector.mjs'
import { FleetSync } from './fleets.mjs'

export function sourceClient(base) {
  async function request(method, path, payload) {
    try {
      const res = await fetch(new URL(path, base), {
        method,
        signal: AbortSignal.timeout(5000),
        ...(payload === undefined ? {} : {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        }),
      })
      const text = await res.text()
      let body = null
      try { body = text ? JSON.parse(text) : null } catch { body = null }
      return { status: res.status, body }
    } catch (error) {
      return { status: 0, body: null, error: String(error?.message ?? error) }
    }
  }
  return {
    get: path => request('GET', path),
    post: (path, payload) => request('POST', path, payload),
  }
}

function send(res, status, content) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(content))
}

// 派车就绪视图：哪个码已经可以用，哪个仍在等源目录收齐、前单结束或终端确认。
function planFor(store, fleets, point) {
  const view = store.lookup({ point })
  const active = view.active[0] ?? null
  return {
    point,
    status: view.status,
    stale: view.stale,
    binding: active?.binding ?? null,
    fleets: fleets.fleetView().map(fleet => {
      const state = fleets.fleets.get(fleet.id)
      if (!active) {
        return { fleet: fleet.id, status: view.status === 'incomplete' || view.stale ? 'awaiting-source' : 'no-binding' }
      }
      if (!state.issuers.includes(active.issuer)) {
        return { fleet: fleet.id, status: 'unsupported', detail: `车队不收纳签发方 ${active.issuer}` }
      }
      if (state.pauses.has(point)) {
        return { fleet: fleet.id, status: 'awaiting-job', detail: state.pauses.get(point) }
      }
      const delivery = state.deliveries.get(active.binding)
      if (delivery?.state === 'confirmed') {
        return { fleet: fleet.id, status: 'ready', code: delivery.code, via: delivery.via }
      }
      if (store.area(active.area).needsFull) {
        return { fleet: fleet.id, status: 'awaiting-source' }
      }
      return {
        fleet: fleet.id,
        status: 'awaiting-confirm',
        code: delivery?.code ?? active.code,
        detail: delivery?.detail ?? delivery?.state ?? 'pending',
      }
    }),
  }
}

export function createIntakeService({ source }) {
  const client = sourceClient(source)
  const store = new Store()
  const collector = new Collector(client, store)
  const fleets = new FleetSync(client, store)

  async function sync() {
    const collected = await collector.cycle()
    const delivered = await fleets.cycle()
    return {
      ok: collected.ok && delivered.ok,
      areas: store.areaView(),
      fleets: fleets.fleetView().map(({ entries, ...rest }) => rest),
    }
  }

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1')
      const path = url.pathname
      if (req.method === 'GET' && path === '/health') {
        return send(res, 200, { status: 'ok' })
      }
      if (req.method === 'POST' && path === '/sync') {
        return send(res, 200, await sync())
      }
      if (req.method === 'GET' && path === '/areas') {
        return send(res, 200, store.areaView())
      }
      if (req.method === 'GET' && path === '/lookup') {
        const result = store.lookup({
          area: url.searchParams.get('area'),
          issuer: url.searchParams.get('issuer'),
          code: url.searchParams.get('code'),
          point: url.searchParams.get('point'),
        })
        return send(res, result.status === 'unknown' ? 404 : 200, result)
      }
      const pointMatch = path.match(/^\/points\/([^/]+)$/)
      if (req.method === 'GET' && pointMatch) {
        const point = decodeURIComponent(pointMatch[1])
        const result = store.lookup({ point })
        return send(res, result.status === 'unknown' ? 404 : 200, { point, ...result })
      }
      if (req.method === 'GET' && path === '/plan') {
        const point = url.searchParams.get('point')
        if (!point) return send(res, 400, { 原因: '缺少 point 参数' })
        return send(res, 200, planFor(store, fleets, point))
      }
      if (req.method === 'GET' && path === '/jobs') {
        return send(res, 200, [...store.jobs.values()])
      }
      const jobMatch = path.match(/^\/jobs\/([^/]+)$/)
      if (req.method === 'GET' && jobMatch) {
        const job = store.jobs.get(decodeURIComponent(jobMatch[1]))
        return job ? send(res, 200, job) : send(res, 404, { 原因: '没有这笔救援单' })
      }
      if (req.method === 'GET' && path === '/fleets') {
        return send(res, 200, fleets.fleetView())
      }
      if (req.method === 'GET' && path === '/conflicts') {
        return send(res, 200, fleets.fleetView().flatMap(fleet => fleet.conflicts))
      }
      return send(res, 404, { 原因: '服务没有这项资源' })
    } catch (error) {
      return send(res, 500, { 原因: String(error?.message ?? error) })
    }
  })
}
