/**
 * The GST state codes, and the two characters of a GSTIN that carry one.
 *
 * In `domain/` because both the shop and the customer need exactly the same
 * answers and used to have only one of them. The shop could say which state it
 * was in; a customer could not, and `customers.ts` wrote the literal `'33'`
 * into every INSERT instead -- which is how every customer row in existence
 * came to claim Tamil Nadu, and how the inter-state path came to be decided by
 * a number nobody had typed.
 *
 * Pure and DB-free, so the rule is one copy and the two callers cannot drift.
 */

/**
 * The GST state codes, which are the census state codes and are not guessable
 * from the name — 33 is Tamil Nadu, 32 is Kerala, and nothing about either says
 * so. Listed rather than typed, because a shop should pick its state and never
 * meet the number.
 */
export const STATES: ReadonlyArray<{ code: string; name: string }> = [
  { code: '01', name: 'Jammu and Kashmir' },
  { code: '02', name: 'Himachal Pradesh' },
  { code: '03', name: 'Punjab' },
  { code: '04', name: 'Chandigarh' },
  { code: '05', name: 'Uttarakhand' },
  { code: '06', name: 'Haryana' },
  { code: '07', name: 'Delhi' },
  { code: '08', name: 'Rajasthan' },
  { code: '09', name: 'Uttar Pradesh' },
  { code: '10', name: 'Bihar' },
  { code: '11', name: 'Sikkim' },
  { code: '12', name: 'Arunachal Pradesh' },
  { code: '13', name: 'Nagaland' },
  { code: '14', name: 'Manipur' },
  { code: '15', name: 'Mizoram' },
  { code: '16', name: 'Tripura' },
  { code: '17', name: 'Meghalaya' },
  { code: '18', name: 'Assam' },
  { code: '19', name: 'West Bengal' },
  { code: '20', name: 'Jharkhand' },
  { code: '21', name: 'Odisha' },
  { code: '22', name: 'Chhattisgarh' },
  { code: '23', name: 'Madhya Pradesh' },
  { code: '24', name: 'Gujarat' },
  { code: '26', name: 'Dadra and Nagar Haveli and Daman and Diu' },
  { code: '27', name: 'Maharashtra' },
  { code: '29', name: 'Karnataka' },
  { code: '30', name: 'Goa' },
  { code: '31', name: 'Lakshadweep' },
  { code: '32', name: 'Kerala' },
  { code: '33', name: 'Tamil Nadu' },
  { code: '34', name: 'Puducherry' },
  { code: '35', name: 'Andaman and Nicobar Islands' },
  { code: '36', name: 'Telangana' },
  { code: '37', name: 'Andhra Pradesh' },
  { code: '38', name: 'Ladakh' },
  { code: '97', name: 'Other territory' },
]

const STATE_CODES = new Set(STATES.map((s) => s.code))

export function isStateCode(code: string | null | undefined): boolean {
  return typeof code === 'string' && STATE_CODES.has(code)
}

export function stateName(code: string | null): string | null {
  if (!code) return null
  return STATES.find((s) => s.code === code)?.name ?? null
}
