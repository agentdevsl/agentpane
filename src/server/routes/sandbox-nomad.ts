/**
 * Nomad sandbox routes
 *
 * Split from sandbox.ts as part of AR-023 (March 2026 architecture review).
 * Handles Nomad cluster status, namespace/datacenter listing, and connection validation.
 */

import { resolve as dnsResolve } from 'node:dns/promises';
import { Hono } from 'hono';
import { createLogger } from '../../lib/logging/logger.js';
import type { Database } from '../../types/database.js';
import { json } from '../shared.js';

const log = createLogger('SandboxNomadRoutes');

/**
 * Check whether an IP address string falls within a private or reserved range.
 * Covers IPv4 loopback, RFC 1918, link-local (including cloud metadata 169.254.x.x),
 * the unspecified address, and common IPv6 reserved addresses.
 */
function isPrivateIp(ip: string): boolean {
  // IPv6 reserved addresses
  if (ip === '::1' || ip === '::') return true;
  if (ip.toLowerCase().startsWith('fe80:')) return true;

  // IPv4 ranges
  const parts = ip.split('.');
  if (parts.length === 4) {
    const a = Number(parts[0]);
    const b = Number(parts[1]);
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local / cloud metadata
    if (ip === '0.0.0.0') return true;
  }

  return false;
}

/**
 * Validate Nomad address to prevent SSRF attacks against cloud metadata endpoints.
 * Returns { valid: true } on success or { valid: false, error: string } on failure.
 * Also performs DNS resolution to prevent DNS rebinding attacks.
 */
export async function validateNomadAddress(
  address: string
): Promise<{ valid: true } | { valid: false; error: string }> {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return { valid: false, error: 'Invalid Nomad address URL format' };
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    return { valid: false, error: 'Nomad address must use http or https protocol' };
  }
  const hostname = url.hostname;
  // Block cloud metadata endpoints (full 169.254.0.0/16 link-local range)
  if (hostname.startsWith('169.254.') || hostname === 'metadata.google.internal') {
    return { valid: false, error: 'Nomad address cannot target cloud metadata endpoints' };
  }
  // Block 0.0.0.0 (binds to all interfaces, effectively localhost)
  if (hostname === '0.0.0.0') {
    return { valid: false, error: 'Nomad address cannot target 0.0.0.0' };
  }
  // Block "localhost" hostname
  if (hostname === 'localhost') {
    return {
      valid: false,
      error: 'Nomad address cannot use "localhost" — use an IP address instead',
    };
  }
  // Restrict loopback addresses (127.x.x.x) to Nomad's default port (4646) only.
  // This prevents SSRF against other locally-bound services (Redis, databases, etc.)
  // while still allowing local Nomad development setups.
  const NOMAD_DEFAULT_PORT = 4646;
  if (hostname.startsWith('127.')) {
    const port = url.port ? parseInt(url.port, 10) : url.protocol === 'https:' ? 443 : 80;
    if (port !== NOMAD_DEFAULT_PORT) {
      return {
        valid: false,
        error: `Nomad address on loopback (127.x) must use port ${NOMAD_DEFAULT_PORT} to prevent SSRF`,
      };
    }
  }
  // Block IPv6 loopback and IPv6-mapped loopback/metadata addresses
  if (hostname === '[::1]' || hostname === '::1') {
    return { valid: false, error: 'Nomad address cannot target IPv6 loopback' };
  }
  const normalizedHost = hostname.replace(/^\[|\]$/g, '');
  if (
    normalizedHost === '::1' ||
    normalizedHost === '0:0:0:0:0:0:0:1' ||
    normalizedHost.startsWith('::ffff:169.254.') ||
    normalizedHost.startsWith('::ffff:127.') ||
    // URL constructor normalizes 169.254.x.y to hex a9fe:XXYY in IPv6-mapped form
    normalizedHost.startsWith('::ffff:a9fe:')
  ) {
    return {
      valid: false,
      error: 'Nomad address cannot target loopback or cloud metadata via IPv6',
    };
  }
  // Block IPv6 link-local (fe80::/10)
  if (hostname.startsWith('fe80:') || hostname.startsWith('[fe80:')) {
    return { valid: false, error: 'Nomad address cannot target IPv6 link-local addresses' };
  }
  // Block RFC 1918 private addresses in the 10.0.0.0/8 and 172.16.0.0/12 ranges
  const blockedPrefixes = [
    '10.',
    '172.16.',
    '172.17.',
    '172.18.',
    '172.19.',
    '172.20.',
    '172.21.',
    '172.22.',
    '172.23.',
    '172.24.',
    '172.25.',
    '172.26.',
    '172.27.',
    '172.28.',
    '172.29.',
    '172.30.',
    '172.31.',
  ];
  // 127.x is port-restricted to 4646 above. 10.x and 172.16-31.x are blocked because they
  // typically correspond to cloud VPC infrastructure (AWS VPC, GCP internal, etc.) where
  // SSRF could reach sensitive internal services or metadata endpoints.
  for (const prefix of blockedPrefixes) {
    if (hostname.startsWith(prefix)) {
      return { valid: false, error: 'Nomad address cannot target internal network addresses' };
    }
  }
  // Restrict 192.168.x.x (home/office LAN) to Nomad's default port (4646) only,
  // matching the 127.x restriction. This prevents SSRF against other LAN services
  // while still allowing local Nomad setups.
  if (hostname.startsWith('192.168.')) {
    const port = url.port ? parseInt(url.port, 10) : url.protocol === 'https:' ? 443 : 80;
    if (port !== NOMAD_DEFAULT_PORT) {
      return {
        valid: false,
        error: `Nomad address on LAN (192.168.x) must use port ${NOMAD_DEFAULT_PORT} to prevent SSRF`,
      };
    }
  }

  // Resolve DNS to prevent rebinding attacks.
  // Skip DNS check for literal IP addresses (they don't need resolution).
  const isLiteralIp =
    /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname) || hostname.includes(':');
  if (!isLiteralIp) {
    try {
      const addresses = await dnsResolve(hostname);
      for (const addr of addresses) {
        if (isPrivateIp(addr)) {
          return { valid: false, error: `Nomad address resolves to private/reserved IP: ${addr}` };
        }
      }
    } catch {
      // DNS resolution failure — fail-closed to prevent SSRF via DNS rebinding.
      // If users need to use internal hostnames, they should use IP addresses directly.
      return {
        valid: false,
        error: `Cannot resolve hostname "${hostname}" — DNS lookup failed. Use an IP address or ensure the hostname is resolvable.`,
      };
    }
  }

  return { valid: true };
}

