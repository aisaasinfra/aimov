import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { AdminPage, LoadState, PAGE_SIZE, Pager, shortDate, useAdminData } from '#/components/admin'

export const Route = createFileRoute('/admin/waitlist')({
  component: AdminWaitlist,
})

type Row = { id: string; email: string; locale: string; source: string; created_at: string }

function AdminWaitlist() {
  const [page, setPage] = useState(1)
  const { data, error, loading } = useAdminData<{ signups: Row[] }>(`/api/admin/waitlist?page=${page}`)
  const rows = data?.signups ?? []
  return (
    <AdminPage
      title="等待列表"
      actions={
        <a className="btn-primary px-3 py-1.5 text-sm" href="/api/admin/waitlist.csv">
          导出 CSV
        </a>
      }
    >
      <LoadState loading={loading && !data} error={error} empty={!!data && !rows.length} />
      <div className="space-y-3" data-testid="admin-waitlist">
        {rows.map((row) => (
          <div key={row.id} className="card flex flex-wrap items-center justify-between gap-2 p-4 text-sm">
            <a href={`mailto:${row.email}`} className="font-medium hover:underline">
              {row.email}
            </a>
            <div className="flex items-center gap-3 text-xs text-muted">
              <span className="chip">{row.locale}</span>
              <span>{row.source}</span>
              <span>{shortDate(row.created_at)}</span>
            </div>
          </div>
        ))}
      </div>
      <Pager page={page} onPage={setPage} hasMore={rows.length === PAGE_SIZE} />
    </AdminPage>
  )
}
