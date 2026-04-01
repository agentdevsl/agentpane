import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProjectFoldersRoutes } from '../../src/server/routes/project-folders';
import { ProjectFolderService } from '../../src/services/project-folder.service';
import { createTestProject } from '../factories/project.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

/**
 * Integration tests for project-folders API routes.
 *
 * Creates a real Hono app with the project-folders routes mounted,
 * backed by a real SQLite database via ProjectFolderService.
 */

const jsonRequest = (url: string, body: unknown, init?: RequestInit): Request =>
  new Request(url, {
    ...init,
    method: init?.method ?? 'POST',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    body: JSON.stringify(body),
  });

describe('Project Folder Routes (IT-500)', () => {
  let app: ReturnType<typeof createProjectFoldersRoutes>;
  let service: ProjectFolderService;
  let db: ReturnType<typeof getTestDb>;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    service = new ProjectFolderService(db as any);
    app = createProjectFoldersRoutes({ projectFolderService: service });
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  // ─── GET /api/project-folders ───────────────────────

  it('IT-501: GET / returns empty list when no folders exist (besides default)', async () => {
    // clearTestDatabase re-seeds default-folder, so we expect at least that
    const response = await app.request('http://localhost/');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.data.items).toBeDefined();
    expect(Array.isArray(body.data.items)).toBe(true);
    expect(body.data.totalCount).toBeGreaterThanOrEqual(1);
  });

  it('IT-502: GET / returns folders after creation', async () => {
    await service.create({ name: 'Frontend', slug: 'frontend' });
    await service.create({ name: 'Backend', slug: 'backend' });

    const response = await app.request('http://localhost/');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    // default-folder + 2 created
    expect(body.data.totalCount).toBeGreaterThanOrEqual(3);
  });

  // ─── POST /api/project-folders ──────────────────────

  it('IT-503: POST / creates a new folder', async () => {
    const response = await app.request(
      jsonRequest('http://localhost/', {
        name: 'My Folder',
        description: 'Test folder',
        icon: 'Star',
        color: '#FF0000',
      })
    );

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.data.name).toBe('My Folder');
    expect(body.data.description).toBe('Test folder');
    expect(body.data.icon).toBe('Star');
    expect(body.data.color).toBe('#FF0000');
    expect(body.data.slug).toBeDefined();
    expect(body.data.id).toBeDefined();
  });

  it('IT-504: POST / uses provided slug when given', async () => {
    const response = await app.request(
      jsonRequest('http://localhost/', {
        name: 'Custom Slug Folder',
        slug: 'custom-slug',
      })
    );

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.data.slug).toBe('custom-slug');
  });

  it('IT-505: POST / returns 400 when name is missing', async () => {
    const response = await app.request(
      jsonRequest('http://localhost/', { description: 'no name' })
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.ok).toBe(false);
  });

  it('IT-506: POST / returns 400 for empty name', async () => {
    const response = await app.request(jsonRequest('http://localhost/', { name: '' }));

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.ok).toBe(false);
  });

  it('IT-507: POST / returns error for duplicate slug', async () => {
    await service.create({ name: 'First', slug: 'dupe-slug' });

    const response = await app.request(
      jsonRequest('http://localhost/', { name: 'Second', slug: 'dupe-slug' })
    );

    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('PROJECT_FOLDER_SLUG_EXISTS');
  });

  it('IT-508: POST / returns 400 for invalid JSON', async () => {
    const response = await app.request(
      new Request('http://localhost/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not-json',
      })
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.ok).toBe(false);
  });

  // ─── GET /api/project-folders/:id ───────────────────

  it('IT-509: GET /:id returns a folder by ID', async () => {
    const createResult = await service.create({ name: 'FindMe', slug: 'find-me' });
    const folder = createResult.ok ? createResult.value : null;
    expect(folder).not.toBeNull();

    const response = await app.request(`http://localhost/${folder!.id}`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.data.id).toBe(folder!.id);
    expect(body.data.name).toBe('FindMe');
  });

  it('IT-510: GET /:id returns 404 for non-existent folder', async () => {
    const response = await app.request('http://localhost/nonexistent-id-abc');
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('IT-511: GET /:id returns 400 for invalid ID format', async () => {
    const response = await app.request('http://localhost/inv@lid!');
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('INVALID_ID');
  });

  // ─── PATCH /api/project-folders/:id ─────────────────

  it('IT-512: PATCH /:id updates a folder', async () => {
    const createResult = await service.create({ name: 'Old Name', slug: 'old-name' });
    const folder = createResult.ok ? createResult.value : null;
    expect(folder).not.toBeNull();

    const response = await app.request(
      jsonRequest(`http://localhost/${folder!.id}`, { name: 'New Name' }, { method: 'PATCH' })
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.data.name).toBe('New Name');
    expect(body.data.slug).toBe('old-name'); // unchanged
  });

  it('IT-513: PATCH /:id returns 404 for non-existent folder', async () => {
    const response = await app.request(
      jsonRequest('http://localhost/nonexistent-id-xyz', { name: 'New' }, { method: 'PATCH' })
    );

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.ok).toBe(false);
  });

  it('IT-514: PATCH /:id returns 400 when no fields provided', async () => {
    const createResult = await service.create({ name: 'NoUpdate', slug: 'no-update' });
    const folder = createResult.ok ? createResult.value : null;
    expect(folder).not.toBeNull();

    const response = await app.request(
      jsonRequest(`http://localhost/${folder!.id}`, {}, { method: 'PATCH' })
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.ok).toBe(false);
  });

  // ─── DELETE /api/project-folders/:id ────────────────

  it('IT-515: DELETE /:id removes an empty folder', async () => {
    const createResult = await service.create({ name: 'ToDelete', slug: 'to-delete' });
    const folder = createResult.ok ? createResult.value : null;
    expect(folder).not.toBeNull();

    const response = await app.request(`http://localhost/${folder!.id}`, { method: 'DELETE' });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.data.deleted).toBe(true);

    // Verify it's gone
    const getResponse = await app.request(`http://localhost/${folder!.id}`);
    expect(getResponse.status).toBe(404);
  });

  it('IT-516: DELETE /:id returns 404 for non-existent folder', async () => {
    const response = await app.request('http://localhost/nonexistent-del', { method: 'DELETE' });
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.ok).toBe(false);
  });

  it('IT-517: DELETE /:id refuses to delete folder with codespaces', async () => {
    const createResult = await service.create({ name: 'HasCodespaces', slug: 'has-codespaces' });
    const folder = createResult.ok ? createResult.value : null;
    expect(folder).not.toBeNull();

    // Create a codespace in this folder
    await createTestProject({ projectFolderId: folder!.id });

    const response = await app.request(`http://localhost/${folder!.id}`, { method: 'DELETE' });
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('PROJECT_FOLDER_HAS_CODESPACES');
  });

  // ─── GET /api/project-folders/:id/codespaces ───────

  it('IT-518: GET /:id/codespaces returns codespaces in folder', async () => {
    const createResult = await service.create({ name: 'WithCS', slug: 'with-cs' });
    const folder = createResult.ok ? createResult.value : null;
    expect(folder).not.toBeNull();

    await createTestProject({ name: 'CS1', projectFolderId: folder!.id });
    await createTestProject({ name: 'CS2', projectFolderId: folder!.id });

    const response = await app.request(`http://localhost/${folder!.id}/codespaces`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.data.items.length).toBe(2);
    expect(body.data.totalCount).toBe(2);
  });

  it('IT-519: GET /:id/codespaces returns 404 for non-existent folder', async () => {
    const response = await app.request('http://localhost/no-folder-here/codespaces');
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.ok).toBe(false);
  });

  // ─── GET /api/project-folders/:id/summary ──────────

  it('IT-520: GET /:id/summary returns folder summary', async () => {
    const createResult = await service.create({ name: 'Summary', slug: 'summary-test' });
    const folder = createResult.ok ? createResult.value : null;
    expect(folder).not.toBeNull();

    const response = await app.request(`http://localhost/${folder!.id}/summary`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.data.folder).toBeDefined();
    expect(body.data.totalCodespaces).toBe(0);
    expect(body.data.runningAgents).toBe(0);
    expect(body.data.totalTasks).toBe(0);
  });

  it('IT-521: GET /:id/summary returns 404 for non-existent folder', async () => {
    const response = await app.request('http://localhost/no-summary-id/summary');
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.ok).toBe(false);
  });

  // ─── Round-trip test ────────────────────────────────

  it('IT-522: Full CRUD round-trip: create, get, update, list, delete', async () => {
    // Create
    const createRes = await app.request(
      jsonRequest('http://localhost/', { name: 'RoundTrip', slug: 'round-trip', icon: 'Zap' })
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()).data;

    // Get
    const getRes = await app.request(`http://localhost/${created.id}`);
    expect(getRes.status).toBe(200);
    const fetched = (await getRes.json()).data;
    expect(fetched.name).toBe('RoundTrip');
    expect(fetched.icon).toBe('Zap');

    // Update
    const updateRes = await app.request(
      jsonRequest(`http://localhost/${created.id}`, { name: 'Updated' }, { method: 'PATCH' })
    );
    expect(updateRes.status).toBe(200);
    const updated = (await updateRes.json()).data;
    expect(updated.name).toBe('Updated');

    // List — should include the folder
    const listRes = await app.request('http://localhost/');
    const listed = (await listRes.json()).data;
    expect(listed.items.some((f: any) => f.id === created.id)).toBe(true);

    // Delete
    const delRes = await app.request(`http://localhost/${created.id}`, { method: 'DELETE' });
    expect(delRes.status).toBe(200);

    // Verify gone
    const verifyRes = await app.request(`http://localhost/${created.id}`);
    expect(verifyRes.status).toBe(404);
  });
});
