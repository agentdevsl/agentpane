import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '@/lib/agents/types';

// =============================================================================
// Test Context
// =============================================================================

const defaultContext: ToolContext = { cwd: '/test/workspace' };

// =============================================================================
// Mock Setup
// search-tools now uses `promisify(execFile)` so the user-supplied pattern
// and glob are passed as literal argv entries (no shell interpolation).
// We mock the promisified execFile by intercepting `node:util.promisify`.
// =============================================================================

const mockExecFileAsync = vi.fn();
const mockFsAccess = vi.fn();

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  default: {
    execFile: vi.fn(),
  },
}));

vi.mock('node:util', () => ({
  promisify: vi.fn(() => mockExecFileAsync),
  default: {
    promisify: vi.fn(() => mockExecFileAsync),
  },
}));

vi.mock('node:fs/promises', () => ({
  default: {
    access: (...args: unknown[]) => mockFsAccess(...args),
  },
  access: (...args: unknown[]) => mockFsAccess(...args),
}));

// =============================================================================
// Glob Tool Tests
// =============================================================================

describe('Glob Tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns matching files for a glob pattern', async () => {
    mockExecFileAsync.mockResolvedValue({
      stdout: './src/index.ts\n./src/utils.ts\n./src/types.ts',
      stderr: '',
    });

    const { globTool } = await import('@/lib/agents/tools/search-tools');
    const result = await globTool({ pattern: '*.ts' }, defaultContext);

    expect(result.is_error).toBeUndefined();
    expect(result.content[0].text).toBe('./src/index.ts\n./src/utils.ts\n./src/types.ts');
  });

  it('uses provided cwd over context cwd', async () => {
    mockExecFileAsync.mockResolvedValue({
      stdout: './file.ts',
      stderr: '',
    });

    const { globTool } = await import('@/lib/agents/tools/search-tools');
    await globTool({ pattern: '*.ts', cwd: '/custom/path' }, defaultContext);

    expect(mockExecFileAsync).toHaveBeenCalledWith(
      'find',
      expect.any(Array),
      expect.objectContaining({ cwd: '/custom/path' })
    );
  });

  it('uses context cwd when cwd not provided', async () => {
    mockExecFileAsync.mockResolvedValue({
      stdout: './file.ts',
      stderr: '',
    });

    const { globTool } = await import('@/lib/agents/tools/search-tools');
    await globTool({ pattern: '*.ts' }, defaultContext);

    expect(mockExecFileAsync).toHaveBeenCalledWith(
      'find',
      expect.any(Array),
      expect.objectContaining({ cwd: '/test/workspace' })
    );
  });

  it('respects the limit parameter', async () => {
    const lines = Array.from({ length: 60 }, (_, i) => `./file${i}.ts`).join('\n');
    mockExecFileAsync.mockResolvedValue({ stdout: lines, stderr: '' });

    const { globTool } = await import('@/lib/agents/tools/search-tools');
    const result = await globTool({ pattern: '*.ts', limit: 25 }, defaultContext);

    const files = result.content[0].text?.split('\n') ?? [];
    expect(files).toHaveLength(25);
  });

  it('uses default limit of 100 when not specified', async () => {
    const lines = Array.from({ length: 150 }, (_, i) => `./file${i}.ts`).join('\n');
    mockExecFileAsync.mockResolvedValue({ stdout: lines, stderr: '' });

    const { globTool } = await import('@/lib/agents/tools/search-tools');
    const result = await globTool({ pattern: '*.ts' }, defaultContext);

    const files = result.content[0].text?.split('\n') ?? [];
    expect(files).toHaveLength(100);
  });

  it('returns "(no matches)" for empty results', async () => {
    mockExecFileAsync.mockResolvedValue({
      stdout: '',
      stderr: '',
    });

    const { globTool } = await import('@/lib/agents/tools/search-tools');
    const result = await globTool({ pattern: '*.nonexistent' }, defaultContext);

    expect(result.is_error).toBeUndefined();
    expect(result.content[0].text).toBe('(no matches)');
  });

  it('filters out empty lines from results', async () => {
    mockExecFileAsync.mockResolvedValue({
      stdout: './file1.ts\n\n./file2.ts\n\n',
      stderr: '',
    });

    const { globTool } = await import('@/lib/agents/tools/search-tools');
    const result = await globTool({ pattern: '*.ts' }, defaultContext);

    expect(result.content[0].text).toBe('./file1.ts\n./file2.ts');
  });

  it('handles exec error gracefully', async () => {
    mockExecFileAsync.mockRejectedValue(new Error('Command failed: find permission denied'));

    const { globTool } = await import('@/lib/agents/tools/search-tools');
    const result = await globTool({ pattern: '*.ts' }, defaultContext);

    expect(result.is_error).toBe(true);
    expect(result.content[0].text).toContain('Glob failed');
    expect(result.content[0].text).toContain('Command failed');
  });

  it('handles non-Error thrown values', async () => {
    mockExecFileAsync.mockRejectedValue('string error');

    const { globTool } = await import('@/lib/agents/tools/search-tools');
    const result = await globTool({ pattern: '*.ts' }, defaultContext);

    expect(result.is_error).toBe(true);
    expect(result.content[0].text).toContain('Glob failed');
    expect(result.content[0].text).toContain('string error');
  });

  it('passes pattern as a literal argv entry to find', async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });

    const { globTool } = await import('@/lib/agents/tools/search-tools');
    await globTool({ pattern: '*.ts' }, defaultContext);

    expect(mockExecFileAsync).toHaveBeenCalledWith(
      'find',
      ['.', '-type', 'f', '-name', '*.ts'],
      expect.any(Object)
    );
  });
});

