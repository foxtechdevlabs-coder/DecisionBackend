// Short coupon codes: "FT" + 4 random uppercase alphanumeric characters
// (e.g. FT7K2M). Excludes visually ambiguous characters (0/O, 1/I) so codes
// are easy to read back over a phone call or a blurry Instagram screenshot.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateCouponCode() {
  let suffix = "";
  for (let i = 0; i < 4; i++) {
    suffix += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return `FT${suffix}`;
}

// Vouchers are generated in bulk by an admin (not one-per-user like coupons),
// so they get a couple of extra characters of entropy to keep collisions rare.
export function generateVoucherCode() {
  let suffix = "";
  for (let i = 0; i < 6; i++) {
    suffix += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return `FV${suffix}`;
}
