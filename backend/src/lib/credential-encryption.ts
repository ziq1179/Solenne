/**
 * Envelope encryption for per-tenant integration credentials.
 *
 * Master key (KEK) wraps a randomly generated data key (DEK) per credential.
 * DEK encrypts the actual payload (AES-256-GCM). Stored format is 6 colon-
 * separated hex fields: wrapped_dek_iv:wrapped_dek_ct:wrapped_dek_tag:
 * payload_iv:payload_ct:payload_tag.
 */

import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'

const ALGO = 'aes-256-gcm'
const IV_LEN = 12
const TAG_LEN = 16
const DEK_LEN = 32

export interface EncryptedCredential {
  wrappedDek: string
  encryptedPayload: string
  keyVersion: number
}

function hex(buf: Buffer): string {
  return buf.toString('hex')
}

function dehex(s: string): Buffer {
  return Buffer.from(s, 'hex')
}

/** Encrypt plaintext with a random DEK, then wrap the DEK with the master key. */
export function encryptCredential(plaintext: string, masterKey: Buffer, keyVersion: number): EncryptedCredential {
  // Generate random DEK
  const dek = randomBytes(DEK_LEN)

  // Encrypt payload with DEK
  const payloadIv = randomBytes(IV_LEN)
  const payloadCipher = createCipheriv(ALGO, dek, payloadIv)
  const payloadEnc = Buffer.concat([payloadCipher.update(plaintext, 'utf8'), payloadCipher.final()])
  const payloadTag = payloadCipher.getAuthTag()
  const encryptedPayload = `${hex(payloadIv)}:${hex(payloadEnc)}:${hex(payloadTag)}`

  // Wrap DEK with master key
  const wrapIv = randomBytes(IV_LEN)
  const wrapCipher = createCipheriv(ALGO, masterKey, wrapIv)
  const wrappedDek = Buffer.concat([wrapCipher.update(dek), wrapCipher.final()])
  const wrapTag = wrapCipher.getAuthTag()
  const wrappedDekStr = `${hex(wrapIv)}:${hex(wrappedDek)}:${hex(wrapTag)}`

  return { wrappedDek: wrappedDekStr, encryptedPayload, keyVersion }
}

/** Decrypt: unwrap DEK with master key, then decrypt payload with DEK. */
export function decryptCredential(enc: EncryptedCredential, masterKey: Buffer): string {
  // Unwrap DEK
  const [wrapIv, wrapCt, wrapTag] = enc.wrappedDek.split(':') as [string, string, string]
  const wrapDecipher = createDecipheriv(ALGO, masterKey, dehex(wrapIv))
  wrapDecipher.setAuthTag(dehex(wrapTag))
  const dek = Buffer.concat([wrapDecipher.update(dehex(wrapCt)), wrapDecipher.final()])

  // Decrypt payload
  const [payloadIv, payloadCt, payloadTag] = enc.encryptedPayload.split(':') as [string, string, string]
  const payloadDecipher = createDecipheriv(ALGO, dek, dehex(payloadIv))
  payloadDecipher.setAuthTag(dehex(payloadTag))
  return Buffer.concat([payloadDecipher.update(dehex(payloadCt)), payloadDecipher.final()]).toString('utf8')
}

/** Serialize to colon-separated hex string for DB storage. */
export function serializeCredential(enc: EncryptedCredential): string {
  return `${enc.wrappedDek}:${enc.encryptedPayload}`
}

/** Parse serialized credential back into components. */
export function parseCredential(serialized: string): EncryptedCredential {
  const parts = serialized.split(':')
  if (parts.length !== 6) throw new Error('Malformed credential: expected 6 colon-separated hex fields')
  const wrappedDek = `${parts[0]}:${parts[1]}:${parts[2]}`
  const encryptedPayload = `${parts[3]}:${parts[4]}:${parts[5]}`
  return { wrappedDek, encryptedPayload, keyVersion: 1 }
}

/** Mask a credential for display: show last 4 chars, mask the rest. */
export function maskCredential(plaintext: string): string {
  if (plaintext.length < 8) return '****'
  const visible = plaintext.slice(-4)
  const masked = '*'.repeat(Math.min(plaintext.length - 4, 20))
  return `${masked}${visible}`
}
