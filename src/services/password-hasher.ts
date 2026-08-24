/**
 * Hashes/verifies account passwords via PBKDF2 (Web Crypto — no native
 * bcrypt/Argon2 in the Workers runtime, and PBKDF2 via crypto.subtle is the
 * standard dependency-free choice here). Route code depends on this
 * interface, not on Web Crypto directly — a different KDF later just means
 * a new implementation.
 */
export interface PasswordHasher {
  /** Returns one self-describing string (algorithm + iterations + salt + hash) — no separate salt column needed. */
  hash(password: string): Promise<string>;
  verify(password: string, stored: string): Promise<boolean>;
}

// OWASP's 2023 minimum recommendation for PBKDF2-HMAC-SHA256 is 210,000, but
// the Workers runtime's crypto.subtle rejects anything above 100,000
// ("Pbkdf2 failed: iteration counts above 100000 are not supported") — this
// is the highest value that actually runs here. Each hash self-describes its
// own iteration count (see hash()/verify() below), so raising this later
// only affects newly-created hashes, not existing ones.
const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const KEY_LENGTH_BITS = 256;

export class WebCryptoPasswordHasher implements PasswordHasher {
  async hash(password: string): Promise<string> {
    const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
    const hashBytes = await derive(password, salt, PBKDF2_ITERATIONS);
    return `pbkdf2$${PBKDF2_ITERATIONS}$${bytesToBase64(salt)}$${bytesToBase64(hashBytes)}`;
  }

  async verify(password: string, stored: string): Promise<boolean> {
    const parts = stored.split('$');
    if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;

    const iterations = Number(parts[1]);
    if (!Number.isInteger(iterations) || iterations <= 0) return false;

    let salt: Uint8Array<ArrayBuffer>;
    try {
      salt = base64ToBytes(parts[2]);
    } catch {
      return false; // malformed stored value — never a match, but must not throw
    }

    const hashBytes = await derive(password, salt, iterations);
    return timingSafeEqual(bytesToBase64(hashBytes), parts[3]);
  }
}

async function derive(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, keyMaterial, KEY_LENGTH_BITS);
  return new Uint8Array(bits);
}

// Constant-time comparison — a login/verify path must never leak how many
// leading characters matched via response timing. Only safe to skip the
// length check up front because a length mismatch alone (not which byte
// differs) is not exploitable the way a byte-by-byte early-exit would be.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
