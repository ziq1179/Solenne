import {
  createHash,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto'

/** SHA-256 hex digest of `input`. */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

/** Time-ordered UUID (v7-shaped) — unique and sortable, no extensions needed. */
export function ulidSafeUuid(): string {
  const b = randomBytes(16)
  const t = BigInt(Date.now())
  for (let i = 0; i < 6; i++) {
    b[i] = Number((t >> BigInt(40 - i * 8)) & 0xffn)
  }
  b[6] = (b[6]! & 0x0f) | 0x70 // version 7
  b[8] = (b[8]! & 0x3f) | 0x80 // RFC 4122 variant
  const hex = b.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function scryptAsync(
  password: string,
  salt: string,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, options, (err, derived) =>
      err ? reject(err) : resolve(derived as Buffer),
    )
  })
}

const SCRYPT_N = 16384
const SCRYPT_R = 8
const SCRYPT_P = 1
const SCRYPT_KEYLEN = 32

/** Hash a password with scrypt (OpenSSL defaults). Format: `scrypt$N$r$p$salt$hash`. */
export async function scryptHash(password: string): Promise<string> {
  const salt = randomBytes(16).toString('base64url')
  const hash = await scryptAsync(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P })
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt}$${hash.toString('base64url')}`
}

/** Verify a password against a stored `scrypt$...` hash. */
export async function scryptVerify(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [, nStr, rStr, pStr, salt, hashB64] = parts
  try {
    const hash = await scryptAsync(password, salt!, SCRYPT_KEYLEN, {
      N: Number(nStr),
      r: Number(rStr),
      p: Number(pStr),
    })
    return timingSafeEqual(hash, Buffer.from(hashB64!, 'base64url'))
  } catch {
    return false
  }
}

/** Constant-time O(1)-ish string equality is handled per-field; token equality via hash. */
export function newOpaqueToken(): string {
  return randomBytes(32).toString('hex')
}