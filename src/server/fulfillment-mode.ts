// 纯函数，不引用 jobs / notifications / settings，避免和 auth → settings 绕成环。

export type FulfillmentMode = 'manual' | 'auto'

const TEMPLATE_KEY = /^[A-Za-z0-9_-]{1,80}$/
const MAX_TEMPLATE_OVERRIDES = 50

// 空字符串是「没有覆盖」。非法 JSON、数组、坏键或坏值返回 null，调用方丢弃。
export function parseFulfillmentModeMap(value: string): Record<string, FulfillmentMode> | null {
  const trimmed = value.trim()
  if (!trimmed) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const entries = Object.entries(parsed)
  if (entries.length > MAX_TEMPLATE_OVERRIDES) return null
  const map: Record<string, FulfillmentMode> = {}
  for (const [key, mode] of entries) {
    if (!TEMPLATE_KEY.test(key)) return null
    if (mode !== 'manual' && mode !== 'auto') return null
    map[key] = mode
  }
  return map
}

// 未设置、空值、非法值都当 manual。只有明确的 auto 才走厂商队列。
export function resolveFulfillmentMode(
  settings: { fulfillmentMode?: string | null; fulfillmentModeByTemplate?: string | null },
  templateId: string,
): FulfillmentMode {
  const map = parseFulfillmentModeMap(settings.fulfillmentModeByTemplate ?? '') ?? {}
  const override = map[templateId]
  if (override) return override
  return settings.fulfillmentMode === 'auto' ? 'auto' : 'manual'
}
