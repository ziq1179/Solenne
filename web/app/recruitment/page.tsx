'use client'

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { Briefcase, MapPin, Users } from 'lucide-react'
import { api, JOB_STATUSES, type JobOpening } from '@/lib/api'
import { useAuth } from '@/components/auth'
import { AppShell, RequireAuth } from '@/components/shell'
import { Alert, Badge, Card, CardTitle, Spinner } from '@/components/ui'

const STATUS_TONE: Record<string, 'green' | 'amber' | 'red' | 'sky' | 'slate'> = {
  draft: 'slate',
  pending_approval: 'amber',
  open: 'green',
  on_hold: 'sky',
  closed: 'red',
}

const STATUS_LABEL: Record<string, string> = {
  draft: 'Draft',
  pending_approval: 'Pending approval',
  open: 'Open',
  on_hold: 'On hold',
  closed: 'Closed',
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export default function RecruitmentPage() {
  const { me } = useAuth()
  const [statusFilter, setStatusFilter] = useState('')

  const canRead = me?.permissions.includes('ats:read') ?? false

  const openings = useQuery({
    queryKey: ['job-openings', statusFilter],
    queryFn: () => api.jobOpenings({ status: statusFilter || undefined, pageSize: 50 }),
    enabled: canRead,
  })

  const items = openings.data?.data ?? []

  return (
    <RequireAuth>
      <AppShell>
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-2xl font-semibold text-teal">Recruitment</h1>
          <div className="flex items-center gap-2">
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="rounded-lg border border-line bg-paper px-3 py-1.5 text-sm text-ink focus:border-teal focus:outline-none"
            >
              <option value="">All statuses</option>
              {JOB_STATUSES.map((s) => (
                <option key={s} value={s}>{STATUS_LABEL[s]}</option>
              ))}
            </select>
          </div>
        </div>

        {!canRead ? (
          <Alert tone="amber">
            Recruitment is restricted. Contact your tenant admin for access.
          </Alert>
        ) : openings.isPending ? (
          <Spinner />
        ) : openings.isError ? (
          <Alert>Failed to load job openings.</Alert>
        ) : items.length === 0 ? (
          <Card>
            <div className="flex flex-col items-center gap-3 py-8 text-center">
              <Briefcase className="h-8 w-8 text-graphite-faint" />
              <p className="text-sm text-graphite-soft">
                {statusFilter ? 'No openings with that status.' : 'No job openings yet.'}
              </p>
            </div>
          </Card>
        ) : (
          <Card>
            <CardTitle className="text-teal-soft">Job Openings</CardTitle>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs uppercase tracking-wider text-teal-soft">
                    <th className="pb-2 pr-4 font-medium">Title</th>
                    <th className="pb-2 pr-4 font-medium">Department</th>
                    <th className="pb-2 pr-4 font-medium">Location</th>
                    <th className="pb-2 pr-4 font-medium">Type</th>
                    <th className="pb-2 pr-4 font-medium">Status</th>
                    <th className="pb-2 pr-4 font-medium">Headcount</th>
                    <th className="pb-2 font-medium">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((j: JobOpening) => (
                    <tr key={j.id} className="border-b border-line/60 last:border-0">
                      <td className="py-2.5 pr-4">
                        <Link href={`/recruitment/${j.id}`} className="font-medium text-teal hover:underline">
                          {j.title}
                        </Link>
                      </td>
                      <td className="py-2.5 pr-4 text-graphite-soft">{j.departmentName ?? '—'}</td>
                      <td className="py-2.5 pr-4 text-graphite-soft">
                        <span className="inline-flex items-center gap-1">
                          <MapPin className="h-3 w-3" />
                          {j.locationName ?? '—'}
                        </span>
                      </td>
                      <td className="py-2.5 pr-4 text-graphite-soft capitalize">{j.employmentType}</td>
                      <td className="py-2.5 pr-4">
                        <Badge tone={STATUS_TONE[j.status] ?? 'slate'}>
                          {STATUS_LABEL[j.status] ?? j.status}
                        </Badge>
                      </td>
                      <td className="py-2.5 pr-4 text-graphite-soft">
                        <span className="inline-flex items-center gap-1">
                          <Users className="h-3 w-3" />
                          {j.headcount}
                        </span>
                      </td>
                      <td className="py-2.5 text-graphite-faint">{fmtDate(j.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </AppShell>
    </RequireAuth>
  )
}
