'use client'

import { useEffect, type ReactNode } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { Bell, Briefcase, CalendarClock, ChartBar, CreditCard, LogOut, MessageSquare, Plane, type LucideIcon } from 'lucide-react'
import { clsx } from 'clsx'
import { useAuth } from './auth'
import { Spinner } from './ui'

const NAV: { href: string; label: string; icon: LucideIcon }[] = [
  { href: '/dashboard', label: 'Dashboard', icon: CalendarClock },
  { href: '/leave', label: 'Leave', icon: Plane },
  { href: '/assistant', label: 'Assistant', icon: MessageSquare },
  { href: '/recruitment', label: 'Recruitment', icon: Briefcase },
  { href: '/reports', label: 'Reports', icon: ChartBar },
  { href: '/notifications', label: 'Notifications', icon: Bell },
  { href: '/billing', label: 'Billing', icon: CreditCard },
]

export function RequireAuth({ children }: { children: ReactNode }) {
  const { me, loading } = useAuth()
  const router = useRouter()

  useEffect(() => {
    if (!loading && !me) router.replace('/login')
  }, [loading, me, router])

  if (loading) {
    return (
      <div className="grid min-h-screen place-items-center">
        <Spinner label="Checking session…" />
      </div>
    )
  }
  if (!me) return null
  return children
}

export function AppShell({ children }: { children: ReactNode }) {
  const { me, logout } = useAuth()
  const pathname = usePathname()

  return (
    <div className="min-h-screen bg-paper text-ink">
      <header className="sticky top-0 z-10 border-b border-line bg-paper/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-3">
          <div className="flex items-center gap-7">
            <Link href="/dashboard" className="flex items-center gap-2 text-sm font-semibold">
              <CalendarClock className="h-5 w-5 text-brass" />
              <span>
                Trellis <span className="text-brass">ESS</span>
              </span>
            </Link>
            <nav className="hidden items-center gap-1 sm:flex">
              {NAV.map((item) => {
                const active = pathname === item.href || pathname.startsWith(item.href)
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={clsx(
                      'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm transition',
                      active ? 'bg-paper-dim text-brass' : 'text-graphite-soft hover:bg-paper-dim hover:text-ink',
                    )}
                  >
                    <item.icon className="h-4 w-4" />
                    {item.label}
                  </Link>
                )
              })}
            </nav>
          </div>
          <div className="flex items-center gap-3">
            {me && (
              <div className="hidden text-right sm:block">
                <div className="text-sm font-medium">{me.email}</div>
                <div className="text-xs text-graphite-soft">{me.roles.join(', ')}</div>
              </div>
            )}
            <button
              onClick={logout}
              className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm text-graphite-soft hover:bg-paper-dim hover:text-ink"
            >
              <LogOut className="h-4 w-4" />
              Log out
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-5 py-8">{children}</main>
    </div>
  )
}
