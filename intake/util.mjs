import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

// 游标形如 r71 / h0 / c30：前缀属于签发方，序号是流水编号。
// 收到的 nextCursor 只能连同对应签发方使用，不能跨签发方拼接。
export function parseCursor(cursor) {
  if (typeof cursor !== 'string') return null
  const match = cursor.match(/^([A-Za-z]+)(\d+)$/)
  return match ? { prefix: match[1], seq: Number(match[2]) } : null
}

export function cursorFrom(prefix, seq) {
  return `${prefix}${seq}`
}

// 车队按键字段查号，键元组用不可见分隔符连接，避免字段值本身造成歧义。
export function keyOf(row, fields) {
  return fields.map(field => String(row[field] ?? '')).join('\u0001')
}

export function shortHash(value) {
  return createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 10)
}

export const deepEqual = isDeepStrictEqual
