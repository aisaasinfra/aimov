import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { AdminPage, FilterSelect, LoadState, PAGE_SIZE, Pager, adminAction, shortDate, useAdminData } from '#/components/admin'

export const Route = createFileRoute('/admin/feedback')({
  component: AdminFeedback,
})

type Row = {
  id: string
  user_id: string
  email: string | null
  name: string | null
  title: string
  body: string
  status: Status
  admin_note: string | null
  created_at: string
}

// 与 src/server/feedback.ts 的 FEEDBACK_STATUSES 一致。后台页不引用服务端模块。
const STATUSES = ['open', 'planned', 'shipped', 'closed'] as const
type Status = (typeof STATUSES)[number]
const LABELS: Record<Status, string> = { open: '待处理', planned: '已计划', shipped: '已上线', closed: '已关闭' }

function AdminFeedback() {
  const [status, setStatus] = useState<Status | 'all'>('open')
  const [page, setPage] = useState(1)
  const query = status === 'all' ? '' : `&status=${status}`
  const { data, error, loading, reload } = useAdminData<{ feedback: Row[] }>(`/api/admin/feedback?page=${page}${query}`)
  const rows = data?.feedback ?? []

  async function update(row: Row, next: Status) {
    const note = prompt('一句话回复（可留空，取消则不改）', row.admin_note ?? '')
    if (note === null) return
    if (await adminAction(`/api/admin/feedback/${row.id}`, { status: next, adminNote: note.trim() })) await reload()
  }

  return (
    <AdminPage title="产品反馈">
      <FilterSelect
        label="状态"
        value={status}
        onChange={(value) => {
          setStatus(value as Status | 'all')
          setPage(1)
        }}
        options={[['all', '全部'], ...STATUSES.map((value) => [value, LABELS[value]] as [string, string])]}
      />
      <LoadState loading={loading && !data} error={error} empty={!!data && !rows.length} />
      <div className="space-y-3" data-testid="admin-feedback">
        {rows.map((row) => (
          <div key={row.id} className="card space-y-2 p-5">
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <div className="flex items-center gap-2">
                <span className="chip">{LABELS[row.status] ?? row.status}</span>
                <span className="font-medium">{row.title}</span>
              </div>
              <span className="text-xs text-muted">{shortDate(row.created_at)}</span>
            </div>
            <p className="text-xs text-muted">{row.email ?? row.user_id}</p>
            <p className="whitespace-pre-wrap text-sm leading-6">{row.body}</p>
            {row.admin_note ? <p className="text-sm text-muted">回复：{row.admin_note}</p> : null}
            <div className="flex flex-wrap gap-2">
              {STATUSES.map((next) => (
                <button key={next} type="button" className="btn-ghost px-2.5 py-1 text-xs" disabled={next === row.status} onClick={() => update(row, next)}>
                  {LABELS[next]}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      <Pager page={page} onPage={setPage} hasMore={rows.length === PAGE_SIZE} />
    </AdminPage>
  )
}
