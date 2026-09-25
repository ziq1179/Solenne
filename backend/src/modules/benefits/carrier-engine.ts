/**
 * CarrierEngine interface + stub implementation.
 *
 * The interface is the integration point for real carrier integrations
 * (EDI 834, carrier APIs, benefits admin vendors like Benefitfocus).
 * The stub returns `transmitted: false` — the same pattern as
 * TaxEngine's `compliant: false`.
 */

export interface CarrierEnrollmentInput {
  tenantId: string
  employeeId: string
  planName: string
  planType: string
  coverageTier: string
  employeePremium: number
  employerPremium: number
  dependents: Array<{
    firstName: string
    lastName: string
    relationship: string
    dateOfBirth: string
  }>
}

export interface CarrierEnrollmentOutput {
  /** Whether this enrollment was actually transmitted to a carrier. */
  transmitted: boolean
  /** Carrier reference ID (if transmitted). */
  carrierReferenceId: string | null
  /** Human-readable status message. */
  message: string
}

export interface CarrierEngine {
  transmitEnrollment(input: CarrierEnrollmentInput): CarrierEnrollmentOutput
  withdrawEnrollment(carrierReferenceId: string): CarrierEnrollmentOutput
}

/**
 * Stub/demo carrier engine. Does not transmit anything.
 * Returns transmitted: false to signal this is NOT real carrier integration.
 */
export class StubCarrierEngine implements CarrierEngine {
  transmitEnrollment(_input: CarrierEnrollmentInput): CarrierEnrollmentOutput {
    return {
      transmitted: false,
      carrierReferenceId: null,
      message: 'Stub engine: enrollment recorded in system only. Connect a real carrier integration to transmit enrollments.',
    }
  }

  withdrawEnrollment(_carrierReferenceId: string): CarrierEnrollmentOutput {
    return {
      transmitted: false,
      carrierReferenceId: null,
      message: 'Stub engine: withdrawal recorded in system only.',
    }
  }
}
