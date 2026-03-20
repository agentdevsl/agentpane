import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '@/lib/agents/types';

// =============================================================================
// Test Context
// =============================================================================

const defaultContext: ToolContext = { cwd: '/test/workspace' };

// =============================================================================
// Bash Tool Tests - isDangerousCommand (~8 tests)
// These tests don't require mocking since isDangerousCommand is a pure function
// The actual dangerous patterns are:
// - /rm\s+-rf/
// - /git\s+push\s+--force/
// - /git\s+reset\s+--hard/
// - /DROP\s+TABLE/i
// - /DELETE\s+FROM/i
// - /TRUNCATE\s+TABLE/i
// - /chmod\s+-R\s+777/
// - /mkfs\./
// - /dd\s+if=/
// =============================================================================

describe('Bash Tool - isDangerousCommand', () => {
  it('detects rm -rf as dangerous', async () => {
    const { isDangerousCommand } = await import('@/lib/agents/tools/bash-tool');
    expect(isDangerousCommand('rm -rf /')).toBe(true);
    expect(isDangerousCommand('rm -rf /home/user')).toBe(true);
    expect(isDangerousCommand('sudo rm -rf /tmp')).toBe(true);
  });

  it('detects git push --force as dangerous', async () => {
    const { isDangerousCommand } = await import('@/lib/agents/tools/bash-tool');
    expect(isDangerousCommand('git push --force')).toBe(true);
    expect(isDangerousCommand('git push --force origin main')).toBe(true);
    // Note: Pattern /git\s+push\s+--force/ requires --force immediately after push
    // So 'git push origin main --force' won't match the current pattern
    expect(isDangerousCommand('git push origin main --force')).toBe(false);
  });

  it('detects git reset --hard as dangerous', async () => {
    const { isDangerousCommand } = await import('@/lib/agents/tools/bash-tool');
    expect(isDangerousCommand('git reset --hard')).toBe(true);
    expect(isDangerousCommand('git reset --hard HEAD~5')).toBe(true);
  });

  it('detects SQL destructive commands as dangerous', async () => {
    const { isDangerousCommand } = await import('@/lib/agents/tools/bash-tool');
    expect(isDangerousCommand('DROP TABLE users')).toBe(true);
    expect(isDangerousCommand('drop table users')).toBe(true);
    expect(isDangerousCommand('DELETE FROM users')).toBe(true);
    expect(isDangerousCommand('delete from users WHERE id = 1')).toBe(true);
    expect(isDangerousCommand('TRUNCATE TABLE logs')).toBe(true);
  });

  it('detects chmod -R 777 as dangerous', async () => {
    const { isDangerousCommand } = await import('@/lib/agents/tools/bash-tool');
    expect(isDangerousCommand('chmod -R 777 /var')).toBe(true);
    // Note: chmod 777 without -R is not in the pattern
    expect(isDangerousCommand('chmod 777 file.txt')).toBe(false);
  });

  it('detects disk operations as dangerous', async () => {
    const { isDangerousCommand } = await import('@/lib/agents/tools/bash-tool');
    expect(isDangerousCommand('mkfs.ext4 /dev/sda1')).toBe(true);
    expect(isDangerousCommand('mkfs.xfs /dev/sdb')).toBe(true);
    expect(isDangerousCommand('dd if=/dev/zero of=/dev/sda')).toBe(true);
    expect(isDangerousCommand('dd if=/dev/urandom of=/dev/sdb')).toBe(true);
  });

  it('allows safe commands', async () => {
    const { isDangerousCommand } = await import('@/lib/agents/tools/bash-tool');
    expect(isDangerousCommand('ls -la')).toBe(false);
    expect(isDangerousCommand('git status')).toBe(false);
    expect(isDangerousCommand('npm install')).toBe(false);
    expect(isDangerousCommand('cat file.txt')).toBe(false);
    expect(isDangerousCommand('grep pattern file.txt')).toBe(false);
    expect(isDangerousCommand('echo "Hello World"')).toBe(false);
    expect(isDangerousCommand('mkdir -p /tmp/test')).toBe(false);
    expect(isDangerousCommand('git push')).toBe(false); // No --force
    expect(isDangerousCommand('git reset')).toBe(false); // No --hard
    expect(isDangerousCommand('chmod 644 file.txt')).toBe(false);
  });

  it('detects commands with pipes and subshells', async () => {
    const { isDangerousCommand } = await import('@/lib/agents/tools/bash-tool');
    expect(isDangerousCommand('echo "y" | rm -rf /home')).toBe(true);
    expect(isDangerousCommand('$(rm -rf /home)')).toBe(true);
    expect(isDangerousCommand('cd /home && rm -rf *')).toBe(true);
  });
});

