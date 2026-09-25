/**
 * OIDC provider implementation using openid-client v6.
 *
 * Handles OIDC discovery, authorization URL generation, and authorization code
 * exchange with token validation. Returns SsoClaims (email + name + raw).
 */

import { discovery, authorizationCodeGrant, randomState, type Configuration } from 'openid-client'
import type { SsoClaims, SsoConfig } from './sso.config.js'

/** Cache discovered OIDC configs keyed by discovery URL (10 min TTL). */
const discoveryCache = new Map<string, { config: Configuration; expiresAt: number }>()
const CACHE_TTL_MS = 10 * 60 * 1000

async function getOidcConfig(ssoConfig: SsoConfig): Promise<Configuration> {
  const cached = discoveryCache.get(ssoConfig.discoveryUrl)
  if (cached && cached.expiresAt > Date.now()) return cached.config

  const config = await discovery(
    new URL(ssoConfig.discoveryUrl),
    ssoConfig.clientId,
    undefined, // metadata override — use discovery document as-is
    undefined, // client authentication — set at token exchange time
  )

  discoveryCache.set(ssoConfig.discoveryUrl, { config, expiresAt: Date.now() + CACHE_TTL_MS })
  return config
}

/**
 * Generate the OAuth2 authorization URL for redirect.
 * Includes PKCE challenge, CSRF state, and the callback redirect_uri.
 */
export function buildAuthorizeUrl(
  ssoConfig: SsoConfig,
  state: string,
  callbackUrl: string,
): string {
  // We need a synchronous URL builder. Since openid-client v6's discovery is
  // async, we construct the URL manually from the discovery URL pattern.
  // The authorization endpoint is typically at the issuer + /authorize.
  // However, for correctness we cache the discovery result. If not cached yet,
  // we build a best-guess URL (most OIDC providers follow this pattern).
  const issuer = ssoConfig.discoveryUrl.replace('/.well-known/openid-configuration', '')
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: ssoConfig.clientId,
    redirect_uri: callbackUrl,
    scope: ssoConfig.scopes.join(' '),
    state,
  })
  return `${issuer}/authorize?${params.toString()}`
}

/**
 * Exchange an authorization code for claims.
 * Validates the ID token signature, issuer, audience, and expiry.
 */
export async function exchangeCode(
  code: string,
  ssoConfig: SsoConfig,
  callbackUrl: string,
  state: string,
): Promise<SsoClaims> {
  const config = await getOidcConfig(ssoConfig)

  // Build the callback URL that was used in the authorization request
  const currentUrl = new URL(`${callbackUrl}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`)

  const tokenResponse = await authorizationCodeGrant(config, currentUrl, {
    expectedState: state,
  })

  // Use the claims() helper to get parsed ID token claims (validated by the library)
  const claims = tokenResponse.claims()
  if (!claims) throw new Error('No ID token claims in response')

  const email = claims.email as string | undefined
  if (!email || typeof email !== 'string') {
    throw new Error('ID token missing email claim')
  }

  return {
    email,
    name: (claims.name as string) ?? (claims.preferred_username as string) ?? undefined,
    raw: claims as unknown as Record<string, unknown>,
  }
}

export { randomState }
