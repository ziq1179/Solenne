'use client'

import { useEffect, useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { CalendarClock } from 'lucide-react'
import { Alert, Button, Input, Label } from '@/components/ui'
import { useAuth } from '@/components/auth'
import { ApiError } from '@/lib/api'

const DEFAULT_TENANT = 'acme'

export default function LoginPage() {
  const { me, loading, login } = useAuth()
  const router = useRouter()
  const [tenant, setTenant] = useState(DEFAULT_TENANT)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!loading && me) router.replace('/dashboard')
  }, [loading, me, router])

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await login(email, password, tenant.trim())
      router.replace('/dashboard')
    } catch (err) {
      if (err instanceof ApiError) setError(err.code === 'UNAUTHORIZED' ? 'Invalid tenant, email or password.' : err.detail ? String(err.detail) : 'Unable to sign in.')
      else setError('Unable to reach the API. Check the network.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid min-h-screen place-items-center bg-paper px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center justify-center gap-2">
          <CalendarClock className="h-7 w-7 text-brass" />
          <div className="font-display text-xl text-ink">
            Trellis <span className="text-brass">ESS</span>
          </div>
        </div>
        <form onSubmit={onSubmit} className="space-y-4 rounded-2xl border border-line bg-paper p-6">
          <div>
            <Label>Tenant subdomain</Label>
            <Input
              value={tenant}
              onChange={(e) => setTenant(e.target.value)}
              placeholder="acme"
              autoComplete="organization"
              required
            />
          </div>
          <div>
            <Label>Email</Label>
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@acme.com"
              autoComplete="email"
              required
            />
          </div>
          <div>
            <Label>Password</Label>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </div>
          {error && <Alert>{error}</Alert>}
          <Button type="submit" loading={busy} className="w-full">
            Sign in
          </Button>
        </form>
        <p className="mt-6 text-center text-xs text-graphite-soft">
          New here?{' '}
          <Link href="/signup" className="text-brass hover:underline">
            Create a workspace
          </Link>
        </p>
        <p className="mt-2 text-center text-xs text-graphite-soft">
          Demo: <code className="text-graphite-faint">acme</code> / <code className="text-graphite-faint">aisha@acme.com</code> /{' '}
          <code className="text-graphite-faint">employee123</code>
        </p>
      </div>
    </div>
  )
}