// =============================================================================
// Browser Stubs Tests (~8 tests)
// These test that browser stubs throw appropriate errors
// =============================================================================

describe('Browser Stubs', () => {
  const stubContext: ToolContext = { cwd: '/browser' };
  const SERVER_ONLY_ERROR = 'This function is server-only and cannot be called in the browser';

  it('bashTool throws server-only error', async () => {
    const { bashTool } = await import('@/lib/agents/tools/browser-stubs');
    await expect(bashTool({ command: 'ls' }, stubContext)).rejects.toThrow(SERVER_ONLY_ERROR);
  });

  it('readFile throws server-only error', async () => {
    const { readFile } = await import('@/lib/agents/tools/browser-stubs');
    await expect(readFile({ path: '/test/file.txt' }, stubContext)).rejects.toThrow(
      SERVER_ONLY_ERROR
    );
  });

  it('writeFile throws server-only error', async () => {
    const { writeFile } = await import('@/lib/agents/tools/browser-stubs');
    await expect(
      writeFile({ path: '/test/file.txt', content: 'test' }, stubContext)
    ).rejects.toThrow(SERVER_ONLY_ERROR);
  });

  it('editFile throws server-only error', async () => {
    const { editFile } = await import('@/lib/agents/tools/browser-stubs');
    await expect(
      editFile({ path: '/test/file.txt', oldContent: 'old', newContent: 'new' }, stubContext)
    ).rejects.toThrow(SERVER_ONLY_ERROR);
  });

  it('globTool throws server-only error', async () => {
    const { globTool } = await import('@/lib/agents/tools/browser-stubs');
    await expect(globTool({ pattern: '*.ts' }, stubContext)).rejects.toThrow(SERVER_ONLY_ERROR);
  });

  it('grepTool throws server-only error', async () => {
    const { grepTool } = await import('@/lib/agents/tools/browser-stubs');
    await expect(grepTool({ pattern: 'test', path: '/test' }, stubContext)).rejects.toThrow(
      SERVER_ONLY_ERROR
    );
  });

  it('all stub functions are exported correctly', async () => {
    const stubs = await import('@/lib/agents/tools/browser-stubs');
    expect(typeof stubs.bashTool).toBe('function');
    expect(typeof stubs.readFile).toBe('function');
    expect(typeof stubs.writeFile).toBe('function');
    expect(typeof stubs.editFile).toBe('function');
    expect(typeof stubs.globTool).toBe('function');
    expect(typeof stubs.grepTool).toBe('function');
  });

  it('stubs accept correct argument types', async () => {
    const { bashTool, readFile, writeFile, editFile, globTool, grepTool } = await import(
      '@/lib/agents/tools/browser-stubs'
    );

    // These should fail with server-only error, not type error
    const bashArgs = { command: 'ls', cwd: '/test', timeout: 1000 };
    const readArgs = { path: '/test/file.txt', encoding: 'utf-8' };
    const writeArgs = { path: '/test/file.txt', content: 'content' };
    const editArgs = { path: '/test/file.txt', oldContent: 'old', newContent: 'new' };
    const globArgs = { pattern: '*.ts', cwd: '/test' };
    const grepArgs = { pattern: 'test', path: '/test', flags: '-i' };

    await expect(bashTool(bashArgs, stubContext)).rejects.toThrow(SERVER_ONLY_ERROR);
    await expect(readFile(readArgs, stubContext)).rejects.toThrow(SERVER_ONLY_ERROR);
    await expect(writeFile(writeArgs, stubContext)).rejects.toThrow(SERVER_ONLY_ERROR);
    await expect(editFile(editArgs, stubContext)).rejects.toThrow(SERVER_ONLY_ERROR);
    await expect(globTool(globArgs, stubContext)).rejects.toThrow(SERVER_ONLY_ERROR);
    await expect(grepTool(grepArgs, stubContext)).rejects.toThrow(SERVER_ONLY_ERROR);
  });
});

