/**
 * The input behaviours the intake forms share.
 *
 * Both forms mask an SSN as it is typed, both derive an age from a date of
 * birth, and both show the customer's star sign beside it; the validator form
 * masks a card expiry the same way. They were written twice, once per form, and
 * drifted apart in small ways; they live here now so a fix lands in both.
 *
 * Formatting only — nothing here decides whether a value is acceptable. That is
 * `fieldWarning` in `form-warnings.ts`, which is advisory and never blocks.
 */

/** 123456789 -> 123-45-6789, as it is typed. */
export function formatSSN(value: string) {
  const d = value.replace(/\D/g, "").slice(0, 9);
  if (d.length <= 3) return d;
  if (d.length <= 5) return `${d.slice(0, 3)}-${d.slice(3)}`;
  return `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}`;
}

/** 0527 -> 05/27. Two digits of month, two of year, nothing else. */
export function formatExpDate(value: string) {
  const d = value.replace(/\D/g, "").slice(0, 4);
  if (d.length <= 2) return d;
  return `${d.slice(0, 2)}/${d.slice(2)}`;
}

/**
 * Whole years between a date of birth and today, or null when the date cannot
 * be read or the answer is implausible. Both forms fill an Age field from this
 * and both leave it editable — a customer disputing the arithmetic wins.
 */
export function calcAge(value: string) {
  const d = new Date(`${value}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age -= 1;
  return age >= 0 && age < 130 ? age : null;
}

/**
 * The customer's star sign, for the rapport prompt both forms show beside a
 * date of birth. It is never part of the payload — it exists only to give the
 * person on the call something human to open with.
 *
 * Capricorn appears twice on purpose: it is the sign that wraps the year end,
 * so it closes the list as well as opening it.
 */
const ZODIAC: { name: string; symbol: string; until: [number, number] }[] = [
  { name: "Capricorn", symbol: "♑", until: [1, 19] },
  { name: "Aquarius", symbol: "♒", until: [2, 18] },
  { name: "Pisces", symbol: "♓", until: [3, 20] },
  { name: "Aries", symbol: "♈", until: [4, 19] },
  { name: "Taurus", symbol: "♉", until: [5, 20] },
  { name: "Gemini", symbol: "♊", until: [6, 20] },
  { name: "Cancer", symbol: "♋", until: [7, 22] },
  { name: "Leo", symbol: "♌", until: [8, 22] },
  { name: "Virgo", symbol: "♍", until: [9, 22] },
  { name: "Libra", symbol: "♎", until: [10, 22] },
  { name: "Scorpio", symbol: "♏", until: [11, 21] },
  { name: "Sagittarius", symbol: "♐", until: [12, 21] },
  { name: "Capricorn", symbol: "♑", until: [12, 31] },
];

export function zodiacSign(value: string) {
  const d = new Date(`${value}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  const m = d.getMonth() + 1;
  const day = d.getDate();
  return ZODIAC.find(({ until }) => m < until[0] || (m === until[0] && day <= until[1])) ?? null;
}