// =============================================================================
// Grep Tool Tests
// =============================================================================

describe('Grep Tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns matching content for a search pattern', async () => {
    mockFsAccess.mockResolvedValue(undefined);
    mockExecFileAsync.mockResolvedValue({
      stdout: 'src/index.ts:5:const foo = "bar";',
      stderr: '',
    });

    const { grepTool } = await import('@/lib/agents/tools/search-tools');
    const result = await grepTool({ pattern: 'foo', path: '/test/workspace' }, defaultContext);

    expect(result.is_error).toBeUndefined();
    expect(result.content[0].text).toBe('src/index.ts:5:const foo = "bar";');
  });

  it('uses absolute path when provided', async () => {
    mockFsAccess.mockResolvedValue(undefined);
    mockExecFileAsync.mockResolvedValue({ stdout: 'match', stderr: '' });

    const { grepTool } = await import('@/lib/agents/tools/search-tools');
    await grepTool({ pattern: 'test', path: '/absolute/path' }, defaultContext);

    expect(mockExecFileAsync).toHaveBeenCalledWith(
      'rg',
      expect.arrayContaining(['/absolute/path']),
      expect.any(Object)
    );
  });

  it('joins relative path with context cwd', async () => {
    mockFsAccess.mockResolvedValue(undefined);
    mockExecFileAsync.mockResolvedValue({ stdout: 'match', stderr: '' });

    const { grepTool } = await import('@/lib/agents/tools/search-tools');
    await grepTool({ pattern: 'test', path: 'relative/path' }, defaultContext);

    expect(mockExecFileAsync).toHaveBeenCalledWith(
      'rg',
      expect.arrayContaining(['/test/workspace/relative/path']),
      expect.any(Object)
    );
  });

  it('respects max_results parameter', async () => {
    mockFsAccess.mockResolvedValue(undefined);
    mockExecFileAsync.mockResolvedValue({ stdout: 'match', stderr: '' });

    const { grepTool } = await import('@/lib/agents/tools/search-tools');
    await grepTool({ pattern: 'test', path: '/test', max_results: 25 }, defaultContext);

    const argv = mockExecFileAsync.mock.calls[0][1] as string[];
    const idx = argv.indexOf('--max-count');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(argv[idx + 1]).toBe('25');
  });

  it('uses default max_results of 50 when not specified', async () => {
    mockFsAccess.mockResolvedValue(undefined);
    mockExecFileAsync.mockResolvedValue({ stdout: 'match', stderr: '' });

    const { grepTool } = await import('@/lib/agents/tools/search-tools');
    await grepTool({ pattern: 'test', path: '/test' }, defaultContext);

    const argv = mockExecFileAsync.mock.calls[0][1] as string[];
    const idx = argv.indexOf('--max-count');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(argv[idx + 1]).toBe('50');
  });

  it('includes glob filter when provided', async () => {
    mockFsAccess.mockResolvedValue(undefined);
    mockExecFileAsync.mockResolvedValue({ stdout: 'match', stderr: '' });

    const { grepTool } = await import('@/lib/agents/tools/search-tools');
    await grepTool({ pattern: 'test', path: '/test', glob: '*.ts' }, defaultContext);

    const argv = mockExecFileAsync.mock.calls[0][1] as string[];
    const idx = argv.indexOf('--glob');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(argv[idx + 1]).toBe('*.ts');
  });

  it('omits glob filter when not provided', async () => {
    mockFsAccess.mockResolvedValue(undefined);
    mockExecFileAsync.mockResolvedValue({ stdout: 'match', stderr: '' });

    const { grepTool } = await import('@/lib/agents/tools/search-tools');
    await grepTool({ pattern: 'test', path: '/test' }, defaultContext);

    const argv = mockExecFileAsync.mock.calls[0][1] as string[];
    expect(argv).not.toContain('--glob');
  });

  it('returns "(no matches)" when stdout is empty', async () => {
    mockFsAccess.mockResolvedValue(undefined);
    mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });

    const { grepTool } = await import('@/lib/agents/tools/search-tools');
    const result = await grepTool({ pattern: 'nonexistent', path: '/test' }, defaultContext);

    expect(result.is_error).toBeUndefined();
    expect(result.content[0].text).toBe('(no matches)');
  });

  it('returns "(no matches)" when ripgrep exits with code 1 (no matches)', async () => {
    mockFsAccess.mockResolvedValue(undefined);
    const error = Object.assign(new Error('Command failed'), { code: 1, stdout: '' });
    mockExecFileAsync.mockRejectedValue(error);

    const { grepTool } = await import('@/lib/agents/tools/search-tools');
    const result = await grepTool({ pattern: 'nonexistent', path: '/test' }, defaultContext);

    expect(result.is_error).toBeUndefined();
    expect(result.content[0].text).toBe('(no matches)');
  });

  it('returns error when path does not exist', async () => {
    mockFsAccess.mockRejectedValue(new Error('ENOENT: no such file or directory'));

    const { grepTool } = await import('@/lib/agents/tools/search-tools');
    const result = await grepTool({ pattern: 'test', path: '/nonexistent/path' }, defaultContext);

    expect(result.is_error).toBe(true);
    expect(result.content[0].text).toContain('Grep failed');
    expect(result.content[0].text).toContain('ENOENT');
  });

  it('handles ripgrep execution error (code > 1)', async () => {
    mockFsAccess.mockResolvedValue(undefined);
    const error = Object.assign(new Error('ripgrep error: invalid regex'), { code: 2 });
    mockExecFileAsync.mockRejectedValue(error);

    const { grepTool } = await import('@/lib/agents/tools/search-tools');
    const result = await grepTool({ pattern: '[invalid', path: '/test' }, defaultContext);

    expect(result.is_error).toBe(true);
    expect(result.content[0].text).toContain('Grep failed');
  });

  it('handles non-Error thrown values', async () => {
    mockFsAccess.mockRejectedValue('string error');

    const { grepTool } = await import('@/lib/agents/tools/search-tools');
    const result = await grepTool({ pattern: 'test', path: '/test' }, defaultContext);

    expect(result.is_error).toBe(true);
    expect(result.content[0].text).toContain('Grep failed');
    expect(result.content[0].text).toContain('string error');
  });

  it('uses correct timeout for exec', async () => {
    mockFsAccess.mockResolvedValue(undefined);
    mockExecFileAsync.mockResolvedValue({ stdout: 'match', stderr: '' });

    const { grepTool } = await import('@/lib/agents/tools/search-tools');
    await grepTool({ pattern: 'test', path: '/test' }, defaultContext);

    expect(mockExecFileAsync).toHaveBeenCalledWith(
      'rg',
      expect.any(Array),
      expect.objectContaining({ timeout: 60000 })
    );
  });

  it('passes pattern after a `--` separator so it cannot be reinterpreted as a flag', async () => {
    mockFsAccess.mockResolvedValue(undefined);
    mockExecFileAsync.mockResolvedValue({ stdout: 'match', stderr: '' });

    const { grepTool } = await import('@/lib/agents/tools/search-tools');
    await grepTool({ pattern: '-x', path: '/test' }, defaultContext);

    const argv = mockExecFileAsync.mock.calls[0][1] as string[];
    const sepIdx = argv.indexOf('--');
    expect(sepIdx).toBeGreaterThanOrEqual(0);
    expect(argv[sepIdx + 1]).toBe('-x');
  });
});

