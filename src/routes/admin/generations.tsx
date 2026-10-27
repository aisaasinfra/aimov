import { Link, createFileRoute } from '@tanstack/react-router'
import { useState, type FormEvent } from 'react'
import {
  AdminPage,
  FilterSelect,
  LoadState,
  PAGE_SIZE,
  Pager,
  Status,
  adminAction,
  marginCents,
  money,
  shortDate,
  useAdminData,
} from '#/components/admin'

export const Route = createFileRoute('/admin/generations')({
  component: AdminGenerations,
})

type GenerationRow = {
  id: string
  user_id: string
  user_email: string
  template_id: string
  duration_seconds: number
  credits_cost: number
  status: string
  provider: string
  provider_request_id: string | null
  provider_meta: string | null
  output_r2_key: string | null
  error_code: string | null
  error_message: string | null
  attempts: number
  refunded: number
  provider_cost_cents: number | null
  created_at: string
  completed_at: string | null
}

function AdminGenerations() {
  const [status, setStatus] = useState('')
  const [provider, setProvider] = useState('')
  const [input, setInput] = useState('')
  const [q, setQ] = useState('')
  const [page, setPage] = useState(1)
  const [resultUrls, setResultUrls] = useState<Record<string, string>>({})
  const params = new URLSearchParams({ page: String(page) })
  if (status) params.set('status', status)
  if (provider) params.set('provider', provider)
  if (q) params.set('q', q)
  const { data, error, loading, reload } = useAdminData<{ generations: GenerationRow[]; revenuePerCreditCents: number | null }>(
    `/api/admin/generations?${params}`,
  )

  function search(event: FormEvent) {
    event.preventDefault()
    setPage(1)
    setQ(input.trim())
  }
  const rows = data?.generations ?? []
  const perCredit = data?.revenuePerCreditCents ?? null

  async function fail(g: GenerationRow) {
    if (await adminAction(`/api/admin/generations/${g.id}/fail`, {}, `将任务 ${g.id} 标记为失败并退还 ${g.credits_cost} 积分？`)) await reload()
  }

  async function complete(g: GenerationRow) {
    const resultUrl = resultUrls[g.id]?.trim() ?? ''
    if (!resultUrl) return
    if (await adminAction(`/api/admin/generations/${g.id}/complete`, { resultUrl }, `把任务 ${g.id} 标为成功，并把成品地址保存到 R2？`)) await reload()
  }

  async function retrySheet(g: GenerationRow) {
    if (await adminAction(`/api/admin/generations/${g.id}/sheet`, {}, `把任务 ${g.id} 重新写入 Google Sheet？`)) await reload()
  }

  return (
    <AdminPage
      title="生成任务"
      actions={
        <button type="button" className="btn-ghost px-3 py-1.5 text-sm" onClick={reload}>
          刷新
        </button>
      }
    >
      <div className="flex flex-wrap items-center gap-4">
        <FilterSelect
          label="状态"
          value={status}
          onChange={(v) => {
            setStatus(v)
            setPage(1)
          }}
          options={[
            ['', '全部'],
            ['queued', '排队中'],
            ['processing', '生成中'],
            ['succeeded', '成功'],
            ['failed', '失败'],
          ]}
        />
        <FilterSelect
          label="履行"
          value={provider}
          onChange={(v) => {
            setProvider(v)
            setPage(1)
          }}
          options={[
            ['', '全部'],
            ['manual', '人工队列'],
          ]}
        />
        <button
          type="button"
          className="btn-ghost px-3 py-1.5 text-sm"
          onClick={() => {
            setProvider('manual')
            setStatus('queued')
            setPage(1)
          }}
        >
          只看人工排队
        </button>
        <form onSubmit={search} className="flex gap-2">
          <input className="input w-72 py-1.5" placeholder="任务 ID / 邮箱 / 服务商请求 ID" value={input} onChange={(e) => setInput(e.target.value)} />
          <button type="submit" className="btn-primary px-4 py-1.5">
            搜索
          </button>
        </form>
      </div>
      <LoadState loading={loading && !data} error={error} empty={!!data && !rows.length} />
      {rows.length ? (
        <div className="card overflow-x-auto">
          <table className="table-admin" data-testid="admin-generations">
            <thead>
              <tr>
                <th>任务</th>
                <th>用户</th>
                <th>模板 / 时长</th>
                <th>状态</th>
                <th>服务商</th>
                <th title="成本为估算值；毛利 = 积分 × 每积分实收 − 成本">成本 / 毛利</th>
                <th>错误</th>
                <th>创建 / 完成</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((g) => (
                <tr key={g.id}>
                  <td className="font-mono text-xs">
                    {g.output_r2_key ? (
                      <a href={`/api/admin/generations/${g.id}/video`} target="_blank" rel="noreferrer" className="hover:underline">
                        {g.id}
                      </a>
                    ) : (
                      g.id
                    )}
                  </td>
                  <td>
                    <Link to="/admin/users/$id" params={{ id: g.user_id }} className="hover:underline">
                      {g.user_email}
                    </Link>
                  </td>
                  <td className="text-xs">
                    {g.template_id}
                    <span className="block text-muted">
                      {g.duration_seconds}s · {g.credits_cost} 积分
                    </span>
                  </td>
                  <td>
                    <Status value={g.status} />
                    {g.refunded ? <span className="block text-xs text-muted">已退积分</span> : null}
                  </td>
                  <td className="text-xs">
                    {g.provider === 'manual' ? '人工' : g.provider}
                    <span className="block font-mono text-muted">{g.provider_request_id ?? ''}</span>
                    <span className="block text-muted">尝试 {g.attempts} 次</span>
                    {sheetErrorOf(g.provider_meta) ? (
                      <span className="block text-red-600" title={sheetErrorOf(g.provider_meta) ?? ''}>
                        Sheet 未同步
                      </span>
                    ) : null}
                  </td>
                  <td className="whitespace-nowrap text-xs" data-testid="generation-cost">
                    <GenerationEconomics g={g} perCredit={perCredit} />
                  </td>
                  <td className="max-w-xs text-xs">
                    {g.error_code ?? ''}
                    {g.error_message ? <span className="block truncate text-muted" title={g.error_message}>{g.error_message}</span> : null}
                  </td>
                  <td className="whitespace-nowrap text-xs">
                    {shortDate(g.created_at)}
                    <span className="block text-muted">{shortDate(g.completed_at)}</span>
                  </td>
                  <td className="space-y-2 text-right">
                    {g.provider === 'manual' && (g.status === 'queued' || g.status === 'processing') ? (
                      <form
                        className="flex flex-col items-end gap-1"
                        onSubmit={(event) => {
                          event.preventDefault()
                          void complete(g)
                        }}
                      >
                        <input
                          className="input w-56 py-1 text-xs"
                          placeholder="成品 https 地址"
                          value={resultUrls[g.id] ?? ''}
                          onChange={(event) => setResultUrls((urls) => ({ ...urls, [g.id]: event.target.value }))}
                          data-testid="manual-result-url"
                        />
                        <button type="submit" className="btn-primary px-2.5 py-1 text-xs" data-testid="manual-complete">
                          保存成片
                        </button>
                      </form>
                    ) : null}
                    {g.provider === 'manual' && sheetErrorOf(g.provider_meta) ? (
                      <button type="button" className="btn-ghost px-2.5 py-1 text-xs" onClick={() => retrySheet(g)} data-testid="manual-sheet-retry">
                        重试 Sheet
                      </button>
                    ) : null}
                    {g.status === 'queued' || g.status === 'processing' ? (
                      <button type="button" className="btn-ghost px-2.5 py-1 text-xs" onClick={() => fail(g)}>
                        标记失败
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <Pager page={page} onPage={setPage} hasMore={rows.length === PAGE_SIZE} />
    </AdminPage>
  )
}

function sheetErrorOf(meta: string | null): string | null {
  if (!meta) return null
  try {
    const parsed = JSON.parse(meta) as { sheetError?: unknown }
    return typeof parsed.sheetError === 'string' && parsed.sheetError ? parsed.sheetError : null
  } catch {
    return null
  }
}

// 没出片 = 服务商不计费；出片后才失败（已退积分）= 只有成本没有收入
function GenerationEconomics({ g, perCredit }: { g: GenerationRow; perCredit: number | null }) {
  if (g.provider_cost_cents === null) return <span className="text-muted">—</span>
  const earned = g.status === 'succeeded' && !g.refunded
  const margin = earned ? marginCents(g.credits_cost, perCredit, g.provider_cost_cents) : -g.provider_cost_cents
  return (
    <>
      {money(g.provider_cost_cents)}
      <span className={`block ${margin !== null && margin < 0 ? 'text-red-600' : 'text-muted'}`}>
        毛利 {margin === null ? '—' : money(margin)}
      </span>
    </>
  )
}
