'use client'

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Bell, BellOff, CheckCheck } from 'lucide-react'
import { api, type Notification } from '@/lib/api'
import { useAuth } from '@/components/auth'
import { AppShell, RequireAuth } from '@/components/shell'
import { Alert, Badge, Button, Card, CardTitle, Spinner } from '@/components/ui'

const TYPE_LABELS: Record<string, string> = {
  'leave.requested': 'Leave requested',
  'leave.approved': 'Leave approved',
  'leave.rejected': 'Leave rejected',
  'attendance.clocked_in': 'Clocked in',
  'attendance.clocked_out': 'Clocked out',
  'employee.hired': 'Employee hired',
  'employee.terminated': 'Employee terminated',
  'onboarding.onboarding_started': 'Onboarding started',
  'onboarding.onboarding_completed': 'Onboarding completed',
}

const TYPE_TONE: Record<string, 'green' | 'amber' | 'red' | 'sky' | 'slate'> = {
  'leave.approved': 'green',
  'leave.rejected': 'red',
  'leave.requested': 'amber',
  'employee.hired': 'green',
  'employee.terminated': 'red',
  'attendance.clocked_in': 'sky',
  'attendance.clocked_out': 'slate',
  'onboarding.onboarding_started': 'sky',
  'onboarding.onboarding_completed': 'green',
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

export default function NotificationsPage() {
  const { me } = useAuth()
  const queryClient = useQueryClient()

  const notifications = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api.notifications({ pageSize: 50 }),
    enabled: !!me,
  })

  const unreadCount = useQuery({
    queryKey: ['notifications-unread'],
    queryFn: () => api.unreadCount(),
    enabled: !!me,
  })

  const markRead = useMutation({
    mutationFn: (id: string) => api.markRead(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] })
      queryClient.invalidateQueries({ queryKey: ['notifications-unread'] })
    },
  })

  const markAllRead = useMutation({
    mutationFn: () => api.markAllRead(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] })
      queryClient.invalidateQueries({ queryKey: ['notifications-unread'] })
    },
  })

  const items = notifications.data?.data ?? []
  const unread = unreadCount.data?.n ?? 0

  return (
    <RequireAuth>
      <AppShell>
        <div className="mb-6 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold">Notifications</h1>
            {unread > 0 && (
              <Badge tone="sky">{unread} unread</Badge>
            )}
          </div>
          {unread > 0 && (
            <Button
              variant="ghost"
              loading={markAllRead.isPending}
              onClick={() => markAllRead.mutate()}
            >
              <CheckCheck className="h-4 w-4" />
              Mark all read
            </Button>
          )}
        </div>

        {notifications.isPending ? (
          <Spinner />
        ) : notifications.isError ? (
          <Alert>Failed to load notifications.</Alert>
        ) : items.length === 0 ? (
          <Card>
            <div className="flex flex-col items-center gap-3 py-8 text-center">
              <BellOff className="h-8 w-8 text-graphite-faint" />
              <p className="text-sm text-graphite-soft">No notifications yet.</p>
            </div>
          </Card>
        ) : (
          <Card>
            <ul className="divide-y divide-line">
              {items.map((n: Notification) => (
                <li
                  key={n.id}
                  className={`flex items-start gap-3 px-4 py-3 transition ${
                    n.isRead ? 'opacity-60' : 'bg-cobalt-tint/30'
                  }`}
                >
                  <div className="mt-0.5 flex-shrink-0">
                    {n.isRead ? (
                      <Bell className="h-4 w-4 text-graphite-faint" />
                    ) : (
                      <Bell className="h-4 w-4 text-cobalt" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-ink">{n.title}</span>
                      <Badge tone={TYPE_TONE[n.type] ?? 'slate'}>
                        {TYPE_LABELS[n.type] ?? n.type}
                      </Badge>
                    </div>
                    {n.body && (
                      <p className="mt-1 text-sm text-graphite-soft">{n.body}</p>
                    )}
                    <span className="mt-1 block text-xs text-graphite-faint">
                      {timeAgo(n.createdAt)}
                    </span>
                  </div>
                  {!n.isRead && (
                    <button
                      onClick={() => markRead.mutate(n.id)}
                      className="mt-0.5 flex-shrink-0 text-xs text-cobalt hover:underline"
                    >
                      Mark read
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        )}
      </AppShell>
    </RequireAuth>
  )
}
