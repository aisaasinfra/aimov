import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchVideoBalance, queryVideoBalance } from '#/server/video-balance'

afterEach(() => {
  vi.unstubAllGlobals()
})

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  const calls: string[] = []
  vi.stubGlobal('fetch', async (raw: string, init?: RequestInit) => {
    calls.push(String(raw))
    return handler(String(raw), init)
  })
  return calls
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('queryVideoBalance', () => {
  it('OpenGen 没有余额接口，不发请求，也不落到 yir', async () => {
    const calls = stubFetch(() => {
      throw new Error('should not fetch')
    })
    const env = { APP_ENV: 'production', VIDEO_PROVIDER: 'yir', YIR_API_KEY: 'yir_secret', OPENGEN_API_KEY: 'og' } as unknown as Env
    expect(await queryVideoBalance(env, 'opengen')).toEqual({ status: 'unsupported' })
    expect(await fetchVideoBalance({ ...env, VIDEO_PROVIDER: 'opengen' })).toBeNull()
    expect(calls).toEqual([])
  })

  it('fal、nanoapi、yir 各读自己的余额地址', async () => {
    const falCalls = stubFetch((url, init) => {
      expect(url).toBe('https://api.fal.ai/v1/account/billing?expand=credits')
      expect((init?.headers as Record<string, string>).Authorization).toBe('Key fal_test')
      return json({ credits: { current_balance: 12.5, currency: 'USD' } })
    })
    expect(await queryVideoBalance({ APP_ENV: 'production', VIDEO_PROVIDER: 'fal', FAL_KEY: 'fal_test' } as unknown as Env, 'fal')).toEqual({
      status: 'ok',
      provider: 'fal',
      amount: 12.5,
      currency: 'USD',
    })
    expect(falCalls).toHaveLength(1)

    const nanoCalls = stubFetch((url) => {
      expect(url).toBe('https://api.nanoapi.ai/v1/balance')
      return json({ data: { available: '8.25', currency: 'USD' } })
    })
    expect(await queryVideoBalance({ APP_ENV: 'production', NANOAPI_API_KEY: 'nano_test' } as unknown as Env, 'nanoapi')).toEqual({
      status: 'ok',
      provider: 'NanoAPI',
      amount: 8.25,
      currency: 'USD',
    })
    expect(nanoCalls).toHaveLength(1)

    const yirCalls = stubFetch((url) => {
      expect(url).toBe('https://gateway.yir.ai/v1/balance')
      return json({ available_amount: 4.5, currency: 'USD' })
    })
    expect(await queryVideoBalance({ APP_ENV: 'production', YIR_API_KEY: 'yir_test' } as unknown as Env, 'yir')).toEqual({
      status: 'ok',
      provider: 'yir',
      amount: 4.5,
      currency: 'USD',
    })
    expect(yirCalls).toHaveLength(1)
  })

  it('HTTP 非 2xx 抛出，由告警记日志', async () => {
    stubFetch(() => new Response('nope', { status: 502 }))
    await expect(fetchVideoBalance({ APP_ENV: 'production', VIDEO_PROVIDER: 'fal', FAL_KEY: 'fal_test' } as unknown as Env)).rejects.toThrow(
      'video balance HTTP 502',
    )
  })
})
