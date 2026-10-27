// Google Sheets API v4，Workers 里用 fetch + 服务账号 JWT（RS256）。不引入 googleapis。
// 表格用第一张工作表的 A:G。第 1 行是表头；generation_id 在 G 列，已有则更新，否则追加。
// 把表格共享给 GOOGLE_SERVICE_ACCOUNT_EMAIL（编辑者）。私钥是 JSON 密钥里的 private_key（PKCS8）。

export class SheetError extends Error {
  constructor(
    readonly code: 'sheets_not_configured' | 'sheets_auth_failed' | 'sheets_api_failed',
    message: string,
  ) {
    super(message)
  }
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets'
const TOKEN_SKEW_MS = 50 * 60 * 1000

export const SHEET_COLUMNS = ['created_at', 'email', 'template_id', 'user_image_url', 'status', 'result_link', 'generation_id'] as const

export interface SheetGenerationRow {
  createdAt: string
  email: string
  templateId: string
  userImageUrl: string
  status: string
  resultLink: string
  generationId: string
}

export interface SheetsConfig {
  spreadsheetId: string
  email: string
  privateKey: string
}

type TokenCache = { key: string; token: string; exp: number }
let tokenCache: TokenCache | null = null

export function clearSheetsTokenCache() {
  tokenCache = null
}

export function sheetsConfig(env: Env): SheetsConfig | null {
  const spreadsheetId = env.GOOGLE_SHEETS_SPREADSHEET_ID?.trim() ?? ''
  const email = env.GOOGLE_SERVICE_ACCOUNT_EMAIL?.trim() ?? ''
  const privateKey = env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?.trim() ?? ''
  if (!spreadsheetId || !email || !privateKey) return null
  return { spreadsheetId, email, privateKey }
}

// wrangler secret 常把换行存成字面量 \n，两边也可能多一对引号。
export function normalizePrivateKeyPem(raw: string): string {
  let pem = raw.trim()
  if ((pem.startsWith('"') && pem.endsWith('"')) || (pem.startsWith("'") && pem.endsWith("'"))) pem = pem.slice(1, -1)
  return pem.replace(/\\n/g, '\n').trim()
}

function pemBytes(pem: string): ArrayBuffer {
  const body = pem.replace(/-----BEGIN [^-]+-----/g, '').replace(/-----END [^-]+-----/g, '').replace(/\s+/g, '')
  if (!body) throw new SheetError('sheets_auth_failed', 'private_key_invalid')
  const binary = atob(body)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

function base64UrlBytes(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let binary = ''
  for (const byte of view) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function base64UrlText(value: string): string {
  return base64UrlBytes(new TextEncoder().encode(value))
}

export async function buildServiceAccountJwt(email: string, privateKeyPem: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<string> {
  const pem = normalizePrivateKeyPem(privateKeyPem)
  if (pem.includes('BEGIN RSA PRIVATE KEY')) throw new SheetError('sheets_auth_failed', 'private_key_must_be_pkcs8')
  if (!pem.includes('BEGIN PRIVATE KEY')) throw new SheetError('sheets_auth_failed', 'private_key_invalid')
  let key: CryptoKey
  try {
    key = await crypto.subtle.importKey('pkcs8', pemBytes(pem), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
  } catch {
    throw new SheetError('sheets_auth_failed', 'private_key_invalid')
  }
  const header = base64UrlText(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const payload = base64UrlText(
    JSON.stringify({
      iss: email,
      scope: SHEETS_SCOPE,
      aud: TOKEN_URL,
      iat: nowSeconds,
      exp: nowSeconds + 3600,
    }),
  )
  const unsigned = `${header}.${payload}`
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned))
  return `${unsigned}.${base64UrlBytes(signature)}`
}

async function accessToken(config: SheetsConfig): Promise<string> {
  const now = Date.now()
  if (tokenCache && tokenCache.key === config.email && tokenCache.exp > now) return tokenCache.token
  const assertion = await buildServiceAccountJwt(config.email, config.privateKey)
  let response: Response
  try {
    response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    })
  } catch {
    throw new SheetError('sheets_auth_failed', 'token_unreachable')
  }
  let errorCode = ''
  let token = ''
  try {
    const body = (await response.json()) as { access_token?: string; error?: string }
    token = typeof body.access_token === 'string' ? body.access_token : ''
    errorCode = typeof body.error === 'string' ? body.error : ''
  } catch {
    errorCode = 'invalid_token_response'
  }
  if (!response.ok || !token) {
    tokenCache = null
    throw new SheetError('sheets_auth_failed', `HTTP ${response.status}${errorCode ? ` ${errorCode}` : ''}`.slice(0, 180))
  }
  tokenCache = { key: config.email, token, exp: now + TOKEN_SKEW_MS }
  return token
}

function cellsOf(row: SheetGenerationRow): string[] {
  return [row.createdAt, row.email, row.templateId, row.userImageUrl, row.status, row.resultLink, row.generationId]
}

function rangeStartRow(range: string | undefined): number {
  if (!range) return 1
  const body = range.includes('!') ? range.slice(range.lastIndexOf('!') + 1) : range
  const match = /^[A-Z]+(\d+)/i.exec(body)
  return match ? Number(match[1]) : 1
}

function sheetUrl(spreadsheetId: string, range: string): string {
  return `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${range}`
}

async function sheetResult(response: Response, code: 'sheets_auth_failed' | 'sheets_api_failed'): Promise<void> {
  if (response.ok) return
  let detail = ''
  try {
    const body = (await response.json()) as { error?: { status?: string } }
    if (typeof body.error?.status === 'string') detail = ` ${body.error.status}`
  } catch {
    detail = ''
  }
  throw new SheetError(code, `HTTP ${response.status}${detail}`.slice(0, 180))
}

// 追加或按 generation_id 更新一行。调用方负责把失败记到 D1，不要让这里的异常变成用户扣费失败。
export async function upsertGenerationSheet(env: Env, row: SheetGenerationRow): Promise<'appended' | 'updated'> {
  const config = sheetsConfig(env)
  if (!config) throw new SheetError('sheets_not_configured', 'Google Sheets secrets are not set')
  const token = await accessToken(config)
  const headers = { Authorization: `Bearer ${token}` }
  let listed: Response
  try {
    listed = await fetch(sheetUrl(config.spreadsheetId, 'A:G'), { headers })
  } catch {
    throw new SheetError('sheets_api_failed', 'values_unreachable')
  }
  await sheetResult(listed, 'sheets_api_failed')
  const listedBody = (await listed.json()) as { range?: string; values?: unknown[][] }
  const values = Array.isArray(listedBody.values) ? listedBody.values : []
  const start = rangeStartRow(listedBody.range)
  let found: number | null = null
  for (let i = 0; i < values.length; i++) {
    const cell = values[i]?.[6]
    if (typeof cell === 'string' && cell === row.generationId) {
      found = start + i
      break
    }
  }
  const payload = cellsOf(row)
  if (found !== null) {
    const updated = await fetch(`${sheetUrl(config.spreadsheetId, `A${found}:G${found}`)}?valueInputOption=RAW`, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [payload] }),
    })
    await sheetResult(updated, 'sheets_api_failed')
    return 'updated'
  }
  const empty = values.length === 0
  const appended = await fetch(`${sheetUrl(config.spreadsheetId, 'A:G')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: empty ? [Array.from(SHEET_COLUMNS), payload] : [payload] }),
  })
  await sheetResult(appended, 'sheets_api_failed')
  return 'appended'
}

export function sheetErrorText(error: unknown): string {
  if (error instanceof SheetError) return `${error.code}: ${error.message}`.slice(0, 300)
  return 'sheets_api_failed'
}
