/**
 * Server-side token encryption using file-based key storage
 *
 * Tokens are encrypted with AES-GCM before storage in SQLite.
 * The encryption key is stored in a separate file (not in the database).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const ALGORITHM = 'AES-GCM';
const KEY_LENGTH = 256;
const IV_LENGTH = 12;
const SALT_LENGTH = 16;
const KEY_FILE_PATH = './data/.keyfile';

/**
 * Get or create the encryption key material
 * Stored in a file, separate from the encrypted data in SQLite
 */
function getOrCreateKeyMaterial(): Uint8Array {
  if (existsSync(KEY_FILE_PATH)) {
    const stored = readFileSync(KEY_FILE_PATH, 'utf-8');
    return Uint8Array.from(Buffer.from(stored, 'base64'));
  }

  // Ensure directory exists
  const dir = dirname(KEY_FILE_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Generate new random key material
  const keyMaterial = crypto.getRandomValues(new Uint8Array(32));
  writeFileSync(KEY_FILE_PATH, Buffer.from(keyMaterial).toString('base64'), {
    encoding: 'utf-8',
    mode: 0o600,
  });

  return keyMaterial;
}

/**
 * Convert a Uint8Array to a proper ArrayBuffer.
 * This is needed because in Node.js, Uint8Array.buffer may be a shared buffer
 * that's larger than the actual data, which causes crypto.subtle.importKey to fail.
 * We create a fresh ArrayBuffer by copying the data to ensure compatibility.
 */
function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(data.byteLength);
  new Uint8Array(buffer).set(data);
  return buffer;
}

/**
 * Derive an encryption key from the key material and salt
 */
async function deriveKey(keyMaterial: Uint8Array, salt: Uint8Array): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(keyMaterial),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: toArrayBuffer(salt),
      iterations: 100000,
      hash: 'SHA-256',
    },
    baseKey,
    { name: ALGORITHM, length: KEY_LENGTH },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Encrypt a token for secure storage
 * Returns base64-encoded string containing salt + iv + ciphertext
 */
export async function encryptToken(token: string): Promise<string> {
  const keyMaterial = getOrCreateKeyMaterial();
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const key = await deriveKey(keyMaterial, salt);

  const encoder = new TextEncoder();
  const data = encoder.encode(token);

  const ciphertext = await crypto.subtle.encrypt({ name: ALGORITHM, iv }, key, data);

  // Combine salt + iv + ciphertext
  const combined = new Uint8Array(SALT_LENGTH + IV_LENGTH + ciphertext.byteLength);
  combined.set(salt, 0);
  combined.set(iv, SALT_LENGTH);
  combined.set(new Uint8Array(ciphertext), SALT_LENGTH + IV_LENGTH);

  return Buffer.from(combined).toString('base64');
}

/**
 * Decrypt a token from storage
 */
export async function decryptToken(encryptedToken: string): Promise<string> {
  const keyMaterial = getOrCreateKeyMaterial();

  // Decode and extract components
  const combined = new Uint8Array(Buffer.from(encryptedToken, 'base64'));
  const salt = combined.slice(0, SALT_LENGTH);
  const iv = combined.slice(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const ciphertext = combined.slice(SALT_LENGTH + IV_LENGTH);

  const key = await deriveKey(keyMaterial, salt);

  const decrypted = await crypto.subtle.decrypt({ name: ALGORITHM, iv }, key, ciphertext);

  const decoder = new TextDecoder();
  return decoder.decode(decrypted);
}

/**
 * Mask a token for display (show first 4 and last 4 chars)
 */
export function maskToken(token: string): string {
  if (token.length <= 12) {
    return '••••••••';
  }
  return `${token.slice(0, 4)}${'•'.repeat(8)}${token.slice(-4)}`;
}

/**
 * Validate GitHub PAT format
 */
export function isValidPATFormat(token: string): boolean {
  return token.startsWith('ghp_') || token.startsWith('github_pat_');
}
