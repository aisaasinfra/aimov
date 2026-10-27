import { site } from '#/config/site'
import { storeOutputFromUrl } from './jobs'
import { signedUploadUrl } from './media'
import { notifyGenerationAccepted, notifyGenerationFinished } from './notifications'
import { sheetErrorText, upsertGenerationSheet, type SheetGenerationRow } from './sheets'
import type { GenerationRow } from './types'
import { ApiError, nowIso } from './util'
import { isManualProvider } from './video/types'

export { resolveFulfillmentMode } from './fulfillment-mode'

// 履行开关：收款不变。manual 扣积分后停在人工队列；auto 仍走现有视频渠道。
// D1 generations 是账本。Google Sheet 只是人工操作面，写失败不回滚扣费。

export function isPublicHttpsUrl(raw: string): URL | null {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null
  if (isBlockedResultHost(url.hostname)) return null
  return url
}

function isBlockedResultHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true
  if (host === 'metadata.google.internal' || host === '::1' || host === '::') return true
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!match) return false
  const parts = match.slice(1).map(Number)
  if (parts.some((part) => part > 255)) return true
  const a = parts[0] ?? 0
  const b = parts[1] ?? 0
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  return false
}

function parseMeta(value: string | null): Record<string, unknown> {
  if (!value) return {}
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

async function mergeProviderMeta(env: Env, generationId: string, patch: Record<string, unknown>) {
  const current = await env.DB.prepare('SELECT provider_meta FROM generations WHERE id = ?')
    .bind(generationId)
    .first<{ provider_meta: string | null }>()
  const meta = parseMeta(current?.provider_meta ?? null)
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined) delete meta[key]
    else meta[key] = value
  }
  await env.DB.prepare('UPDATE generations SET provider_meta = ?, updated_at = ? WHERE id = ?')
    .bind(JSON.stringify(meta), nowIso(), generationId)
    .run()
}

// 签名地址给人工打开用户照片。签不出来时退回上传 id + 后台链接，不阻断落单。
export async function manualUserImageUrl(env: Env, uploadId: string, createdAt: string): Promise<string> {
  const days = site.retention.uploadDays > 0 ? site.retention.uploadDays : 7
  try {
    return await signedUploadUrl(env, uploadId, Date.parse(createdAt), days * 24 * 3600)
  } catch (error) {
    console.error('manual upload url failed', uploadId, error instanceof Error ? error.name : 'error')
    return `upload:${uploadId} ${env.SITE_URL.replace(/\/$/, '')}/admin/generations`
  }
}

function adminVideoUrl(env: Env, generationId: string) {
  return `${env.SITE_URL.replace(/\/$/, '')}/api/admin/generations/${generationId}/video`
}

async function loadManual(env: Env, generationId: string) {
  return env.DB.prepare(
    `SELECT g.*, u.email AS user_email FROM generations g JOIN users u ON u.id = g.user_id WHERE g.id = ?`,
  )
    .bind(generationId)
    .first<GenerationRow & { user_email: string }>()
}

async function sheetRowFor(env: Env, row: GenerationRow & { user_email: string }, patch?: { status?: string; resultLink?: string }): Promise<SheetGenerationRow> {
  return {
    createdAt: row.created_at,
    email: row.user_email,
    templateId: row.template_id,
    userImageUrl: await manualUserImageUrl(env, row.upload_id, row.created_at),
    status: patch?.status ?? row.status,
    resultLink: patch?.resultLink ?? (row.status === 'succeeded' ? adminVideoUrl(env, row.id) : ''),
    generationId: row.id,
  }
}

// 写 Sheet。成功清掉 sheetError；失败只写入 sheetError，不抛给扣费路径。
export async function syncManualSheet(env: Env, generationId: string, patch?: { status?: string; resultLink?: string }): Promise<boolean> {
  const row = await loadManual(env, generationId)
  if (!row || !isManualProvider(row.provider)) return false
  try {
    await upsertGenerationSheet(env, await sheetRowFor(env, row, patch))
    await mergeProviderMeta(env, generationId, { sheetError: null, sheetSyncedAt: nowIso() })
    return true
  } catch (error) {
    const message = sheetErrorText(error)
    console.error('sheet sync failed', generationId, message)
    try {
      await mergeProviderMeta(env, generationId, { sheetError: message })
    } catch (writeError) {
      console.error('sheet error persist failed', generationId, writeError instanceof Error ? writeError.name : 'error')
    }
    return false
  }
}

