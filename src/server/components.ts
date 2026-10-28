// 冻结期的最小组件表。不是全量目录。
// 自动资格只认和 OpenGen POST /v1/aimov/jobs 正文一致的形状：一张图 + 源视频。
// 网关不保存 component_id。这里的 id 只进 D1，不进 OpenGen 的 capability / play。

export const IMAGE_SOURCE_VIDEO = 'image-source-video'
export const AUDIO_TWO_IMAGES = 'audio-two-images'

export type ComponentShape = 'image-plus-source-video' | 'audio-plus-two-images'

export interface ComponentContract {
  id: string
  version: number
  shape: ComponentShape
  autoEligible: boolean
  // incompatible：这个版本不能再提交。飞行中的旧行仍保留创建时写下的 id 和版本。
  submit: 'ok' | 'incompatible'
}

const REGISTRY: readonly ComponentContract[] = [
  { id: IMAGE_SOURCE_VIDEO, version: 1, shape: 'image-plus-source-video', autoEligible: true, submit: 'ok' },
  { id: IMAGE_SOURCE_VIDEO, version: 0, shape: 'image-plus-source-video', autoEligible: false, submit: 'incompatible' },
  { id: AUDIO_TWO_IMAGES, version: 1, shape: 'audio-plus-two-images', autoEligible: false, submit: 'ok' },
]

export const DEFAULT_COMPONENT_ID = IMAGE_SOURCE_VIDEO
export const DEFAULT_COMPONENT_VERSION = 1

export const FORBIDDEN_GENERATION_FIELDS = ['capability', 'play', 'site_id', 'siteId', 'opengen_api_key', 'opengenApiKey'] as const

export function findComponent(id: string, version: number): ComponentContract | null {
  return REGISTRY.find((item) => item.id === id && item.version === version) ?? null
}

export type ComponentDecision =
  | { ok: true; component: ComponentContract }
  | { ok: false; status: 400 | 409; code: string; message: string }

function reject(status: 400 | 409, code: string, message: string): ComponentDecision {
  return { ok: false, status, code, message }
}

// 顺序固定：禁止字段 → 未知或不兼容版本 → auto 且不能自动（在形状错误之前）→ 这个接口的输入形状。
// 这样 auto × 不能自动的组件在扣费前得到 component_not_auto_eligible，而不是被改成人工，也不是形状错误。
export function resolveCreateComponent(body: Record<string, unknown>, mode: 'manual' | 'auto'): ComponentDecision {
  for (const key of FORBIDDEN_GENERATION_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, key) && body[key] !== undefined) {
      return reject(400, 'forbidden_field', `请求不能携带 ${key}`)
    }
  }

  const rawId = body.componentId ?? body.component_id
  const rawVersion = body.componentVersion ?? body.component_version
  const idBlank = rawId === undefined || rawId === null || rawId === ''
  const versionBlank = rawVersion === undefined || rawVersion === null || rawVersion === ''
  const omitted = idBlank && versionBlank
  const id = omitted ? DEFAULT_COMPONENT_ID : typeof rawId === 'string' ? rawId.trim() : ''
  const version = omitted
    ? DEFAULT_COMPONENT_VERSION
    : typeof rawVersion === 'number'
      ? rawVersion
      : typeof rawVersion === 'string' && rawVersion.trim()
        ? Number(rawVersion)
        : Number.NaN

  if (!omitted && (!id || !Number.isInteger(version))) {
    return reject(400, 'incompatible_component', '组件 id 或版本不合法')
  }

  const component = findComponent(id, version)
  if (!component || component.submit === 'incompatible') {
    return reject(400, 'incompatible_component', '组件版本不兼容，不能提交')
  }
  if (mode === 'auto' && !component.autoEligible) {
    return reject(409, 'component_not_auto_eligible', '当前站点是自动生成，这个组件还不能走自动通道')
  }
  if (component.shape !== 'image-plus-source-video') {
    return reject(400, 'invalid_component_input', '这个接口只接受一张照片加源视频')
  }
  return { ok: true, component }
}
