export interface PlainBookmarkContent {
  url: string;
  title: string | null;
  bodyText: string | null;
  tags: string[];
  category: string | null;
}

export interface StoredBookmarkContent {
  urlEncrypted: string;
  titleEncrypted: string | null;
  bodyTextEncrypted: string | null;
  tagsEncrypted: string | null;
  categoryEncrypted: string | null;
  urlLookup: string;
  categoryLookup: string | null;
  tagLookups: string[];
  searchDocument: string;
}

export interface BookmarkEncryptionService {
  pack(content: PlainBookmarkContent): Promise<StoredBookmarkContent>;
  decryptField(ciphertext: string | null, legacyPlaintext?: string | null): Promise<string | null>;
  buildUrlLookup(url: string): Promise<string>;
  buildCategoryLookup(category: string): Promise<string>;
  buildTagLookup(tag: string): Promise<string>;
  buildSearchQuery(termGroups: string[][]): Promise<string | null>;
}

const AES_ALGORITHM = 'AES-GCM';
const HMAC_ALGORITHM = 'HMAC';
const HMAC_HASH = 'SHA-256';
const IV_BYTES = 12;
const VERSION = 'v1';
const MAX_INDEXED_BODY_TERMS = 120;
const MAX_INDEXED_TERMS = 160;

export class WebCryptoBookmarkEncryptionService implements BookmarkEncryptionService {
  private readonly encryptionKeyPromise: Promise<CryptoKey>;
  private readonly hmacKeyPromise: Promise<CryptoKey>;

  constructor(base64Key: string) {
    const rawKey = base64ToBytes(base64Key);
    if (rawKey.byteLength !== 32) {
      throw new Error('BOOKMARK_ENCRYPTION_KEY must decode to exactly 32 bytes');
    }

    this.encryptionKeyPromise = crypto.subtle.importKey('raw', rawKey, AES_ALGORITHM, false, ['encrypt', 'decrypt']);
    this.hmacKeyPromise = crypto.subtle.importKey(
      'raw',
      rawKey,
      { name: HMAC_ALGORITHM, hash: HMAC_HASH },
      false,
      ['sign']
    );
  }

  async pack(content: PlainBookmarkContent): Promise<StoredBookmarkContent> {
    const [urlEncrypted, titleEncrypted, bodyTextEncrypted, tagsEncrypted, categoryEncrypted, urlLookup, categoryLookup] =
      await Promise.all([
        this.encryptField(content.url),
        this.encryptNullableField(content.title),
        this.encryptNullableField(content.bodyText),
        this.encryptNullableField(JSON.stringify(content.tags)),
        this.encryptNullableField(content.category),
        this.buildUrlLookup(content.url),
        content.category ? this.buildCategoryLookup(content.category) : Promise.resolve(null),
      ]);

    const tagLookups = await Promise.all(content.tags.map((tag) => this.buildTagLookup(tag)));
    const searchDocument = await this.buildSearchDocument(content);

    return {
      urlEncrypted,
      titleEncrypted,
      bodyTextEncrypted,
      tagsEncrypted,
      categoryEncrypted,
      urlLookup,
      categoryLookup,
      tagLookups: dedupe(tagLookups),
      searchDocument,
    };
  }

  async decryptField(ciphertext: string | null, legacyPlaintext: string | null = null): Promise<string | null> {
    if (ciphertext) {
      const parts = ciphertext.split(':');
      if (parts.length !== 3 || parts[0] !== VERSION) {
        throw new Error('Unsupported bookmark ciphertext format');
      }

      const iv = base64ToBytes(parts[1]);
      const bytes = base64ToBytes(parts[2]);
      const key = await this.encryptionKeyPromise;
      const decrypted = await crypto.subtle.decrypt({ name: AES_ALGORITHM, iv }, key, bytes);
      return new TextDecoder().decode(decrypted);
    }

    return legacyPlaintext;
  }

  buildUrlLookup(url: string): Promise<string> {
    return this.lookupToken('url', url.trim());
  }

  buildCategoryLookup(category: string): Promise<string> {
    return this.lookupToken('category', category.trim());
  }

  buildTagLookup(tag: string): Promise<string> {
    return this.lookupToken('tag', normalizeLookupTerm(tag));
  }

  async buildSearchQuery(termGroups: string[][]): Promise<string | null> {
    const clauses = await Promise.all(
      termGroups
        .map((group) => dedupe(group.map(normalizeSearchTerm).filter(Boolean)))
        .filter((group) => group.length > 0)
        .map(async (group) => {
          const hashes = await Promise.all(group.map((term) => this.lookupToken('search', term)));
          return `(${hashes.map((hash) => `"${hash}"`).join(' ')})`;
        })
    );

    if (clauses.length === 0) return null;
    return clauses.join(' OR ');
  }

  private async buildSearchDocument(content: PlainBookmarkContent): Promise<string> {
    const terms = collectSearchTerms(content);
    if (terms.length === 0) return '';

    const hashes = await Promise.all(terms.map((term) => this.lookupToken('search', term)));
    return hashes.join(' ');
  }

  private async encryptNullableField(value: string | null): Promise<string | null> {
    return value ? this.encryptField(value) : null;
  }

  private async encryptField(value: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const key = await this.encryptionKeyPromise;
    const ciphertext = await crypto.subtle.encrypt({ name: AES_ALGORITHM, iv }, key, new TextEncoder().encode(value));
    return `${VERSION}:${bytesToBase64(iv)}:${bytesToBase64(new Uint8Array(ciphertext))}`;
  }

  private async lookupToken(scope: string, value: string): Promise<string> {
    const key = await this.hmacKeyPromise;
    const signature = await crypto.subtle.sign(HMAC_ALGORITHM, key, new TextEncoder().encode(`${scope}:${value}`));
    return bytesToHex(new Uint8Array(signature));
  }
}

function collectSearchTerms(content: PlainBookmarkContent): string[] {
  const prioritized = [
    ...extractSearchTerms(content.url),
    ...extractSearchTerms(content.title ?? ''),
    ...extractSearchTerms(content.category ?? ''),
    ...content.tags.flatMap((tag) => extractSearchTerms(tag)),
  ];
  const bodyTerms = extractSearchTerms(content.bodyText ?? '').slice(0, MAX_INDEXED_BODY_TERMS);

  return dedupe([...prioritized, ...bodyTerms]).slice(0, MAX_INDEXED_TERMS);
}

function extractSearchTerms(input: string): string[] {
  return (input.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(Boolean);
}

function normalizeSearchTerm(term: string): string {
  return (term.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join('');
}

function normalizeLookupTerm(term: string): string {
  return term.trim().toLowerCase();
}

function dedupe<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
