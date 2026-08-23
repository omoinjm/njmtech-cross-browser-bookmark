// Excludes visually-ambiguous characters (0/O, 1/l/I) — this password gets
// read off an email and typed in by hand at least once, so avoiding
// characters a person could easily misread matters more than maximizing
// the alphabet size.
const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const PASSWORD_LENGTH = 16;

/**
 * A random auto-generated password for a new/reset account, emailed to the
 * user (see services/email-sender.ts) — never chosen by the user, never
 * returned in an API response. 16 chars from a 58-char alphabet is ~93 bits
 * of entropy, comfortably strong for a credential nobody has to memorize
 * (see change-password for switching to something memorable).
 */
export function generatePassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(PASSWORD_LENGTH));
  return Array.from(bytes, (b) => PASSWORD_ALPHABET[b % PASSWORD_ALPHABET.length]).join('');
}