// =============================================================================
// File Tools Tests with Mocking (~14 tests)
// =============================================================================

describe('File Tools', () => {
  const mockReadFile = vi.fn();
  const mockWriteFile = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();

    // Mock the fs module before importing file-tools
    vi.doMock('node:fs/promises', () => ({
      default: {
        readFile: mockReadFile,
        writeFile: mockWriteFile,
      },
      readFile: mockReadFile,
      writeFile: mockWriteFile,
    }));
  });

  afterEach(() => {
    vi.doUnmock('node:fs/promises');
  });

  describe('readFile', () => {
    it('reads file content with default utf-8 encoding', async () => {
      mockReadFile.mockResolvedValue('file content here');

      const { readFile } = await import('@/lib/agents/tools/file-tools');
      const result = await readFile({ file_path: '/test/file.txt' }, defaultContext);

      expect(result.is_error).toBeUndefined();
      expect(result.content[0].text).toBe('file content here');
      expect(mockReadFile).toHaveBeenCalledWith('/test/file.txt', { encoding: 'utf-8' });
    });

    it('reads file content with base64 encoding', async () => {
      const base64Content = 'SGVsbG8gV29ybGQ=';
      mockReadFile.mockResolvedValue(base64Content);

      const { readFile } = await import('@/lib/agents/tools/file-tools');
      const result = await readFile(
        { file_path: '/test/image.png', encoding: 'base64' },
        defaultContext
      );

      expect(result.content[0].text).toBe(base64Content);
      expect(mockReadFile).toHaveBeenCalledWith('/test/image.png', { encoding: 'base64' });
    });

    it('handles file not found error', async () => {
      mockReadFile.mockRejectedValue(new Error('ENOENT: no such file or directory'));

      const { readFile } = await import('@/lib/agents/tools/file-tools');
      const result = await readFile({ file_path: '/nonexistent/file.txt' }, defaultContext);

      expect(result.is_error).toBe(true);
      expect(result.content[0].text).toContain('Failed to read file');
      expect(result.content[0].text).toContain('ENOENT');
    });

    it('blocks access to system directory /root (AE-011)', async () => {
      const { readFile } = await import('@/lib/agents/tools/file-tools');
      const result = await readFile({ file_path: '/root/secret.txt' }, defaultContext);

      expect(result.is_error).toBe(true);
      expect(result.content[0].text).toContain('Access denied');
      expect(result.content[0].text).toContain('/root');
    });

    it('handles non-Error thrown values', async () => {
      mockReadFile.mockRejectedValue('string error');

      const { readFile } = await import('@/lib/agents/tools/file-tools');
      const result = await readFile({ file_path: '/test/file.txt' }, defaultContext);

      expect(result.is_error).toBe(true);
      expect(result.content[0].text).toContain('string error');
    });
  });

  describe('editFile', () => {
    it('replaces first occurrence of text', async () => {
      mockReadFile.mockResolvedValue('hello world hello');
      mockWriteFile.mockResolvedValue(undefined);

      const { editFile } = await import('@/lib/agents/tools/file-tools');
      const result = await editFile(
        {
          file_path: '/test/file.txt',
          old_string: 'hello',
          new_string: 'goodbye',
        },
        defaultContext
      );

      expect(result.is_error).toBeUndefined();
      expect(result.content[0].text).toContain('Successfully edited');
      expect(mockWriteFile).toHaveBeenCalledWith('/test/file.txt', 'goodbye world hello', 'utf-8');
    });

    it('replaces all occurrences when replace_all is true', async () => {
      mockReadFile.mockResolvedValue('hello world hello');
      mockWriteFile.mockResolvedValue(undefined);

      const { editFile } = await import('@/lib/agents/tools/file-tools');
      const result = await editFile(
        {
          file_path: '/test/file.txt',
          old_string: 'hello',
          new_string: 'goodbye',
          replace_all: true,
        },
        defaultContext
      );

      expect(result.is_error).toBeUndefined();
      expect(mockWriteFile).toHaveBeenCalledWith(
        '/test/file.txt',
        'goodbye world goodbye',
        'utf-8'
      );
    });

    it('returns error when old_string not found', async () => {
      mockReadFile.mockResolvedValue('some content');

      const { editFile } = await import('@/lib/agents/tools/file-tools');
      const result = await editFile(
        {
          file_path: '/test/file.txt',
          old_string: 'nonexistent',
          new_string: 'replacement',
        },
        defaultContext
      );

      expect(result.is_error).toBe(true);
      expect(result.content[0].text).toContain('Could not find text to replace');
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it('handles file read error during edit', async () => {
      mockReadFile.mockRejectedValue(new Error('Cannot read file'));

      const { editFile } = await import('@/lib/agents/tools/file-tools');
      const result = await editFile(
        {
          file_path: '/test/file.txt',
          old_string: 'old',
          new_string: 'new',
        },
        defaultContext
      );

      expect(result.is_error).toBe(true);
      expect(result.content[0].text).toContain('Failed to edit file');
    });

    it('handles file write error during edit', async () => {
      mockReadFile.mockResolvedValue('old content');
      mockWriteFile.mockRejectedValue(new Error('Disk full'));

      const { editFile } = await import('@/lib/agents/tools/file-tools');
      const result = await editFile(
        {
          file_path: '/test/file.txt',
          old_string: 'old',
          new_string: 'new',
        },
        defaultContext
      );

      expect(result.is_error).toBe(true);
      expect(result.content[0].text).toContain('Failed to edit file');
      expect(result.content[0].text).toContain('Disk full');
    });
  });

  describe('writeFile', () => {
    it('writes content to file successfully', async () => {
      mockWriteFile.mockResolvedValue(undefined);

      const { writeFile } = await import('@/lib/agents/tools/file-tools');
      const result = await writeFile(
        {
          file_path: '/test/new-file.txt',
          content: 'new file content',
        },
        defaultContext
      );

      expect(result.is_error).toBeUndefined();
      expect(result.content[0].text).toContain('Successfully wrote');
      expect(mockWriteFile).toHaveBeenCalledWith('/test/new-file.txt', 'new file content', 'utf-8');
    });

    it('blocks write to system directory /root (AE-011)', async () => {
      const { writeFile } = await import('@/lib/agents/tools/file-tools');
      const result = await writeFile(
        {
          file_path: '/root/file.txt',
          content: 'content',
        },
        defaultContext
      );

      expect(result.is_error).toBe(true);
      expect(result.content[0].text).toContain('Access denied');
      expect(result.content[0].text).toContain('/root');
    });

    it('handles directory not found error', async () => {
      mockWriteFile.mockRejectedValue(new Error('ENOENT: no such file or directory'));

      const { writeFile } = await import('@/lib/agents/tools/file-tools');
      const result = await writeFile(
        {
          file_path: '/nonexistent/dir/file.txt',
          content: 'content',
        },
        defaultContext
      );

      expect(result.is_error).toBe(true);
      expect(result.content[0].text).toContain('Failed to write file');
    });

    it('handles non-Error thrown values on write', async () => {
      mockWriteFile.mockRejectedValue('write error string');

      const { writeFile } = await import('@/lib/agents/tools/file-tools');
      const result = await writeFile(
        {
          file_path: '/test/file.txt',
          content: 'content',
        },
        defaultContext
      );

      expect(result.is_error).toBe(true);
      expect(result.content[0].text).toContain('write error string');
    });

    it('handles empty content write', async () => {
      mockWriteFile.mockResolvedValue(undefined);

      const { writeFile } = await import('@/lib/agents/tools/file-tools');
      const result = await writeFile(
        {
          file_path: '/test/empty.txt',
          content: '',
        },
        defaultContext
      );

      expect(result.is_error).toBeUndefined();
      expect(mockWriteFile).toHaveBeenCalledWith('/test/empty.txt', '', 'utf-8');
    });

    it('handles special characters in content', async () => {
      mockWriteFile.mockResolvedValue(undefined);

      const { writeFile } = await import('@/lib/agents/tools/file-tools');
      const specialContent = 'Line 1\nLine 2\tTabbed\r\nWindows line';
      const result = await writeFile(
        {
          file_path: '/test/special.txt',
          content: specialContent,
        },
        defaultContext
      );

      expect(result.is_error).toBeUndefined();
      expect(mockWriteFile).toHaveBeenCalledWith('/test/special.txt', specialContent, 'utf-8');
    });
  });
});