// =============================================================================
// Edge Cases and Special Characters
// =============================================================================

describe('Search Tools - Edge Cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('glob handles patterns with special characters', async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: './file.test.ts', stderr: '' });

    const { globTool } = await import('@/lib/agents/tools/search-tools');
    const result = await globTool({ pattern: '*.test.ts' }, defaultContext);

    expect(result.is_error).toBeUndefined();
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      'find',
      expect.arrayContaining(['*.test.ts']),
      expect.any(Object)
    );
  });

  it('grep handles regex patterns', async () => {
    mockFsAccess.mockResolvedValue(undefined);
    mockExecFileAsync.mockResolvedValue({ stdout: 'match', stderr: '' });

    const { grepTool } = await import('@/lib/agents/tools/search-tools');
    const result = await grepTool({ pattern: 'function\\s+\\w+', path: '/test' }, defaultContext);

    expect(result.is_error).toBeUndefined();
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      'rg',
      expect.arrayContaining(['function\\s+\\w+']),
      expect.any(Object)
    );
  });

  it('glob handles large result sets correctly', async () => {
    const manyFiles = Array.from({ length: 100 }, (_, i) => `./file${i}.ts`).join('\n');
    mockExecFileAsync.mockResolvedValue({ stdout: manyFiles, stderr: '' });

    const { globTool } = await import('@/lib/agents/tools/search-tools');
    const result = await globTool({ pattern: '*.ts' }, defaultContext);

    const files = result.content[0].text?.split('\n') ?? [];
    expect(files.length).toBe(100);
  });

  it('grep handles multiline output', async () => {
    mockFsAccess.mockResolvedValue(undefined);
    const multilineOutput = 'file1.ts:1:line one\nfile1.ts:5:line two\nfile2.ts:10:another match';
    mockExecFileAsync.mockResolvedValue({ stdout: multilineOutput, stderr: '' });

    const { grepTool } = await import('@/lib/agents/tools/search-tools');
    const result = await grepTool({ pattern: 'test', path: '/test' }, defaultContext);

    expect(result.content[0].text).toBe(multilineOutput);
  });

  it('glob handles whitespace-only stdout', async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: '   \n\n   \n', stderr: '' });

    const { globTool } = await import('@/lib/agents/tools/search-tools');
    const result = await globTool({ pattern: '*.ts' }, defaultContext);

    expect(result.content[0].text).toBe('(no matches)');
  });
});

