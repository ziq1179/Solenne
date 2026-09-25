'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/components/auth'
import { Spinner } from '@/components/ui'

export default function Home() {
  const { me, loading } = useAuth()
  const router = useRouter()

  useEffect(() => {
    if (loading) return
    router.replace(me ? '/dashboard' : '/login')
  }, [loading, me, router])

  return (
    <div className="grid min-h-screen place-items-center">
      <Spinner label="Trellis — loading…" />
    </div>
  )
}