interface NomadRouteDeps {
  db?: Database;
}

/**
 * Helper to load Nomad settings from DB or query params.
 * Token is ONLY loaded from the database, never from query/overrides.
 * If an address override is provided, it is validated against the SSRF blocklist.
 * The stored token is only attached when the address matches the persisted address
 * (prevents sending the token to an attacker-controlled server).
 */
async function loadNomadSettings(
  db: Database | undefined,
  overrides?: { address?: string; namespace?: string }
): Promise<{
  address?: string;
  token?: string;
  namespace: string;
  tokenDecryptionFailed?: boolean;
}> {
  // Validate overridden address against SSRF blocklist
  if (overrides?.address) {
    const addrValidation = await validateNomadAddress(overrides.address);
    if (!addrValidation.valid) {
      throw new Error(addrValidation.error);
    }
  }

  let address = overrides?.address;
  let token: string | undefined;
  let tokenDecryptionFailed = false;
  let namespace = overrides?.namespace ?? 'default';

  // Single DB query to load persisted Nomad settings
  if (db) {
    try {
      const { eq } = await import('drizzle-orm');
      const { settings } = await import('../../db/schema/index.js');
      const nomadSetting = await db.query.settings.findFirst({
        where: eq(settings.key, 'sandbox.nomad'),
      });
      if (nomadSetting?.value) {
        const parsed = JSON.parse(nomadSetting.value);
        const dbAddress = parsed.address as string | undefined;

        // Use DB address if no override provided
        if (!address) {
          address = dbAddress;
        }

        // Use DB namespace as fallback when no override
        if (!overrides?.namespace) {
          namespace = parsed.namespace ?? 'default';
        }

        // Only attach the stored token when the address matches the persisted address.
        // This prevents sending our token to an attacker-controlled server.
        if (!overrides?.address || overrides.address === dbAddress) {
          const encryptedToken = parsed.token as string | undefined;
          if (encryptedToken) {
            try {
              const { decryptToken } = await import('../../lib/crypto/server-encryption.js');
              token = decryptToken(encryptedToken);
            } catch (decryptErr) {
              log.error(
                'Token decryption failed — the Nomad token must be re-entered in Settings. ' +
                  'This usually means the encryption key was rotated or the data is corrupted.',
                {
                  error: decryptErr instanceof Error ? decryptErr : new Error(String(decryptErr)),
                }
              );
              token = undefined;
              tokenDecryptionFailed = true;
            }
          }
        }
      }
    } catch (dbErr) {
      log.error('Failed to load Nomad settings from database', {
        error: dbErr instanceof Error ? dbErr : new Error(String(dbErr)),
      });
      // Don't silently return defaults — let the caller know something is wrong
      throw dbErr;
    }
  }

  return { address, token, namespace, tokenDecryptionFailed: tokenDecryptionFailed || undefined };
}

