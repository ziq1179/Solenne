import type { Q, Row } from '../../db/index.js'
import { newId } from '../../db/index.js'

export interface AttendanceRecord {
  id: string
  employeeId: string
  clockInAt: string
  clockOutAt: string | null
  totalMinutes: number | null
}

interface AttendanceRow extends Row {
  id: string
  employeeId: string
  clockInAt: string
  clockOutAt: string | null
  totalMinutes: number | null
}

const COLS = `ar.id, ar.employee_id AS "employeeId",
  ar.clock_in_at::text AS "clockInAt", ar.clock_out_at::text AS "clockOutAt",
  ar.total_minutes::int4 AS "totalMinutes"`

function mapRecord(r: AttendanceRow): AttendanceRecord {
  return {
    id: r.id,
    employeeId: r.employeeId,
    clockInAt: r.clockInAt,
    clockOutAt: r.clockOutAt,
    totalMinutes: r.totalMinutes,
  }
}

export function getOpenRecord(q: Q, employeeId: string): Promise<AttendanceRecord | null> {
  return q
    .query<AttendanceRow>(
      `SELECT ${COLS} FROM attendance_records ar
       WHERE ar.employee_id = $1 AND ar.clock_out_at IS NULL
       ORDER BY ar.clock_in_at DESC
       LIMIT 1`,
      [employeeId],
    )
    .then((r) => (r.rows[0] ? mapRecord(r.rows[0]) : null))
}

/**
 * Inserts a clock-in unless the employee already has an open record. The
 * NOT EXISTS guard makes the check-and-insert one atomic statement, so two
 * concurrent clock-ins cannot both open a record for the same employee.
 * Returns null when one is already open (caller turns that into a 409).
 */
export async function insertClockIn(
  q: Q,
  input: { tenantId: string; employeeId: string; source: string; geo?: { lat: number; lng: number } | null },
): Promise<AttendanceRecord | null> {
  const id = newId()
  const geo = input.geo ? `(${input.geo.lat},${input.geo.lng})` : null
  const res = await q.query<AttendanceRow>(
    `INSERT INTO attendance_records AS ar
       (id, tenant_id, employee_id, clock_in_at, clock_in_source, clock_in_geo)
     SELECT $1, $2, $3, now(), $4, $5::point
     WHERE NOT EXISTS (
       SELECT 1 FROM attendance_records ar2
       WHERE ar2.employee_id = $3 AND ar2.clock_out_at IS NULL
     )
     RETURNING ${COLS}`,
    [id, input.tenantId, input.employeeId, input.source, geo],
  )
  return res.rows[0] ? mapRecord(res.rows[0]) : null
}

/** Closes the open record, computing total_minutes from now() - clock_in_at. */
export async function closeClockOut(q: Q, id: string): Promise<AttendanceRecord | null> {
  const res = await q.query<AttendanceRow>(
    `UPDATE attendance_records ar
     SET clock_out_at = now(),
         total_minutes = round(extract(epoch FROM (now() - ar.clock_in_at)) / 60)::int,
         updated_at = now()
     WHERE ar.id = $1 AND ar.clock_out_at IS NULL
     RETURNING ${COLS}`,
    [id],
  )
  return res.rows[0] ? mapRecord(res.rows[0]) : null
}

export async function listAttendance(
  q: Q,
  employeeId: string,
  from?: string,
  to?: string,
): Promise<AttendanceRecord[]> {
  const conds: string[] = [`ar.employee_id = $1`]
  const params: unknown[] = [employeeId]
  if (from) {
    params.push(from)
    conds.push(`ar.clock_in_at >= $${params.length}::date`)
  }
  if (to) {
    params.push(to)
    conds.push(`ar.clock_in_at < ($${params.length}::date + interval '1 day')`)
  }
  const res = await q.query<AttendanceRow>(
    `SELECT ${COLS} FROM attendance_records ar
     WHERE ${conds.join(' AND ')}
     ORDER BY ar.clock_in_at DESC
     LIMIT 100`,
    params,
  )
  return res.rows.map(mapRecord)
}