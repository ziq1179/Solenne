'use client'

import { use } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { ArrowLeft, MapPin, Users, DollarSign } from 'lucide-react'
import { api, PIPELINE_STAGES, type JobOpening, type Candidate } from '@/lib/api'
import { useAuth } from '@/components/auth'
import { AppShell, RequireAuth } from '@/components/shell'
import { Alert, Badge, Button, Card, CardTitle, Spinner } from '@/components/ui'

const STAGE_TONE: Record<string, 'green' | 'amber' | 'red' | 'sky' | 'slate'> = {
  sourced: 'slate',
  applied: 'sky',
  screening: 'amber',
  interview: 'amber',
  offer: 'green',
  hired: 'green',
  rejected: 'red',
}

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

function CandidateRow({ c, onNext }: { c: Candidate; onNext: (stage: string) => void }) {
  const currentIdx = PIPELINE_STAGES.indexOf(c.stage as typeof PIPELINE_STAGES[number])
  const nextStage = currentIdx >= 0 && currentIdx < PIPELINE_STAGES.length - 1
    ? PIPELINE_STAGES[currentIdx + 1]
    : null
  const isTerminal = c.stage === 'hired' || c.stage === 'rejected'

  return (
    <li className="flex items-center justify-between gap-3 rounded-lg bg-paper-dim px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-ink">{c.firstName} {c.lastName}</span>
          <Badge tone={STAGE_TONE[c.stage] ?? 'slate'}>{c.stage}</Badge>
          {c.rating != null && (
            <span className="text-xs text-graphite-faint">{'★'.repeat(c.rating)}{'☆'.repeat(5 - c.rating)}</span>
          )}
        </div>
        <div className="mt-0.5 text-xs text-graphite-soft">
          {c.email}
          {c.source && <span className="ml-2 text-graphite-faint">via {c.source}</span>}
        </div>
      </div>
      {!isTerminal && nextStage && (
        <Button
          variant="outline"
          onClick={() => onNext(nextStage)}
          className="flex-shrink-0 text-xs"
        >
          Move to {nextStage}
        </Button>
      )}
    </li>
  )
}

export default function JobDetailPage({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = use(params)
  const { me } = useAuth()
  const queryClient = useQueryClient()

  const job = useQuery({
    queryKey: ['job-opening', jobId],
    queryFn: () => api.jobOpening(jobId),
  })

  const candidates = useQuery({
    queryKey: ['candidates', jobId],
    queryFn: () => api.candidates(jobId, { pageSize: 100 }),
  })

  const transition = useMutation({
    mutationFn: ({ candidateId, stage }: { candidateId: string; stage: string }) =>
      api.transitionCandidate(candidateId, stage),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['candidates', jobId] })
    },
  })

  const j = job.data
  const items = candidates.data?.data ?? []

  const stageCounts = PIPELINE_STAGES.reduce(
    (acc, s) => { acc[s] = items.filter((c: Candidate) => c.stage === s).length; return acc },
    {} as Record<string, number>,
  )

  return (
    <RequireAuth>
      <AppShell>
        <Link href="/recruitment" className="mb-4 inline-flex items-center gap-1.5 text-sm text-teal hover:underline">
          <ArrowLeft className="h-4 w-4" />
          All openings
        </Link>

        {job.isPending ? (
          <Spinner />
        ) : job.isError ? (
          <Alert>Failed to load job opening.</Alert>
        ) : j ? (
          <div className="space-y-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h1 className="text-2xl font-semibold text-teal">{j.title}</h1>
                <div className="mt-1 flex flex-wrap items-center gap-3 text-sm text-graphite-soft">
                  {j.departmentName && (
                    <span className="inline-flex items-center gap-1">
                      <Users className="h-3.5 w-3.5" /> {j.departmentName}
                    </span>
                  )}
                  {j.locationName && (
                    <span className="inline-flex items-center gap-1">
                      <MapPin className="h-3.5 w-3.5" /> {j.locationName}
                    </span>
                  )}
                  {(j.salaryMin || j.salaryMax) && (
                    <span className="inline-flex items-center gap-1">
                      <DollarSign className="h-3.5 w-3.5" />
                      {j.salaryMin && j.salaryMax
                        ? `${j.salaryMin}–${j.salaryMax} ${j.currency}`
                        : j.salaryMin
                          ? `From ${j.salaryMin} ${j.currency}`
                          : `Up to ${j.salaryMax} ${j.currency}`}
                    </span>
                  )}
                  <span className="capitalize">{j.employmentType}</span>
                  <Badge tone={STATUS_TONE[j.status] ?? 'slate'}>
                    {STATUS_LABEL[j.status] ?? j.status}
                  </Badge>
                </div>
              </div>
            </div>

            {(j.description || j.requirements) && (
              <Card>
                {j.description && (
                  <div className="mb-3">
                    <CardTitle className="text-teal-soft">Description</CardTitle>
                    <p className="text-sm text-graphite-soft whitespace-pre-line">{j.description}</p>
                  </div>
                )}
                {j.requirements && (
                  <div>
                    <CardTitle className="text-teal-soft">Requirements</CardTitle>
                    <p className="text-sm text-graphite-soft whitespace-pre-line">{j.requirements}</p>
                  </div>
                )}
              </Card>
            )}

            <Card>
              <CardTitle className="text-teal-soft">Pipeline</CardTitle>
              <div className="mb-4 flex flex-wrap gap-2">
                {PIPELINE_STAGES.filter((s) => s !== 'rejected').map((s) => (
                  <div
                    key={s}
                    className="flex items-center gap-1.5 rounded-full border border-teal-tint bg-teal-tint px-3 py-1 text-xs font-medium text-teal"
                  >
                    <span className="capitalize">{s}</span>
                    <span className="rounded-full bg-teal text-paper px-1.5 text-[10px] font-bold">
                      {stageCounts[s] ?? 0}
                    </span>
                  </div>
                ))}
              </div>

              {candidates.isPending ? (
                <Spinner />
              ) : items.length === 0 ? (
                <p className="text-sm text-graphite-soft">No candidates yet.</p>
              ) : (
                <ul className="space-y-2">
                  {items.map((c: Candidate) => (
                    <CandidateRow
                      key={c.id}
                      c={c}
                      onNext={(stage) => transition.mutate({ candidateId: c.id, stage })}
                    />
                  ))}
                </ul>
              )}
              {transition.isError && <Alert tone="red">Failed to transition candidate.</Alert>}
            </Card>
          </div>
        ) : null}
      </AppShell>
    </RequireAuth>
  )
}
