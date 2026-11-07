/**
 * Minimal Standard-Schema-V1 config validator so the bundle needs no runtime dependency on
 * @deepseek-ai/schemastery: the Cordis loader only calls `Config["~standard"].validate(value)`.
 *
 * Supported field types: string, number, boolean, string array, {type:'object'} passthrough,
 * array of objects, and nested objects. Defaults are applied during validation.
 */

const FIELD_TYPES = ['string', 'number', 'boolean', 'strings', 'objects', 'object']

function validateField(name, field, value, issues) {
  if (value === undefined || value === null) {
    if (field.required) issues.push({ message: `${name} is required`, path: [name] })
    else if (field.default !== undefined) {
      const cloned = cloneDefault(field.default)
      if (field.type === 'object') return { ok: true, value: validateNested(name, { ...field, default: undefined }, cloned, issues) }
      return { ok: true, value: cloned }
    } else return { ok: true, value: undefined }
  }
  switch (field.type) {
    case 'string':
      if (typeof value !== 'string') {
        issues.push({ message: `${name} must be a string`, path: [name] })
        return { ok: false }
      }
      if (field.enum && !field.enum.includes(value)) {
        issues.push({ message: `${name} must be one of ${field.enum.join(', ')}`, path: [name] })
        return { ok: false }
      }
      return { ok: true, value }
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        issues.push({ message: `${name} must be a finite number`, path: [name] })
        return { ok: false }
      }
      return { ok: true, value }
    case 'boolean':
      if (typeof value !== 'boolean') {
        issues.push({ message: `${name} must be a boolean`, path: [name] })
        return { ok: false }
      }
      return { ok: true, value }
    case 'strings':
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
        issues.push({ message: `${name} must be an array of strings`, path: [name] })
        return { ok: false }
      }
      return { ok: true, value: [...value] }
    case 'objects':
      if (!Array.isArray(value)) {
        issues.push({ message: `${name} must be an array of objects`, path: [name] })
        return { ok: false }
      }
      return { ok: true, value: value.map((item, index) => validateNested(`${name}[${index}]`, { type: 'object', shape: itemShape(field), nullable: true }, item, issues)) }
    case 'object':
      return { ok: true, value: validateNested(name, field, value, issues) }
    default:
      issues.push({ message: `${name} has an unsupported schema type`, path: [name] })
      return { ok: false }
  }
}

function itemShape(field) {
  return field.shape ?? {}
}

function validateNested(name, field, value, issues) {
  if (value === undefined || value === null) {
    if (field.default !== undefined) return validateNested(name, { ...field, default: undefined }, cloneDefault(field.default), issues)
    if (field.required) issues.push({ message: `${name} is required`, path: [name] })
    return value ?? {}
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    issues.push({ message: `${name} must be an object`, path: [name] })
    return value
  }
  const out = {}
  const shape = field.shape ?? {}
  for (const [key, child] of Object.entries(shape)) {
    const result = validateField(`${name}.${key}`, child, value[key], issues)
    if (result.ok && result.value !== undefined) out[key] = result.value
  }
  for (const [key, child] of Object.entries(value)) {
    if (!(key in shape)) {
      if (field.strict) issues.push({ message: `${name}.${key} is not a known field`, path: [name, key] })
      else out[key] = child
    }
  }
  return out
}

function cloneDefault(value) {
  return typeof value === 'object' && value !== null ? JSON.parse(JSON.stringify(value)) : value
}

export function configSchema(shape) {
  for (const [name, field] of Object.entries(shape)) {
    if (!FIELD_TYPES.includes(field.type)) throw new TypeError(`unsupported config field schema for "${name}"`)
  }
  return {
    '~standard': {
      version: 1,
      vendor: 'dsh-team-mode',
      validate(value) {
        const issues = []
        const parsed = validateNested('config', { type: 'object', shape }, value ?? {}, issues)
        if (issues.length) return { issues }
        return { value: parsed }
      },
    },
  }
}
