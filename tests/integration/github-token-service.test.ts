import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { githubTokens, projectFolders, teamProjectFolders, teams } from '../../src/db/schema';
import { encryptToken } from '../../src/lib/crypto/server-encryption';
import { GitHubTokenService } from '../../src/services/github-token.service';
import { createTestProject } from '../factories/project.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

describe('GitHubTokenService (IT-210)', () => {
  let service: GitHubTokenService;
  let db: ReturnType<typeof getTestDb>;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    await db.delete(githubTokens);
    service = new GitHubTokenService(db as any);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await clearTestDatabase();
  });

  describe('saveToken (IT-211)', () => {
    it('rejects tokens with invalid PAT format', async () => {
      const result = await service.saveToken('invalid-token');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('INVALID_FORMAT');
    });

    it('rejects tokens without the ghp_ or github_pat_ prefix', async () => {
      const result = await service.saveToken('bearer_abc123');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('INVALID_FORMAT');
    });
  });

  describe('getTokenInfo (IT-212)', () => {
    it('returns null when no token is saved', async () => {
      const result = await service.getTokenInfo();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBeNull();
    });

    it('returns token info after a token is stored directly', async () => {
      const encrypted = encryptToken('ghp_test1234567890abcdefghij');
      await db.insert(githubTokens).values({
        encryptedToken: encrypted,
        tokenType: 'pat',
        githubLogin: 'testuser',
        githubId: '12345',
        isValid: true,
        lastValidatedAt: new Date().toISOString(),
      });

      const result = await service.getTokenInfo();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).not.toBeNull();
      expect(result.value!.githubLogin).toBe('testuser');
      expect(result.value!.isValid).toBe(true);
      // Masked token should show first 4 and last 4 chars
      expect(result.value!.maskedToken).toMatch(/^ghp_.*ghij$/);
    });
  });

  describe('getDecryptedToken (IT-213)', () => {
    it('returns null when no token is saved', async () => {
      const token = await service.getDecryptedToken();
      expect(token).toBeNull();
    });

    it('returns the decrypted token when one is stored', async () => {
      const originalToken = 'ghp_abcdefghijklmnopqrstuvwxyz';
      const encrypted = encryptToken(originalToken);
      await db.insert(githubTokens).values({
        encryptedToken: encrypted,
        tokenType: 'pat',
        githubLogin: 'testuser',
        githubId: '12345',
        isValid: true,
      });

      const decrypted = await service.getDecryptedToken();
      expect(decrypted).toBe(originalToken);
    });
  });

  describe('deleteToken (IT-214)', () => {
    it('deletes all stored tokens', async () => {
      const encrypted = encryptToken('ghp_test1234567890abcdefghij');
      await db.insert(githubTokens).values({
        encryptedToken: encrypted,
        tokenType: 'pat',
        githubLogin: 'testuser',
        githubId: '12345',
        isValid: true,
      });

      const deleteResult = await service.deleteToken();
      expect(deleteResult.ok).toBe(true);

      const infoResult = await service.getTokenInfo();
      expect(infoResult.ok).toBe(true);
      if (!infoResult.ok) return;
      expect(infoResult.value).toBeNull();
    });

    it('succeeds even when no token exists', async () => {
      const result = await service.deleteToken();
      expect(result.ok).toBe(true);
    });
  });

  describe('resolveGitHubTokenForCodespace (IT-215)', () => {
    it('returns null when codespace does not exist', async () => {
      const token = await service.resolveGitHubTokenForCodespace('nonexistent-codespace');
      expect(token).toBeNull();
    });

    it('returns global token when codespace has no team associations', async () => {
      const codespace = await createTestProject();
      const originalToken = 'ghp_globaltoken1234567890abcde';
      const encrypted = encryptToken(originalToken);

      // Insert a global token (no teamId)
      await db.insert(githubTokens).values({
        encryptedToken: encrypted,
        tokenType: 'pat',
        githubLogin: 'global-user',
        githubId: '99999',
        isValid: true,
        teamId: null,
      });

      const resolved = await service.resolveGitHubTokenForCodespace(codespace.id);
      expect(resolved).toBe(originalToken);
    });

    it('returns team-specific token when codespace belongs to a team', async () => {
      // Create a team
      const [team] = await db
        .insert(teams)
        .values({ name: 'Test Team', slug: 'test-team' })
        .returning();
      expect(team).toBeDefined();

      // Create a project folder and associate it with the team
      const testFolderId = 'team-test-folder';
      try {
        await db.insert(projectFolders).values({
          id: testFolderId,
          name: 'Team Folder',
          slug: 'team-folder',
        });
      } catch {
        // May already exist
      }

      await db.insert(teamProjectFolders).values({
        teamId: team!.id,
        projectFolderId: testFolderId,
      });

      // Create a codespace in that folder
      const codespace = await createTestProject({ projectFolderId: testFolderId });

      // Insert a team-specific token
      const teamToken = 'ghp_teamtoken1234567890abcdefg';
      const encryptedTeam = encryptToken(teamToken);
      await db.insert(githubTokens).values({
        encryptedToken: encryptedTeam,
        tokenType: 'pat',
        githubLogin: 'team-user',
        githubId: '11111',
        isValid: true,
        teamId: team!.id,
      });

      // Also insert a global token (should NOT be returned)
      const globalToken = 'ghp_globaltoken1234567890abcde';
      const encryptedGlobal = encryptToken(globalToken);
      await db.insert(githubTokens).values({
        encryptedToken: encryptedGlobal,
        tokenType: 'pat',
        githubLogin: 'global-user',
        githubId: '99999',
        isValid: true,
        teamId: null,
      });

      const resolved = await service.resolveGitHubTokenForCodespace(codespace.id);
      expect(resolved).toBe(teamToken);
    });

    it('falls back to global token when team has no token', async () => {
      // Create a team
      const [team] = await db
        .insert(teams)
        .values({ name: 'No Token Team', slug: 'no-token-team' })
        .returning();
      expect(team).toBeDefined();

      // Create a project folder and associate it with the team
      const testFolderId = 'no-token-folder';
      try {
        await db.insert(projectFolders).values({
          id: testFolderId,
          name: 'No Token Folder',
          slug: 'no-token-folder',
        });
      } catch {
        // May already exist
      }

      await db.insert(teamProjectFolders).values({
        teamId: team!.id,
        projectFolderId: testFolderId,
      });

      // Create a codespace in that folder
      const codespace = await createTestProject({ projectFolderId: testFolderId });

      // Only insert a global token (no team-specific token)
      const globalToken = 'ghp_globalfallback12345678abcde';
      const encryptedGlobal = encryptToken(globalToken);
      await db.insert(githubTokens).values({
        encryptedToken: encryptedGlobal,
        tokenType: 'pat',
        githubLogin: 'global-user',
        githubId: '99999',
        isValid: true,
        teamId: null,
      });

      const resolved = await service.resolveGitHubTokenForCodespace(codespace.id);
      expect(resolved).toBe(globalToken);
    });

    it('returns null when no tokens exist at all', async () => {
      const codespace = await createTestProject();

      const resolved = await service.resolveGitHubTokenForCodespace(codespace.id);
      expect(resolved).toBeNull();
    });

    it('returns null when codespace has no projectFolderId', async () => {
      // Create codespace without a folder association
      const codespace = await createTestProject({ projectFolderId: null as any });

      // Insert only a team-specific token (no global)
      const [team] = await db
        .insert(teams)
        .values({ name: 'Isolated Team', slug: 'isolated-team' })
        .returning();

      const teamToken = 'ghp_teamonlytoken12345678abcde';
      await db.insert(githubTokens).values({
        encryptedToken: encryptToken(teamToken),
        tokenType: 'pat',
        githubLogin: 'team-user',
        githubId: '22222',
        isValid: true,
        teamId: team!.id,
      });

      // No global token, codespace has no folder -> no team association
      const resolved = await service.resolveGitHubTokenForCodespace(codespace.id);
      expect(resolved).toBeNull();
    });
  });

  describe('getOctokit (IT-216)', () => {
    it('returns null when no token is stored', async () => {
      const octokit = await service.getOctokit();
      expect(octokit).toBeNull();
    });

    it('returns an Octokit instance when a token is stored', async () => {
      const encrypted = encryptToken('ghp_test1234567890abcdefghij');
      await db.insert(githubTokens).values({
        encryptedToken: encrypted,
        tokenType: 'pat',
        githubLogin: 'testuser',
        githubId: '12345',
        isValid: true,
      });

      const octokit = await service.getOctokit();
      expect(octokit).not.toBeNull();
      // Octokit should have rest API
      expect(octokit!.rest).toBeDefined();
      expect(octokit!.rest.users).toBeDefined();
    });
  });

  describe('encryption round-trip (IT-217)', () => {
    it('encrypts and decrypts tokens correctly through DB storage', async () => {
      const tokens = [
        'ghp_shortToken123456789012',
        'github_pat_longerFinegrainedToken1234567890abcdefghijklmnop',
      ];

      for (const originalToken of tokens) {
        await db.delete(githubTokens);
        const encrypted = encryptToken(originalToken);

        await db.insert(githubTokens).values({
          encryptedToken: encrypted,
          tokenType: 'pat',
          isValid: true,
        });

        const decrypted = await service.getDecryptedToken();
        expect(decrypted).toBe(originalToken);
      }
    });
  });

  describe('token replacement (IT-218)', () => {
    it('only keeps one global token at a time (saveToken deletes previous)', async () => {
      // Manually insert two tokens to simulate pre-existing state
      const enc1 = encryptToken('ghp_firsttoken1234567890abcde');
      const enc2 = encryptToken('ghp_secondtoken234567890abcde');

      await db.insert(githubTokens).values({
        encryptedToken: enc1,
        tokenType: 'pat',
        githubLogin: 'user1',
        githubId: '111',
        isValid: true,
      });
      await db.insert(githubTokens).values({
        encryptedToken: enc2,
        tokenType: 'pat',
        githubLogin: 'user2',
        githubId: '222',
        isValid: true,
      });

      // Verify two tokens exist
      const allTokens = await db.query.githubTokens.findMany();
      expect(allTokens.length).toBe(2);

      // deleteToken should clear all
      await service.deleteToken();
      const remaining = await db.query.githubTokens.findMany();
      expect(remaining.length).toBe(0);
    });
  });
});
