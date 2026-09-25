/**
 * SSO configuration types and validation schemas.
 */

import { z } from 'zod'

export const ssoConfigSchema = z.object({
  provider: z.literal('oidc'),
  discoveryUrl: z.string().url(),
  clientId: z.string().min(1),
  scopes: z.array(z.string()).optional(),
  allowedEmailDomains: z.array(z.string()).optional(),
  defaultRole: z.string().min(1).default('employee'),
  enforceSso: z.boolean().default(false),
})

export type SsoConfigData = z.infer<typeof ssoConfigSchema>

export interface SsoConfig {
  provider: 'oidc'
  discoveryUrl: string
  clientId: string
  scopes: string[]
  allowedEmailDomains: string[]
  defaultRole: string
  enforceSso: boolean
}

export interface SsoClaims {
  email: string
  name?: string
  raw?: Record<string, unknown>
}

export function parseSsoConfig(raw: Record<string, unknown>): SsoConfig {
  const parsed = ssoConfigSchema.parse(raw)
  return {
    provider: parsed.provider,
    discoveryUrl: parsed.discoveryUrl,
    clientId: parsed.clientId,
    scopes: parsed.scopes ?? ['openid', 'email', 'profile'],
    allowedEmailDomains: parsed.allowedEmailDomains ?? [],
    defaultRole: parsed.defaultRole,
    enforceSso: parsed.enforceSso,
  }
}
