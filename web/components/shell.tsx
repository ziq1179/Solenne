'use client'

import { useEffect, type ReactNode } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { CalendarClock, ChartBar, Home, LogOut, Plane } from 'lucide-react'
import { clsx } from 'clsx'
import { useAuth } from './auth'
import { Spinner } from './ui'

const NAV = [
  { href: '/dashboard', label: 'Dashboard', icon: Home },
  { href: '/leave', label: 'Leave', icon: Plane },
  { href: '/reports', label: 'Reports', icon: ChartBar },
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
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="sticky top-0 z-10 border-b border-slate-800 bg-slate-950/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-3">
          <div className="flex items-center gap-7">
            <Link href="/dashboard" className="flex items-center gap-2 text-sm font-semibold">
              <CalendarClock className="h-5 w-5 text-sky-400" />
              <span>
                Solenne <span className="text-sky-400">ESS</span>
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
                      active ? 'bg-slate-800 text-sky-400' : 'text-slate-400 hover:bg-slate-900 hover:text-slate-200',
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
                <div className="text-xs text-slate-500">{me.roles.join(', ')}</div>
              </div>
            )}
            <button
              onClick={logout}
              className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm text-slate-400 hover:bg-slate-900 hover:text-slate-200"
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