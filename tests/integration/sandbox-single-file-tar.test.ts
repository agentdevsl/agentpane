/**
 * Integration tests for `single-file-tar.ts`.
 *
 * Pure-function builder used by sandbox writeFile() impls (Docker/K8s/Nomad)
 * to upload credentials and skill files via tar streams. Validates the USTAR
 * format encoding so a regression here doesn't silently corrupt every file
 * uploaded into a sandbox container.
 *
 * IT-IDs: IT-1700 to IT-1709
 */
import { describe, expect, it } from 'vitest';
import {
  buildSingleFileTar,
  splitContainerPath,
} from '../../src/lib/sandbox/providers/single-file-tar';

describe('buildSingleFileTar', () => {
  it('IT-1700: emits header + content + padding + 1024-byte trailer', () => {
    const content = Buffer.from('hello');
    const tar = buildSingleFileTar('foo.txt', content, 0o644);
    // 512 header + 512 padded data block + 1024 trailer = 2048
    expect(tar.length).toBe(2048);
    expect(tar.subarray(1024, 2048).every((b) => b === 0)).toBe(true);
  });

  it('IT-1701: writes the file name in the header (offset 0, 100 bytes)', () => {
    const tar = buildSingleFileTar('file.json', Buffer.from('{}'), 0o600);
    const name = tar.toString('utf8', 0, 9); // length of "file.json"
    expect(name).toBe('file.json');
  });

  it('IT-1702: writes mode/uid/gid/size as zero-padded octal', () => {
    const content = Buffer.from('x'.repeat(255));
    const tar = buildSingleFileTar('f', content, 0o755, 1234, 5678);
    // mode at 100 — "0000755\0"
    expect(tar.toString('ascii', 100, 107)).toBe('0000755');
    // uid at 108 — 1234 → "0002322"
    expect(tar.toString('ascii', 108, 115)).toBe((1234).toString(8).padStart(7, '0'));
    // gid at 116
    expect(tar.toString('ascii', 116, 123)).toBe((5678).toString(8).padStart(7, '0'));
    // size at 124 — 255 → "00000000377"
    expect(tar.toString('ascii', 124, 135)).toBe((255).toString(8).padStart(11, '0'));
  });

  it('IT-1703: defaults uid/gid to 1000 (the node user in the agent-sandbox image)', () => {
    const tar = buildSingleFileTar('f', Buffer.from('x'), 0o600);
    expect(tar.toString('ascii', 108, 115)).toBe('0001750');
    expect(tar.toString('ascii', 116, 123)).toBe('0001750');
  });

  it('IT-1704: writes ustar magic at offset 257', () => {
    const tar = buildSingleFileTar('f', Buffer.from('x'), 0o600);
    expect(tar.toString('ascii', 257, 263)).toBe('ustar\0');
    expect(tar.toString('ascii', 263, 265)).toBe('00');
  });

  it('IT-1705: produces a valid checksum (sum of header bytes)', () => {
    const tar = buildSingleFileTar('f', Buffer.from('x'), 0o600);
    // Recompute checksum: replace checksum field with 8 spaces, sum bytes
    const header = Buffer.from(tar.subarray(0, 512));
    // Spaces at 148..156
    for (let i = 148; i < 156; i++) header[i] = 0x20;
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += header[i] ?? 0;
    // Read the embedded checksum field — null-terminated octal, padded with space
    const checksumField = tar.toString('ascii', 148, 154); // 6 octal chars
    expect(parseInt(checksumField, 8)).toBe(sum);
  });

  it('IT-1706: pads small content to exactly 512-byte data block', () => {
    const tar = buildSingleFileTar('f', Buffer.from('hi'), 0o644);
    // Header(512) + Data(512) + Trailer(1024) = 2048
    expect(tar.length).toBe(2048);
  });

  it('IT-1707: pads multi-block content to next 512-byte boundary', () => {
    const content = Buffer.alloc(800, 0x41); // 800 'A' bytes spans two 512-byte blocks
    const tar = buildSingleFileTar('f', content, 0o644);
    // Header(512) + 2 data blocks (1024) + Trailer(1024) = 2560
    expect(tar.length).toBe(2560);
  });

  it('IT-1708: rejects names exceeding 100-byte USTAR short-name limit', () => {
    const longName = 'a'.repeat(101);
    expect(() => buildSingleFileTar(longName, Buffer.from('x'), 0o600)).toThrow(/too long/);
  });

  it('IT-1709: writes typeflag "0" for regular files at offset 156', () => {
    const tar = buildSingleFileTar('f', Buffer.from('x'), 0o600);
    expect(tar.toString('ascii', 156, 157)).toBe('0');
  });
});

describe('splitContainerPath', () => {
  it('IT-1710: splits absolute path into dir + name', () => {
    expect(splitContainerPath('/workspace/foo/bar.txt')).toEqual({
      dir: '/workspace/foo',
      name: 'bar.txt',
    });
  });

  it('IT-1711: handles root-level files', () => {
    expect(splitContainerPath('/file.txt')).toEqual({ dir: '', name: 'file.txt' });
  });

  it('IT-1712: returns "." dir and bare name when no slash', () => {
    expect(splitContainerPath('bare-name.txt')).toEqual({ dir: '.', name: 'bare-name.txt' });
  });

  it('IT-1713: handles deeply nested paths', () => {
    expect(splitContainerPath('/a/b/c/d/e/file')).toEqual({
      dir: '/a/b/c/d/e',
      name: 'file',
    });
  });
});