// =============================================================================
// Tool Response Structure Tests
// These test the structure of tool responses
// =============================================================================

describe('Tool Response Structure', () => {
  const mockReadFile = vi.fn();
  const mockWriteFile = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();

    vi.doMock('node:fs/promises', () => ({
      default: {
        readFile: mockReadFile,
        writeFile: mockWriteFile,
      },
      readFile: mockReadFile,
      writeFile: mockWriteFile,
    }));
  });

  afterEach(() => {
    vi.doUnmock('node:fs/promises');
  });

  it('success response has correct structure', async () => {
    mockReadFile.mockResolvedValue('content');

    const { readFile } = await import('@/lib/agents/tools/file-tools');
    const result = await readFile({ file_path: '/test/file.txt' }, defaultContext);

    expect(result).toHaveProperty('content');
    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.content[0]).toHaveProperty('type', 'text');
    expect(result.content[0]).toHaveProperty('text');
    expect(result.is_error).toBeUndefined();
  });

  it('error response has correct structure', async () => {
    // Use a dangerous command that returns is_error: true without mocking
    const { bashTool } = await import('@/lib/agents/tools/bash-tool');
    const result = await bashTool({ command: 'DROP TABLE users' }, defaultContext);

    expect(result).toHaveProperty('content');
    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.content[0]).toHaveProperty('type', 'text');
    expect(result.content[0]).toHaveProperty('text');
    expect(result.is_error).toBe(true);
  });

  it('dangerous command response has correct structure', async () => {
    const { bashTool } = await import('@/lib/agents/tools/bash-tool');
    const result = await bashTool({ command: 'rm -rf /' }, defaultContext);

    expect(result).toHaveProperty('content');
    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content[0]).toHaveProperty('type', 'text');
    expect(result.content[0].text).toContain('Dangerous command blocked');
    expect(result.is_error).toBe(true);
  });

  it('blocked command includes the original command in message', async () => {
    const { bashTool } = await import('@/lib/agents/tools/bash-tool');
    const result = await bashTool({ command: 'git push --force origin main' }, defaultContext);

    expect(result.content[0].text).toContain('git push --force origin main');
    expect(result.content[0].text).toContain('Requires explicit user approval');
  });
});

