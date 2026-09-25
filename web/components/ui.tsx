'use client'

import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react'
import { clsx } from 'clsx'
import { LoaderCircle } from 'lucide-react'

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={clsx('rounded-xl border border-line bg-paper p-5 shadow-sm', className)}>
      {children}
    </div>
  )
}

export function CardTitle({ children, className }: { children: ReactNode; className?: string }) {
  return <h2 className={clsx('mb-4 font-display text-sm font-medium uppercase tracking-wide text-graphite-soft', className)}>{children}</h2>
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'ghost' | 'danger' | 'outline'
  loading?: boolean
}

export function Button({ variant = 'primary', loading, className, children, disabled, ...rest }: ButtonProps) {
  return (
    <button
      className={clsx(
        'inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50',
        variant === 'primary' && 'bg-brass text-paper hover:bg-brass-soft',
        variant === 'ghost' && 'text-graphite-soft hover:bg-paper-dim hover:text-ink',
        variant === 'danger' && 'bg-wine text-paper hover:bg-wine-soft',
        variant === 'outline' && 'border border-line text-ink hover:border-line-dark hover:bg-paper-dim',
        className,
      )}
      disabled={disabled || loading}
      {...rest}
    >
      {loading && <LoaderCircle className="h-4 w-4 animate-spin" />}
      {children}
    </button>
  )
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={clsx(
        'w-full rounded-lg border border-line bg-paper px-3 py-2 text-sm text-ink placeholder:text-graphite-faint focus:border-brass focus:outline-none',
        className,
      )}
      {...rest}
    />
  )
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={clsx(
        'w-full rounded-lg border border-line bg-paper px-3 py-2 text-sm text-ink focus:border-brass focus:outline-none',
        className,
      )}
      {...rest}
    >
      {children}
    </select>
  )
}

export function Label({ children }: { children: ReactNode }) {
  return <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-graphite-soft">{children}</label>
}

const BADGE_TONES: Record<string, string> = {
  slate: 'bg-paper-dim text-graphite-soft',
  green: 'bg-forest-tint text-forest',
  amber: 'bg-brass-tint text-brass-ink',
  red: 'bg-wine-tint text-wine',
  sky: 'bg-cobalt-tint text-cobalt',
}

export function Badge({ tone = 'slate', children }: { tone?: 'slate' | 'green' | 'amber' | 'red' | 'sky'; children: ReactNode }) {
  return (
    <span className={clsx('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium', BADGE_TONES[tone])}>
      {children}
    </span>
  )
}

export function CardLabel({ children }: { children: ReactNode }) {
  return <div className="mb-1 text-xs font-medium uppercase tracking-wide text-graphite-soft">{children}</div>
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2">
      <LoaderCircle className="h-4 w-4 animate-spin text-brass" />
      <span className="text-sm text-graphite-soft">{label}</span>
    </div>
  )
}

const ALERT_TONES: Record<string, string> = {
  red: 'border-wine bg-wine-tint text-wine-ink',
  amber: 'border-brass bg-brass-tint text-brass-ink',
  green: 'border-forest bg-forest-tint text-forest-ink',
  sky: 'border-cobalt bg-cobalt-tint text-cobalt-ink',
  slate: 'border-line bg-paper-dim text-graphite-soft',
}

export function Alert({ tone = 'red', children }: { tone?: 'red' | 'amber' | 'green' | 'sky' | 'slate'; children: ReactNode }) {
  return <div className={clsx('rounded-lg border px-4 py-3 text-sm', ALERT_TONES[tone])}>{children}</div>
}

export function Stat({ label, value, hint, className }: { label: string; value: ReactNode; hint?: string; className?: string }) {
  return (
    <div className={clsx('rounded-xl border border-line bg-paper p-4', className)}>
      <div className="text-xs font-medium uppercase tracking-wide text-graphite-soft">{label}</div>
      <div className="mt-1 font-display text-2xl font-medium text-ink">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-graphite-faint">{hint}</div>}
    </div>
  )
}

export function fmtDuration(minutes: number | null | undefined): string {
  if (minutes == null) return '—'
  const h = Math.floor(minutes / 60)
  const m = Math.round(minutes % 60)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

export function fmtDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function num(v: number | string | null | undefined): number | null {
  if (v == null || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

export function fmtMoney(v: number | string | null | undefined, currency = 'USD'): string {
  const n = num(v)
  if (n == null) return '—'
  return new Intl.NumberFormat(undefined, { style: 'currency', currency, minimumFractionDigits: 2 }).format(n)
}

export function fmtPeriod(start: string, end: string): string {
  const s = new Date(start)
  const e = new Date(end)
  const startLabel = s.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  const endLabel = e.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
  return `${startLabel} – ${endLabel}`
}
