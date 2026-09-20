'use client'

import { useEffect, useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { CalendarClock } from 'lucide-react'
import { Alert, Button, Input, Label } from '@/components/ui'
import { useAuth } from '@/components/auth'
import { ApiError } from '@/lib/api'

export default function SignupPage() {
  const { me, loading, signup } = useAuth()
  const router = useRouter()
  const [companyName, setCompanyName] = useState('')
  const [subdomain, setSubdomain] = useState('')
  const [adminFirstName, setAdminFirstName] = useState('')
  const [adminLastName, setAdminLastName] = useState('')
  const [adminEmail, setAdminEmail] = useState('')
  const [adminPassword, setAdminPassword] = useState('')
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
      await signup({
        companyName: companyName.trim(),
        subdomain: subdomain.trim().toLowerCase(),
        adminFirstName: adminFirstName.trim(),
        adminLastName: adminLastName.trim(),
        adminEmail: adminEmail.trim(),
        adminPassword,
      })
      router.replace('/dashboard')
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'CONFLICT') setError('That subdomain is already taken. Try another one.')
        else if (err.code === 'BAD_REQUEST') setError('Please check the details and try again.')
        else setError(err.detail ? String(err.detail) : 'Unable to create your workspace.')
      } else setError('Unable to reach the API. Check the network.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid min-h-screen place-items-center bg-slate-950 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center justify-center gap-2">
          <CalendarClock className="h-7 w-7 text-sky-400" />
          <div className="text-xl font-semibold text-slate-100">
            Solenne <span className="text-sky-400">ESS</span>
          </div>
        </div>
        <form onSubmit={onSubmit} className="space-y-4 rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
          <div>
            <Label>Company name</Label>
            <Input
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              placeholder="Acme Corp"
              autoComplete="organization"
              required
            />
          </div>
          <div>
            <Label>Subdomain</Label>
            <Input
              value={subdomain}
              onChange={(e) => setSubdomain(e.target.value)}
              placeholder="acme"
              autoComplete="organization"
              required
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>First name</Label>
              <Input
                value={adminFirstName}
                onChange={(e) => setAdminFirstName(e.target.value)}
                autoComplete="given-name"
                required
              />
            </div>
            <div>
              <Label>Last name</Label>
              <Input
                value={adminLastName}
                onChange={(e) => setAdminLastName(e.target.value)}
                autoComplete="family-name"
                required
              />
            </div>
          </div>
          <div>
            <Label>Admin email</Label>
            <Input
              type="email"
              value={adminEmail}
              onChange={(e) => setAdminEmail(e.target.value)}
              placeholder="you@company.com"
              autoComplete="email"
              required
            />
          </div>
          <div>
            <Label>Password</Label>
            <Input
              type="password"
              value={adminPassword}
              onChange={(e) => setAdminPassword(e.target.value)}
              placeholder="At least 8 characters"
              autoComplete="new-password"
              minLength={8}
              required
            />
          </div>
          {error && <Alert>{error}</Alert>}
          <Button type="submit" loading={busy} className="w-full">
            Create workspace
          </Button>
        </form>
        <p className="mt-6 text-center text-xs text-slate-500">
          Already have a workspace?{' '}
          <Link href="/login" className="text-sky-400 hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  )
}