/**
 * Money is always an integer number of paise. 100 paise = 1 rupee.
 *
 * Floats are never used for money anywhere in this codebase. If you find
 * yourself wanting a decimal, you want paise.
 */

export type Paise = number

export class MoneyError extends Error {}

/** Throws unless the value is a non-negative integer count of paise. */
export function assertPaise(value: number, label = 'amount'): asserts value is Paise {
  if (!Number.isInteger(value)) {
    throw new MoneyError(`${label} must be an integer number of paise, got ${value}`)
  }
  if (value < 0) {
    throw new MoneyError(`${label} must not be negative, got ${value}`)
  }
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(`${label} exceeds the safe integer range`)
  }
}

/**
 * Applies a basis-point rate, rounding half away from zero.
 *
 * Math.round() rounds half toward +Infinity, which is fine for the
 * non-negative amounts we deal with, but be explicit about it since fee
 * rounding is the kind of thing that gets audited.
 */
export function applyBps(amountPaise: Paise, bps: number): Paise {
  assertPaise(amountPaise)
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
    throw new MoneyError(`bps must be an integer between 0 and 10000, got ${bps}`)
  }
  return Math.round((amountPaise * bps) / 10_000)
}

/** Formats paise for display, e.g. 50000 -> "₹500", 50050 -> "₹500.50". */
export function formatPaise(amountPaise: Paise): string {
  assertPaise(amountPaise)
  const rupees = Math.floor(amountPaise / 100)
  const paise = amountPaise % 100
  const grouped = new Intl.NumberFormat('en-IN').format(rupees)
  return paise === 0 ? `₹${grouped}` : `₹${grouped}.${String(paise).padStart(2, '0')}`
}

export function rupeesToPaise(rupees: number): Paise {
  const paise = Math.round(rupees * 100)
  assertPaise(paise)
  return paise
}
