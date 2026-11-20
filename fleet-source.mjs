// 车队演练服务独立保存各自实际接到的字典和传输回执。
export function fleetSource(initial, fleets) {
  const ledgers = new Map(fleets.map(fleet => {
    const directory = initial(fleet.id)
    return [fleet.id, { key: fleet.key, rev: directory.revision,
      entries: new Map(directory.entries.map(row => [row.binding, row])), receipts: new Map() }]
  }))

  function response(status, content) {
    return { status, content }
  }

  return function exchange({ fleet, method, resource, transmission, body, step }) {
    const ledger = ledgers.get(fleet)
    if (!ledger) return response(404, { 原因: '车队不存在' })
    if (resource === 'directory' && method === 'GET') {
      return response(200, { revision: ledger.rev, entries: [...ledger.entries.values()] })
    }
    if (resource === 'receipts' && method === 'GET') {
      const receipt = ledger.receipts.get(transmission)
      if (!receipt) return response(404, { 原因: '没有这份传输' })
      if (receipt.deferred && step < 3) return response(202, { status: 'pending' })
      return response(200, receipt.result)
    }
    if (resource !== 'send' || method !== 'POST') return response(405, { 原因: '接口不支持此操作' })
    if (typeof body?.transmission !== 'string' || !body.transmission || !Array.isArray(body.actions)
        || !body.actions.length || body.actions.some(({ op, binding }) =>
          !['upsert', 'remove'].includes(op) || !binding?.binding
          || (op === 'upsert' && ![binding.code, binding.point, binding.issuer].every(Boolean)))) {
      return response(400, { 原因: '传输字段不全' })
    }
    const previous = ledger.receipts.get(body.transmission)
    if (previous) {
      if (previous.payload !== JSON.stringify(body)) return response(409, { 原因: '同一传输号内容改变' })
      if (previous.deferred && step < 3) return response(503, { 原因: '回执暂不可读' })
      return response(previous.result.rejected.length ? 207 : 200, previous.result)
    }
    if (body.base !== ledger.rev) return response(409, { 原因: '车队目录已变化', revision: ledger.rev })
    const accepted = []
    const rejected = []
    for (const { op, binding } of body.actions) {
      if (fleet === 'current' && step === 2 && binding.code === 'K20') {
        rejected.push({ binding: binding.binding, reason: '车队暂缓编辑 K20' })
        continue
      }
      if (op === 'remove') ledger.entries.delete(binding.binding)
      if (op === 'upsert') {
        for (const [key, row] of ledger.entries) {
          if (ledger.key.every(field => row[field] === binding[field])) ledger.entries.delete(key)
        }
        ledger.entries.set(binding.binding, binding)
      }
      accepted.push(binding.binding)
    }
    const base = ledger.rev
    if (accepted.length) ledger.rev = base[0] + (Number(base.slice(1)) + 1)
    const receipt = { transmission: body.transmission, base, revision: ledger.rev, accepted, rejected }
    const deferred = fleet === 'classic' && step === 2
    ledger.receipts.set(body.transmission, { payload: JSON.stringify(body), deferred, result: receipt })
    if (deferred) return response(503, { 原因: '回执暂不可读' })
    return response(rejected.length ? 207 : 200, receipt)
  }
}