export function createNomadRoutes(deps?: NomadRouteDeps) {
  const app = new Hono();

  // Lazy-cached import for NomadSandboxClient
  let NomadSandboxClientClass:
    | typeof import('@agentpane/nomad-sandbox-sdk').NomadSandboxClient
    | null = null;
  async function getNomadClient(opts: { address: string; token?: string; namespace?: string }) {
    if (!NomadSandboxClientClass) {
      const sdk = await import('@agentpane/nomad-sandbox-sdk');
      NomadSandboxClientClass = sdk.NomadSandboxClient;
    }
    return new NomadSandboxClientClass(opts);
  }

  // GET /api/sandbox/nomad/status - Nomad cluster health
  app.get('/status', async (c) => {
    try {
      const { address, token, namespace, tokenDecryptionFailed } = await loadNomadSettings(
        deps?.db,
        {
          address: c.req.query('address') ?? undefined,
          namespace: c.req.query('namespace') ?? undefined,
        }
      );

      if (!address) {
        return json({
          ok: true,
          data: { healthy: false, message: 'No Nomad address configured' },
        });
      }

      const client = await getNomadClient({ address, token, namespace });
      const health = await client.healthCheck();

      // Get job count (best effort)
      let jobCount: number | null = 0;
      try {
        const jobs = await client.listJobs();
        jobCount = jobs.length;
      } catch (err) {
        log.warn('Failed to fetch Nomad job count', {
          error: err instanceof Error ? err : new Error(String(err)),
        });
        jobCount = null;
      }

      return json({
        ok: true,
        data: {
          healthy: health.healthy,
          leader: health.leader,
          version: health.version,
          datacenter: health.datacenter,
          namespace,
          namespaceExists: health.namespaceExists,
          jobCount,
          ...(tokenDecryptionFailed && { tokenDecryptionFailed: true }),
        },
      });
    } catch (error) {
      log.error('Nomad status check failed', {
        error: error instanceof Error ? error : new Error(String(error)),
      });
      const message = error instanceof Error ? error.message : 'Failed to connect to Nomad';
      return json({ ok: false, error: { code: 'NOMAD_CONNECTION_ERROR', message } }, 500);
    }
  });

  async function withNomadClient(
    c: { req: { query: (key: string) => string | undefined } },
    action: string,
    fn: (client: Awaited<ReturnType<typeof getNomadClient>>) => Promise<unknown>
  ): Promise<Response> {
    try {
      const { address, token, namespace } = await loadNomadSettings(deps?.db, {
        address: c.req.query('address') ?? undefined,
        namespace: c.req.query('namespace') ?? undefined,
      });

      if (!address) {
        return json(
          {
            ok: false,
            error: { code: 'NOMAD_NOT_CONFIGURED', message: 'No Nomad address configured' },
          },
          400
        );
      }

      const client = await getNomadClient({ address, token, namespace });
      const data = await fn(client);
      return json({ ok: true, data });
    } catch (error) {
      log.error(`Nomad ${action} failed`, {
        error: error instanceof Error ? error : new Error(String(error)),
      });
      const message = error instanceof Error ? error.message : `Failed to ${action}`;
      return json({ ok: false, error: { code: 'NOMAD_API_ERROR', message } }, 500);
    }
  }

  // GET /api/sandbox/nomad/namespaces
  app.get('/namespaces', async (c) => {
    return withNomadClient(c, 'list namespaces', async (client) => ({
      namespaces: await client.listNamespaces(),
    }));
  });

  // GET /api/sandbox/nomad/datacenters
  app.get('/datacenters', async (c) => {
    return withNomadClient(c, 'list datacenters', async (client) => ({
      datacenters: await client.listDatacenters(),
    }));
  });

  // POST /api/sandbox/nomad/validate - Validate connection
  app.post('/validate', async (c) => {
    let body: { address: string; token?: string; namespace?: string };
    try {
      body = await c.req.json();
    } catch {
      return json(
        { ok: false, error: { code: 'INVALID_JSON', message: 'Request body must be valid JSON' } },
        400
      );
    }

    if (!body.address) {
      return json(
        { ok: false, error: { code: 'MISSING_PARAMS', message: 'Nomad address is required' } },
        400
      );
    }

    // Validate address to prevent SSRF
    const addrValidation = await validateNomadAddress(body.address);
    if (!addrValidation.valid) {
      return json(
        {
          ok: false,
          error: {
            code: 'INVALID_ADDRESS',
            message: addrValidation.error,
          },
        },
        400
      );
    }

    try {
      // Note: validate endpoint accepts user-supplied token for initial setup.
      // The SSRF validation in validateNomadAddress prevents targeting internal services.
      const client = await getNomadClient({
        address: body.address,
        token: body.token,
        namespace: body.namespace ?? 'default',
      });
      const health = await client.healthCheck();

      return json({
        ok: true,
        data: {
          healthy: health.healthy,
          leader: health.leader,
          version: health.version,
          datacenter: health.datacenter,
          namespaceExists: health.namespaceExists,
        },
      });
    } catch (error) {
      log.error('Nomad connection validation failed', {
        error: error instanceof Error ? error : new Error(String(error)),
      });
      const message =
        error instanceof Error ? error.message : 'Failed to validate Nomad connection';
      return json({ ok: false, error: { code: 'NOMAD_VALIDATION_ERROR', message } }, 500);
    }
  });

  return app;
}
