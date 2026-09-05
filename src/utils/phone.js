// Normalizes a phone number for duplicate-detection: strips everything but
// digits, then drops a leading country-exit/trunk pattern so "+91 98765
// 43210", "0091-98765-43210" and "9876543210" all collapse to the same key.
export function normalizePhone(rawPhone) {
  const digitsOnly = String(rawPhone || "").replace(/\D/g, "");

  if (digitsOnly.length > 10) {
    return digitsOnly.slice(-10);
  }
  return digitsOnly;
}

// Loose but real validation: 7-15 digits, optional leading +, spaces/dashes allowed.
export function isValidPhone(rawPhone) {
  const trimmed = String(rawPhone || "").trim();
  if (!/^\+?[0-9\s-]{7,20}$/.test(trimmed)) return false;
  const digits = trimmed.replace(/\D/g, "");
  return digits.length >= 7 && digits.length <= 15;
}
