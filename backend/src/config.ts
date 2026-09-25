export interface Config {
  port: number
  host: string
  /** Single source for the Postgres connection (Neon gives this directly). */
  databaseUrl: string | undefined
  /** Max simultaneous connections in the pg pool. */
  dbPoolSize: number
  /** TLS for Postgres: `true` = CA-verified. Never disable implicitly. */
  dbSsl: boolean | { rejectUnauthorized: boolean }
  jwtSecret: string
  jwtExpires: string
  refreshExpiresDays: number
  /** Integration Hub master key (KEK) for envelope encryption. undefined if not configured. */
  integrationHubKey: Buffer | undefined
  /** Current master key version (used when encrypting new credentials). */
  currentKeyVersion: number
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const sslRaw = env.DB_SSL ?? 'verify'
  return {
    port: Number(env.PORT ?? 4000),
    host: env.HOST ?? '0.0.0.0',
    databaseUrl: env.DATABASE_URL || undefined,
    dbPoolSize: Number(env.PGPOOL_MAX ?? 16),
    dbSsl:
      sslRaw === 'false'
        ? false
        : sslRaw === 'lenient'
          ? { rejectUnauthorized: false }
          : true,
    jwtSecret: env.JWT_SECRET ?? 'dev-only-secret-change-me',
    jwtExpires: env.JWT_EXPIRES ?? '15m',
    refreshExpiresDays: Number(env.REFRESH_EXPIRES_DAYS ?? 14),
    integrationHubKey: env.INTEGRATION_HUB_KEY
      ? Buffer.from(env.INTEGRATION_HUB_KEY, 'base64')
      : undefined,
    currentKeyVersion: Number(env.CURRENT_KEY_VERSION ?? 1),
  }
}

/** Loads `.env` into process.env when present (Node >= 20.12). */
export function loadEnvFile(): void {
  try {
    process.loadEnvFile(process.cwd() + '/.env')
  } catch {
    // .env is optional; silence "file not found"
  }
}