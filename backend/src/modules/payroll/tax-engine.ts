/**
 * TaxEngine interface + synthetic/demo implementation.
 *
 * The interface is the integration point for real compliance vendors
 * (ADP, Remote, Deel, local providers). The synthetic implementation
 * returns `compliant: false` and uses fixed US-flavored percentages
 * for demo/testing purposes only — NOT compliance-grade.
 */

export interface TaxInput {
  tenantCountry: string
  employeeCountry: string
  grossPay: number
  payFrequency: 'monthly' | 'biweekly' | 'weekly'
  taxYear: number
}

export interface TaxDeduction {
  name: string
  amount: number
}

export interface TaxOutput {
  deductions: TaxDeduction[]
  totalDeductions: number
  /** Whether this engine can legally produce payslips for this jurisdiction. */
  compliant: boolean
}

export interface TaxEngine {
  calculate(input: TaxInput): TaxOutput
}

/**
 * Synthetic/demo tax calculator. Fixed percentages, no real jurisdiction.
 * Returns compliant: false to signal this is NOT real tax compliance.
 */
export class SyntheticTaxEngine implements TaxEngine {
  calculate(input: TaxInput): TaxOutput {
    const gross = input.grossPay
    const deductions: TaxDeduction[] = [
      { name: 'Federal income tax', amount: round(gross * 0.15) },
      { name: 'FICA — Social Security', amount: round(gross * 0.062) },
      { name: 'FICA — Medicare', amount: round(gross * 0.0145) },
      { name: 'State income tax', amount: round(gross * 0.05) },
    ]
    const totalDeductions = deductions.reduce((sum, d) => sum + d.amount, 0)
    return { deductions, totalDeductions, compliant: false }
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}
