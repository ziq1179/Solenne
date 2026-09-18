/** Parses duration strings like "15m", "2h", "7d", "900s" into seconds. */
export function parseDuration(input: string): number {
  const m = /^(\d+)([smhd]?)$/.exec(input.trim())
  if (!m) throw new Error(`Invalid duration: ${input}`)
  const n = Number(m[1])
  const unit = m[2] ?? 's'
  const mult = { s: 1, m: 60, h: 3600, d: 86400 }[unit]!
  return n * mult
}