// 扣费事务已经提交。邮件、Sheet、甚至这里的意外错误都不能再让接口失败。
export async function acceptManualGeneration(env: Env, generationId: string) {
  try {
    await syncManualSheet(env, generationId, { status: 'queued', resultLink: '' })
    await notifyGenerationAccepted(env, generationId)
  } catch (error) {
    console.error('manual accept failed', generationId, error instanceof Error ? error.name : 'error')
  }
}

export async function retryManualSheet(env: Env, generationId: string) {
  const row = await loadManual(env, generationId)
  if (!row) throw new ApiError(404, 'not_found')
  if (!isManualProvider(row.provider)) throw new ApiError(409, 'not_manual')
  const ok = await syncManualSheet(env, generationId)
  if (!ok) {
    const meta = await env.DB.prepare('SELECT provider_meta FROM generations WHERE id = ?')
      .bind(generationId)
      .first<{ provider_meta: string | null }>()
    const sheetError = parseMeta(meta?.provider_meta ?? null).sheetError
    const message = typeof sheetError === 'string' && sheetError ? sheetError : 'sheet_sync_failed'
    throw new ApiError(502, 'sheet_sync_failed', message)
  }
}

// 管理员填成品 https 地址：拉进 R2，标 succeeded。失败退积分仍走 failGeneration，不另开账本。
export async function completeManualGeneration(env: Env, generationId: string, resultUrl: string) {
  const row = await env.DB.prepare('SELECT * FROM generations WHERE id = ?').bind(generationId).first<GenerationRow>()
  if (!row) throw new ApiError(404, 'not_found')
  if (!isManualProvider(row.provider)) throw new ApiError(409, 'not_manual')
  if (row.status !== 'queued' && row.status !== 'processing') throw new ApiError(409, 'not_queued')
  const url = isPublicHttpsUrl(resultUrl)
  if (!url) throw new ApiError(400, 'invalid_result_url', '成品地址必须是公网 https，不能带账号')
  const outputKey = `outputs/${row.user_id}/${row.id}.mp4`
  let stored = false
  try {
    stored = await storeOutputFromUrl(env, url.toString(), outputKey)
  } catch (error) {
    const status = error instanceof Error && /HTTP (\d+)/.exec(error.message)?.[1]
    throw new ApiError(502, 'result_fetch_failed', status ? `Could not fetch result video (HTTP ${status})` : 'Could not fetch result video')
  }
  if (!stored) throw new ApiError(413, 'output_too_large', 'Result video exceeds the size limit')
  const now = nowIso()
  const meta = parseMeta(row.provider_meta)
  meta.resultUrl = url.toString()
  delete meta.sheetError
  const saved = await env.DB.prepare(
    `UPDATE generations SET status = 'succeeded', output_r2_key = ?, provider_cost_cents = 0, provider_meta = ?, completed_at = ?, updated_at = ?
     WHERE id = ? AND provider = 'manual' AND status IN ('queued', 'processing')`,
  )
    .bind(outputKey, JSON.stringify(meta), now, now, row.id)
    .run()
  if (!saved.meta.changes) {
    const current = await env.DB.prepare('SELECT status, output_r2_key FROM generations WHERE id = ?')
      .bind(row.id)
      .first<{ status: string; output_r2_key: string | null }>()
    if (!(current?.status === 'succeeded' && current.output_r2_key === outputKey)) await env.MEDIA.delete(outputKey)
    throw new ApiError(409, 'not_queued')
  }
  await notifyGenerationFinished(env, row.id)
  await syncManualSheet(env, row.id, { status: 'succeeded', resultLink: adminVideoUrl(env, row.id) })
}