// =============================================================================
// Response Structure Tests
// =============================================================================

describe('Search Tools - Response Structure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('glob success response has correct ToolResponse structure', async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: './file.ts', stderr: '' });

    const { globTool } = await import('@/lib/agents/tools/search-tools');
    const result = await globTool({ pattern: '*.ts' }, defaultContext);

    expect(result).toHaveProperty('content');
    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.content[0]).toHaveProperty('type', 'text');
    expect(result.content[0]).toHaveProperty('text');
    expect(result.is_error).toBeUndefined();
  });

  it('glob error response has correct ToolResponse structure', async () => {
    mockExecFileAsync.mockRejectedValue(new Error('Command failed'));

    const { globTool } = await import('@/lib/agents/tools/search-tools');
    const result = await globTool({ pattern: '*.ts' }, defaultContext);

    expect(result).toHaveProperty('content');
    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content[0]).toHaveProperty('type', 'text');
    expect(result.content[0]).toHaveProperty('text');
    expect(result.is_error).toBe(true);
  });

  it('grep success response has correct ToolResponse structure', async () => {
    mockFsAccess.mockResolvedValue(undefined);
    mockExecFileAsync.mockResolvedValue({ stdout: 'match', stderr: '' });

    const { grepTool } = await import('@/lib/agents/tools/search-tools');
    const result = await grepTool({ pattern: 'test', path: '/test' }, defaultContext);

    expect(result).toHaveProperty('content');
    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.content[0]).toHaveProperty('type', 'text');
    expect(result.content[0]).toHaveProperty('text');
    expect(result.is_error).toBeUndefined();
  });

  it('grep error response has correct ToolResponse structure', async () => {
    mockFsAccess.mockRejectedValue(new Error('Path not found'));

    const { grepTool } = await import('@/lib/agents/tools/search-tools');
    const result = await grepTool({ pattern: 'test', path: '/nonexistent' }, defaultContext);

    expect(result).toHaveProperty('content');
    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content[0]).toHaveProperty('type', 'text');
    expect(result.content[0]).toHaveProperty('text');
    expect(result.is_error).toBe(true);
  });
});
