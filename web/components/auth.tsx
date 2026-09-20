'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { api, clearTokens, getAccessToken, setTokens, type Me } from '@/lib/api'

interface AuthValue {
  me: Me | null
  loading: boolean
  login: (email: string, password: string, tenantSubdomain: string) => Promise<Me>
  logout: () => void
  refreshMe: () => Promise<void>
}

const AuthContext = createContext<AuthValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null)
  const [loading, setLoading] = useState(true)

  const refreshMe = useCallback(async () => {
    try {
      setMe(await api.me())
    } catch {
      clearTokens()
      setMe(null)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    if (!getAccessToken()) {
      const t = setTimeout(() => {
        if (!cancelled) setLoading(false)
      }, 0)
      return () => {
        cancelled = true
        clearTimeout(t)
      }
    }
    api
      .me()
      .then((m) => {
        if (!cancelled) setMe(m)
      })
      .catch(() => {
        if (!cancelled) {
          clearTokens()
          setMe(null)
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const login = useCallback(
    async (email: string, password: string, tenantSubdomain: string) => {
      const pair = await api.login({ email, password, tenantSubdomain })
      setTokens(pair)
      const m = await api.me()
      setMe(m)
      setLoading(false)
      return m
    },
    [],
  )

  const logout = useCallback(() => {
    clearTokens()
    setMe(null)
  }, [])

  const value = useMemo(
    () => ({ me, loading, login, logout, refreshMe }),
    [me, loading, login, logout, refreshMe],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}