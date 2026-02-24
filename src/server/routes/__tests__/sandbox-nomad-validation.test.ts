import { describe, expect, it } from 'vitest';
import { validateNomadAddress } from '../sandbox.js';

describe('validateNomadAddress', () => {
  // ── Allowed addresses ──────────────────────────────────────────────

  it('allows http://127.0.0.1:4646 (localhost for dev)', () => {
    expect(() => validateNomadAddress('http://127.0.0.1:4646')).not.toThrow();
  });

  it('allows http://nomad.example.com:4646 (public hostname)', () => {
    expect(() => validateNomadAddress('http://nomad.example.com:4646')).not.toThrow();
  });

  it('allows http://192.168.1.100:4646 (local network allowed)', () => {
    expect(() => validateNomadAddress('http://192.168.1.100:4646')).not.toThrow();
  });

  it('allows https://nomad.prod.company.io (https with public hostname)', () => {
    expect(() => validateNomadAddress('https://nomad.prod.company.io')).not.toThrow();
  });

  it('blocks localhost hostname', () => {
    expect(() => validateNomadAddress('http://localhost:4646')).toThrow();
  });

  // ── Blocked: cloud metadata (169.254.x.x link-local) ──────────────

  it('blocks http://169.254.169.254 (AWS/GCP cloud metadata)', () => {
    expect(() => validateNomadAddress('http://169.254.169.254')).toThrow('cloud metadata');
  });

  it('blocks http://169.254.1.1 (link-local range)', () => {
    expect(() => validateNomadAddress('http://169.254.1.1')).toThrow('cloud metadata');
  });

  it('blocks http://169.254.169.254/latest/meta-data/ (metadata path)', () => {
    expect(() => validateNomadAddress('http://169.254.169.254/latest/meta-data/')).toThrow(
      'cloud metadata'
    );
  });

  it('blocks http://metadata.google.internal (GCP metadata hostname)', () => {
    expect(() => validateNomadAddress('http://metadata.google.internal')).toThrow('cloud metadata');
  });

  // ── Blocked: 0.0.0.0 ──────────────────────────────────────────────

  it('blocks http://0.0.0.0:4646', () => {
    expect(() => validateNomadAddress('http://0.0.0.0:4646')).toThrow('0.0.0.0');
  });

  // ── Blocked: IPv6 loopback ─────────────────────────────────────────

  it('blocks http://[::1]:4646 (IPv6 loopback)', () => {
    expect(() => validateNomadAddress('http://[::1]:4646')).toThrow('IPv6 loopback');
  });

  // ── Blocked: IPv6 link-local ───────────────────────────────────────

  it('blocks URLs with fe80: (IPv6 link-local)', () => {
    expect(() => validateNomadAddress('http://[fe80::1]:4646')).toThrow('IPv6 link-local');
  });

  // ── Blocked: RFC 1918 - 10.x.x.x ──────────────────────────────────

  it('blocks http://10.0.0.1:4646 (RFC 1918 - 10.x)', () => {
    expect(() => validateNomadAddress('http://10.0.0.1:4646')).toThrow('internal network');
  });

  it('blocks http://10.255.255.1:4646 (RFC 1918 - 10.x upper range)', () => {
    expect(() => validateNomadAddress('http://10.255.255.1:4646')).toThrow('internal network');
  });

  // ── Blocked: RFC 1918 - 172.16-31.x ───────────────────────────────

  it('blocks http://172.16.0.1:4646 (RFC 1918 - 172.16.x)', () => {
    expect(() => validateNomadAddress('http://172.16.0.1:4646')).toThrow('internal network');
  });

  it('blocks http://172.31.255.1:4646 (RFC 1918 - 172.31.x)', () => {
    expect(() => validateNomadAddress('http://172.31.255.1:4646')).toThrow('internal network');
  });

  it('does not block http://172.15.0.1:4646 (outside 172.16-31 range)', () => {
    expect(() => validateNomadAddress('http://172.15.0.1:4646')).not.toThrow();
  });

  it('does not block http://172.32.0.1:4646 (outside 172.16-31 range)', () => {
    expect(() => validateNomadAddress('http://172.32.0.1:4646')).not.toThrow();
  });

  // ── Blocked: IPv6-mapped metadata ─────────────────────────────────

  it('blocks http://[::ffff:169.254.169.254] (IPv6-mapped metadata)', () => {
    expect(() => validateNomadAddress('http://[::ffff:169.254.169.254]:4646')).toThrow();
  });

  // ── Blocked: invalid URLs ──────────────────────────────────────────

  it('rejects invalid URL format', () => {
    expect(() => validateNomadAddress('not-a-url')).toThrow('Invalid Nomad address URL format');
  });

  it('rejects empty string', () => {
    expect(() => validateNomadAddress('')).toThrow('Invalid Nomad address URL format');
  });

  it('rejects non-http/https protocols (ftp)', () => {
    expect(() => validateNomadAddress('ftp://nomad.example.com:4646')).toThrow(
      'http or https protocol'
    );
  });

  it('rejects non-http/https protocols (file)', () => {
    expect(() => validateNomadAddress('file:///etc/passwd')).toThrow('http or https protocol');
  });
});
