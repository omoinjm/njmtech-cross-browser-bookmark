/**
 * Encrypts OAuth refresh tokens before they're stored in D1, which has no
 * native column encryption. Route/repository code depends on this
 * interface, not on Web Crypto directly — a different key-management
 * approach later just means a new implementation.
 */
export interface EncryptedToken {
  ciphertext: string; // base64
  iv: string; // base64
}

export interface TokenCipher {
  encrypt(plaintext: string): Promise<EncryptedToken>;
  decrypt(encrypted: EncryptedToken): Promise<string>;
}

// 96 bits — the length AES-GCM is designed for; a longer IV works but costs
// an extra hashing step internally for no benefit here.
const IV_LENGTH_BYTES = 12;

export class WebCryptoTokenCipher implements TokenCipher {
  private keyPromise: Promise<CryptoKey> | null = null;

  constructor(private readonly base64Key: string) {}

  // Deferred until first actual use (not done in the constructor) — this is
  // built unconditionally for every request via container.ts's
  // buildDependencies, regardless of which route is being served. Importing
  // eagerly meant a missing/invalid TOKEN_ENCRYPTION_KEY (e.g. the OAuth
  // feature not being configured yet) would throw for every single request,
  // not just ones that actually touch auth.
  private getKey(): Promise<CryptoKey> {
    if (!this.keyPromise) {
      this.keyPromise = crypto.subtle.importKey('raw', base64ToBytes(this.base64Key), 'AES-GCM', false, [
        'encrypt',
        'decrypt',
      ]);
    }
    return this.keyPromise;
  }

  async encrypt(plaintext: string): Promise<EncryptedToken> {
    const key = await this.getKey();
    // A fresh random IV per call — AES-GCM security depends on never
    // reusing an IV with the same key, so this must never be derived from
    // anything predictable (e.g. a counter that could reset).
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH_BYTES));
    const ciphertextBuffer = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      new TextEncoder().encode(plaintext)
    );

    return {
      ciphertext: bytesToBase64(new Uint8Array(ciphertextBuffer)),
      iv: bytesToBase64(iv),
    };
  }

  async decrypt(encrypted: EncryptedToken): Promise<string> {
    const key = await this.getKey();
    const plaintextBuffer = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBytes(encrypted.iv) },
      key,
      base64ToBytes(encrypted.ciphertext)
    );

    return new TextDecoder().decode(plaintextBuffer);
  }
}

// Explicit `Uint8Array<ArrayBuffer>` (not the bare `Uint8Array` alias, which
// widens to `Uint8Array<ArrayBufferLike>`) — required for TS to accept this
// as a `BufferSource` in the Web Crypto calls above.
function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}
