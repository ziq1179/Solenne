'use client'

import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react'
import { LoaderCircle } from 'lucide-react'
import { clsx } from 'clsx'

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={clsx('rounded-xl border border-slate-800 bg-slate-900/60 p-5', className)}>
      {children}
    </div>
  )
}

export function CardTitle({ children }: { children: ReactNode }) {
  return <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-slate-400">{children}</h2>
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
        variant === 'primary' && 'bg-sky-500 text-white hover:bg-sky-400',
        variant === 'ghost' && 'text-slate-300 hover:bg-slate-800',
        variant === 'danger' && 'bg-rose-600 text-white hover:bg-rose-500',
        variant === 'outline' && 'border border-slate-700 text-slate-200 hover:bg-slate-800',
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
        'w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-sky-500 focus:outline-none',
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
        'w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-sky-500 focus:outline-none',
        className,
      )}
      {...rest}
    >
      {children}
    </select>
  )
}

export function Label({ children }: { children: ReactNode }) {
  return <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-slate-400">{children}</label>
}

export function Badge({ tone = 'slate', children }: { tone?: 'slate' | 'green' | 'amber' | 'red' | 'sky'; children: ReactNode }) {
  const tones: Record<string, string> = {
    slate: 'bg-slate-800 text-slate-300',
    green: 'bg-emerald-500/15 text-emerald-400',
    amber: 'bg-amber-500/15 text-amber-400',
    red: 'bg-rose-500/15 text-rose-400',
    sky: 'bg-sky-500/15 text-sky-400',
  }
  return (
    <span className={clsx('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium', tones[tone])}>
      {children}
    </span>
  )
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 py-8 text-sm text-slate-400">
      <LoaderCircle className="h-4 w-4 animate-spin" />
      {label}
    </div>
  )
}

export function Alert({ tone = 'red', children }: { tone?: 'red' | 'amber' | 'green' | 'sky'; children: ReactNode }) {
  const tones: Record<string, string> = {
    red: 'border-rose-800/60 bg-rose-950/40 text-rose-200',
    amber: 'border-amber-800/60 bg-amber-950/40 text-amber-200',
    green: 'border-emerald-800/60 bg-emerald-950/40 text-emerald-200',
    sky: 'border-sky-800/60 bg-sky-950/40 text-sky-200',
  }
  return <div className={clsx('rounded-lg border px-4 py-3 text-sm', tones[tone])}>{children}</div>
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
      <div className="text-xs font-medium uppercase tracking-wider text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-slate-100">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-slate-500">{hint}</div>}
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