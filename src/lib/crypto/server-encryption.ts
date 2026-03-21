/**
 * Server-side secure token encryption using Node.js crypto
 *
 * Tokens are encrypted with AES-256-GCM before storage.
 * The encryption key is stored in the data directory (configurable via SQLITE_DATA_DIR env var).
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { errorMessage } from '../utils/error-message';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const KEY_FILE = 'encryption.key';

/**
 * Get the data directory for storing the encryption key
 */
function getDataDir(): string {
  return process.env.SQLITE_DATA_DIR || './data';
}

/**
 * Get or create the encryption key
 * Stored in the data directory as a file with restricted permissions (0o600)
 * @throws {Error} If the data directory cannot be created or the key file cannot be read/written
 */
function getOrCreateKey(): Buffer {
  const dataDir = getDataDir();
  const keyPath = path.join(dataDir, KEY_FILE);

  // Ensure data directory exists
  try {
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
  } catch (error) {
    throw new Error(
      `Cannot create data directory "${dataDir}". Please check permissions. ${errorMessage(error)}`
    );
  }

  // Read existing key
  if (fs.existsSync(keyPath)) {
    try {
      const key = fs.readFileSync(keyPath);
      if (key.length !== KEY_LENGTH) {
        throw new Error(
          `Encryption key file is corrupted (expected ${KEY_LENGTH} bytes, got ${key.length}). ` +
            `Delete "${keyPath}" to regenerate.`
        );
      }
      return key;
    } catch (error) {
      if (error instanceof Error && error.message.includes('corrupted')) {
        throw error;
      }
      throw new Error(
        `Cannot read encryption key from "${keyPath}". Please check file permissions. ` +
          errorMessage(error)
      );
    }
  }

  // Generate new random key (256 bits = 32 bytes)
  try {
    const key = crypto.randomBytes(KEY_LENGTH);
    // SECURITY: File permissions set to 0o600 (owner read/write only)
    fs.writeFileSync(keyPath, key, { mode: 0o600 });
    return key;
  } catch (error) {
    throw new Error(
      `Cannot write encryption key to "${keyPath}". Please check disk space and permissions. ` +
        errorMessage(error)
    );
  }
}

/**
 * Encrypt a token for secure storage
 * Returns base64-encoded string containing iv + tag + ciphertext
 */
export function encryptToken(token: string): string {
  const key = getOrCreateKey();
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Combine iv + tag + ciphertext
  const combined = Buffer.concat([iv, tag, encrypted]);

  return combined.toString('base64');
}

/**
 * Decrypt a token from storage
 * @throws {Error} If decryption fails due to corrupted data or wrong key
 */
export function decryptToken(encryptedToken: string): string {
  const key = getOrCreateKey();
  const combined = Buffer.from(encryptedToken, 'base64');

  // Validate minimum length
  const minLength = IV_LENGTH + TAG_LENGTH + 1; // At least 1 byte of ciphertext
  if (combined.length < minLength) {
    throw new Error(
      `Encrypted token is too short (${combined.length} bytes, minimum ${minLength}). Data may be corrupted.`
    );
  }

  // Extract components
  const iv = combined.subarray(0, IV_LENGTH);
  const tag = combined.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = combined.subarray(IV_LENGTH + TAG_LENGTH);

  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

    return decrypted.toString('utf8');
  } catch (error) {
    // Authentication tag mismatch or other crypto errors
    throw new Error(
      'Decryption failed. The encryption key may have changed or the data is corrupted. ' +
        errorMessage(error)
    );
  }
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
 * GitHub PATs start with 'ghp_' (classic) or 'github_pat_' (fine-grained)
 */
export function isValidPATFormat(token: string): boolean {
  return token.startsWith('ghp_') || token.startsWith('github_pat_');
}
