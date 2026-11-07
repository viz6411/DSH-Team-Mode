/**
 * The Harness validates a tool's returned value: it must survive a JSON round trip exactly. A key
 * holding `undefined`, a `Date`, a function, `NaN` or `Infinity` is rejected as
 * `INVALID_TOOL_OUTPUT: value is not lossless JSON`, and the agent sees a useless error instead of
 * the team's own explanation. Tool results are therefore passed through this sanitizer.
 */

const PLAIN = (value) => {
  if (value === null) return true
  const type = typeof value
  if (type === 'string' || type === 'boolean') return true
  if (type === 'number') return Number.isFinite(value)
  return false
}

/**
 * Convert a value into lossless JSON: `undefined` keys are removed, `null` is kept, class instances
 * fall back to `toJSON()` when they have one, and anything else becomes its string form.
 */
export function jsonValue(value, seen = new WeakSet()) {
  if (value === undefined) return undefined
  if (PLAIN(value)) return value
  if (typeof value === 'number') return null
  if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') {
    return String(value)
  }
  if (Array.isArray(value)) {
    return value.map((item) => (item === undefined ? null : jsonValue(item, seen)))
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString()
  }
  if (typeof value !== 'object') return String(value)
  if (seen.has(value)) return null
  seen.add(value)
  if (typeof value.toJSON === 'function') return jsonValue(value.toJSON(), seen)
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue
    const safe = jsonValue(item, seen)
    if (safe !== undefined) out[key] = safe
  }
  return out
}

/** Attach a model-facing `message` and make the whole result lossless JSON in one step. */
export function toolResult(result, message) {
  return jsonValue({ ...(result ?? {}), message })
}