// =============================================================================
// Bash Tool - bashTool function tests without exec mocking
// Only tests that don't require actual command execution
// =============================================================================

describe('Bash Tool - bashTool blocking', () => {
  it('blocks rm -rf commands', async () => {
    const { bashTool } = await import('@/lib/agents/tools/bash-tool');

    const result = await bashTool({ command: 'rm -rf /' }, defaultContext);

    expect(result.is_error).toBe(true);
    expect(result.content[0].text).toContain('Dangerous command blocked');
  });

  it('blocks DROP TABLE commands', async () => {
    const { bashTool } = await import('@/lib/agents/tools/bash-tool');

    const result = await bashTool({ command: 'psql -c "DROP TABLE users"' }, defaultContext);

    expect(result.is_error).toBe(true);
    expect(result.content[0].text).toContain('Dangerous command blocked');
  });

  it('blocks DELETE FROM commands', async () => {
    const { bashTool } = await import('@/lib/agents/tools/bash-tool');

    const result = await bashTool(
      { command: 'mysql -e "DELETE FROM users WHERE 1=1"' },
      defaultContext
    );

    expect(result.is_error).toBe(true);
    expect(result.content[0].text).toContain('Dangerous command blocked');
  });

  it('blocks git push --force', async () => {
    const { bashTool } = await import('@/lib/agents/tools/bash-tool');

    const result = await bashTool({ command: 'git push --force origin main' }, defaultContext);

    expect(result.is_error).toBe(true);
    expect(result.content[0].text).toContain('Dangerous command blocked');
  });

  it('blocks git reset --hard', async () => {
    const { bashTool } = await import('@/lib/agents/tools/bash-tool');

    const result = await bashTool({ command: 'git reset --hard HEAD~5' }, defaultContext);

    expect(result.is_error).toBe(true);
    expect(result.content[0].text).toContain('Dangerous command blocked');
  });

  it('blocks mkfs commands', async () => {
    const { bashTool } = await import('@/lib/agents/tools/bash-tool');

    const result = await bashTool({ command: 'mkfs.ext4 /dev/sda1' }, defaultContext);

    expect(result.is_error).toBe(true);
    expect(result.content[0].text).toContain('Dangerous command blocked');
  });

  it('blocks dd if= commands', async () => {
    const { bashTool } = await import('@/lib/agents/tools/bash-tool');

    const result = await bashTool({ command: 'dd if=/dev/zero of=/dev/sda' }, defaultContext);

    expect(result.is_error).toBe(true);
    expect(result.content[0].text).toContain('Dangerous command blocked');
  });

  it('blocks chmod -R 777 commands', async () => {
    const { bashTool } = await import('@/lib/agents/tools/bash-tool');

    const result = await bashTool({ command: 'chmod -R 777 /var' }, defaultContext);

    expect(result.is_error).toBe(true);
    expect(result.content[0].text).toContain('Dangerous command blocked');
  });

  it('blocks TRUNCATE TABLE commands', async () => {
    const { bashTool } = await import('@/lib/agents/tools/bash-tool');

    const result = await bashTool({ command: 'psql -c "TRUNCATE TABLE logs"' }, defaultContext);

    expect(result.is_error).toBe(true);
    expect(result.content[0].text).toContain('Dangerous command blocked');
  });
});

// =============================================================================
// Edge Cases for isDangerousCommand
// =============================================================================

describe('isDangerousCommand - Pattern Edge Cases', () => {
  it('is case-insensitive for SQL commands', async () => {
    const { isDangerousCommand } = await import('@/lib/agents/tools/bash-tool');
    expect(isDangerousCommand('DROP table users')).toBe(true);
    expect(isDangerousCommand('drop TABLE users')).toBe(true);
    expect(isDangerousCommand('Delete From users')).toBe(true);
    expect(isDangerousCommand('truncate TABLE logs')).toBe(true);
  });

  it('requires specific whitespace patterns', async () => {
    const { isDangerousCommand } = await import('@/lib/agents/tools/bash-tool');
    // Must have whitespace between rm and -rf
    expect(isDangerousCommand('rm -rf /')).toBe(true);
    expect(isDangerousCommand('rm  -rf /')).toBe(true); // Multiple spaces
    expect(isDangerousCommand('rm\t-rf /')).toBe(true); // Tab

    // git push and --force must be separated by whitespace
    expect(isDangerousCommand('git push --force')).toBe(true);
    expect(isDangerousCommand('git  push  --force')).toBe(true);
  });

  it('detects patterns within longer commands', async () => {
    const { isDangerousCommand } = await import('@/lib/agents/tools/bash-tool');
    expect(isDangerousCommand('sudo rm -rf /var/log')).toBe(true);
    expect(isDangerousCommand('env VAR=value rm -rf /tmp')).toBe(true);
    expect(isDangerousCommand('cd /home && rm -rf data')).toBe(true);
  });

  it('does not false-positive on similar but safe commands', async () => {
    const { isDangerousCommand } = await import('@/lib/agents/tools/bash-tool');
    // rm without -rf
    expect(isDangerousCommand('rm file.txt')).toBe(false);
    expect(isDangerousCommand('rm -r dir')).toBe(false); // Missing -f
    expect(isDangerousCommand('rm -f file.txt')).toBe(false); // Missing -r

    // git push without --force
    expect(isDangerousCommand('git push origin main')).toBe(false);

    // git reset without --hard
    expect(isDangerousCommand('git reset HEAD~1')).toBe(false);
    expect(isDangerousCommand('git reset --soft HEAD~1')).toBe(false);
  });
});
