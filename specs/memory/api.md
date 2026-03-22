# Memory Service API Endpoints Specification

## Overview

REST API endpoints for the AgentPane memory service. The memory service provides a management and query interface over the Honcho memory backend. All endpoints are mounted under `/api/memory` and follow the standard AgentPane route factory pattern.

**Route file:** `src/server/routes/memory.ts`
**Mount:** `app.route('/api/memory', createMemoryRoutes({ memoryService }))`

All memory endpoints are **conditional** -- they are only mounted when `memoryService` is available in the service container (i.e., Honcho is configured). If Honcho is unavailable, the entire `/api/memory` prefix returns 404.

---

## Architecture

### Route Factory

```typescript
import { Hono } from 'hono';
import type { MemoryService } from '../../services/memory/memory.service.js';

interface MemoryDeps {
  memoryService: MemoryService;
}

export function createMemoryRoutes({ memoryService }: MemoryDeps) {
  const app = new Hono();
  // ... route definitions
  return app;
}
```

### Response Format

All responses follow the standard AgentPane envelope:

**Success:**
```typescript
{ ok: true, data: T }
```

**Success with pagination:**
```typescript
{ ok: true, data: T[], pagination: { limit: number, offset: number, total?: number, hasMore: boolean } }
```

**Error:**
```typescript
{
  ok: false,
  error: {
    code: string,       // Machine-readable error code (e.g., MEMORY_UNAVAILABLE)
    message: string     // Human-readable description
  }
}
```

---

## Authentication & Authorization

All `/api/memory/*` endpoints require authentication via the standard middleware chain (session cookie or `Authorization: Bearer <token>`).

### RBAC Role Guards

| Endpoint Pattern | Minimum Role | Rationale |
|---|---|---|
| `POST /api/memory/health` | `viewer` | Read-only health check |
| `GET /api/memory/codespaces/:codespaceId/*` | `viewer` | Read access to memory data |
| `POST /api/memory/codespaces/:codespaceId/conclusions` | `agent_operator` | Creating memory entries |
| `POST /api/memory/codespaces/:codespaceId/documents` | `agent_operator` | Indexing documents |
| `POST /api/memory/codespaces/:codespaceId/search` | `viewer` | Semantic search is read-only |
| `DELETE /api/memory/conclusions/:conclusionId` | `agent_operator` | Deleting memory entries |
| `DELETE /api/memory/documents/:documentId` | `agent_operator` | Deleting indexed documents |

The route group is guarded at the router level with `requireRole('viewer')`, and individual write endpoints perform additional role checks internally.

---

## Endpoints

### Health

#### `GET /api/memory/health`

Check Honcho backend availability and connection status.

**Minimum role:** `viewer`

**Request:** No body required.

**Response (200):**
```typescript
{
  ok: true,
  data: {
    available: boolean,       // Whether Honcho is reachable
    version: string | null,   // Honcho server version if available
    latencyMs: number,        // Round-trip ping time in milliseconds
    workspaceCount: number    // Number of Honcho workspaces configured
  }
}
```

**Response (503) -- Honcho unreachable:**
```typescript
{
  ok: false,
  error: {
    code: "MEMORY_UNAVAILABLE",
    message: "Memory service is not available. Honcho backend is unreachable."
  }
}
```

**Example:**
```bash
curl -X POST http://localhost:3001/api/memory/health \
  -H "Cookie: session=..."
```

```json
{
  "ok": true,
  "data": {
    "available": true,
    "version": "0.1.0",
    "latencyMs": 12,
    "workspaceCount": 3
  }
}
```

---

### Conclusions

Conclusions are derived facts that Honcho generates from agent sessions. They can also be manually created by users to inject knowledge (e.g., "Always use ESM imports in this project").

#### `GET /api/memory/codespaces/:codespaceId/conclusions`

List conclusions for a codespace.

**Minimum role:** `viewer`

**Path params:**

| Param | Type | Description |
|---|---|---|
| `codespaceId` | `string` | Codespace ID (CUID2) |

**Query params (Zod schema):**

```typescript
const listConclusionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  search: z.string().optional(),         // Filter by content substring
  source: z.enum(['derived', 'manual']).optional(),  // Filter by origin
});
```

**Response (200):**
```typescript
{
  ok: true,
  data: Array<{
    id: string,              // Honcho conclusion ID
    content: string,         // The conclusion text
    source: 'derived' | 'manual',  // Auto-derived or user-created
    createdAt: string,       // ISO 8601 timestamp
    sessionId: string | null // Source session (null for manual)
  }>,
  pagination: {
    limit: number,
    offset: number,
    total: number,
    hasMore: boolean
  }
}
```

**Error responses:**

| Code | Status | When |
|---|---|---|
| `MEMORY_UNAVAILABLE` | 503 | Honcho is unreachable |
| `INVALID_PARAMS` | 400 | Invalid query parameters |

**Example:**
```bash
curl http://localhost:3001/api/memory/codespaces/abc123/conclusions?limit=10&source=derived \
  -H "Cookie: session=..."
```

```json
{
  "ok": true,
  "data": [
    {
      "id": "concl_xyz789",
      "content": "This project uses ESM imports exclusively. Never use require().",
      "source": "derived",
      "createdAt": "2026-03-20T14:30:00Z",
      "sessionId": "sess_abc456"
    }
  ],
  "pagination": {
    "limit": 10,
    "offset": 0,
    "total": 1,
    "hasMore": false
  }
}
```

---

#### `POST /api/memory/codespaces/:codespaceId/conclusions`

Create a manual conclusion (user-injected knowledge).

**Minimum role:** `agent_operator`

**Path params:**

| Param | Type | Description |
|---|---|---|
| `codespaceId` | `string` | Codespace ID (CUID2) |

**Request body (Zod schema):**

```typescript
const createConclusionSchema = z.object({
  content: z.string().min(1).max(4096),  // The conclusion text
});
```

**Response (201):**
```typescript
{
  ok: true,
  data: {
    id: string,
    content: string,
    source: 'manual',
    createdAt: string,
    sessionId: null
  }
}
```

**Error responses:**

| Code | Status | When |
|---|---|---|
| `MEMORY_UNAVAILABLE` | 503 | Honcho is unreachable |
| `VALIDATION_ERROR` | 400 | Invalid or missing content |
| `FORBIDDEN` | 403 | User lacks `agent_operator` role |

**Example:**
```bash
curl -X POST http://localhost:3001/api/memory/codespaces/abc123/conclusions \
  -H "Cookie: session=..." \
  -H "Content-Type: application/json" \
  -d '{"content": "Always run biome check before committing. Use --max-diagnostics=500."}'
```

```json
{
  "ok": true,
  "data": {
    "id": "concl_new001",
    "content": "Always run biome check before committing. Use --max-diagnostics=500.",
    "source": "manual",
    "createdAt": "2026-03-22T10:15:00Z",
    "sessionId": null
  }
}
```

---

#### `DELETE /api/memory/conclusions/:conclusionId`

Delete a conclusion.

**Minimum role:** `agent_operator`

**Path params:**

| Param | Type | Description |
|---|---|---|
| `conclusionId` | `string` | Honcho conclusion ID |

**Response (200):**
```typescript
{
  ok: true,
  data: { deleted: true }
}
```

**Error responses:**

| Code | Status | When |
|---|---|---|
| `MEMORY_UNAVAILABLE` | 503 | Honcho is unreachable |
| `MEMORY_NOT_FOUND` | 404 | Conclusion does not exist |
| `FORBIDDEN` | 403 | User lacks `agent_operator` role |

**Example:**
```bash
curl -X DELETE http://localhost:3001/api/memory/conclusions/concl_xyz789 \
  -H "Cookie: session=..."
```

```json
{
  "ok": true,
  "data": { "deleted": true }
}
```

---

### Documents

Documents are indexed content stored in Honcho collections for RAG retrieval. They can represent CLAUDE.md files, AGENTS.md files, or any other reference material.

#### `GET /api/memory/codespaces/:codespaceId/documents`

List indexed documents for a codespace.

**Minimum role:** `viewer`

**Path params:**

| Param | Type | Description |
|---|---|---|
| `codespaceId` | `string` | Codespace ID (CUID2) |

**Query params (Zod schema):**

```typescript
const listDocumentsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  collection: z.string().optional(),  // Filter by collection name
});
```

**Response (200):**
```typescript
{
  ok: true,
  data: Array<{
    id: string,               // Honcho document ID
    title: string,            // Document title / filename
    content: string,          // Document content (may be truncated)
    collection: string,       // Collection name (e.g., "skills", "reference")
    metadata: Record<string, unknown>,  // Arbitrary metadata
    createdAt: string         // ISO 8601 timestamp
  }>,
  pagination: {
    limit: number,
    offset: number,
    total: number,
    hasMore: boolean
  }
}
```

**Error responses:**

| Code | Status | When |
|---|---|---|
| `MEMORY_UNAVAILABLE` | 503 | Honcho is unreachable |
| `INVALID_PARAMS` | 400 | Invalid query parameters |

**Example:**
```bash
curl http://localhost:3001/api/memory/codespaces/abc123/documents?collection=skills \
  -H "Cookie: session=..."
```

```json
{
  "ok": true,
  "data": [
    {
      "id": "doc_abc123",
      "title": "AGENTS.md",
      "content": "# Agent Guidelines\n\nAlways use Drizzle ORM...",
      "collection": "reference",
      "metadata": { "filePath": "/repo/AGENTS.md", "indexedAt": "2026-03-20T10:00:00Z" },
      "createdAt": "2026-03-20T10:00:00Z"
    }
  ],
  "pagination": {
    "limit": 50,
    "offset": 0,
    "total": 1,
    "hasMore": false
  }
}
```

---

#### `POST /api/memory/codespaces/:codespaceId/documents`

Index a document into a Honcho collection for RAG retrieval.

**Minimum role:** `agent_operator`

**Path params:**

| Param | Type | Description |
|---|---|---|
| `codespaceId` | `string` | Codespace ID (CUID2) |

**Request body (Zod schema):**

```typescript
const createDocumentSchema = z.object({
  title: z.string().min(1).max(255),
  content: z.string().min(1).max(65536),            // Max ~64KB per document
  collection: z.string().min(1).max(64).default('reference'),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
```

**Response (201):**
```typescript
{
  ok: true,
  data: {
    id: string,
    title: string,
    content: string,
    collection: string,
    metadata: Record<string, unknown>,
    createdAt: string
  }
}
```

**Error responses:**

| Code | Status | When |
|---|---|---|
| `MEMORY_UNAVAILABLE` | 503 | Honcho is unreachable |
| `VALIDATION_ERROR` | 400 | Invalid body (missing title/content, exceeds limits) |
| `FORBIDDEN` | 403 | User lacks `agent_operator` role |

**Example:**
```bash
curl -X POST http://localhost:3001/api/memory/codespaces/abc123/documents \
  -H "Cookie: session=..." \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Deployment Guide",
    "content": "# Deployment\n\nUse docker compose up -d...",
    "collection": "reference",
    "metadata": { "filePath": "/repo/docs/deploy.md" }
  }'
```

```json
{
  "ok": true,
  "data": {
    "id": "doc_new001",
    "title": "Deployment Guide",
    "content": "# Deployment\n\nUse docker compose up -d...",
    "collection": "reference",
    "metadata": { "filePath": "/repo/docs/deploy.md" },
    "createdAt": "2026-03-22T10:20:00Z"
  }
}
```

---

#### `DELETE /api/memory/documents/:documentId`

Delete an indexed document.

**Minimum role:** `agent_operator`

**Path params:**

| Param | Type | Description |
|---|---|---|
| `documentId` | `string` | Honcho document ID |

**Response (200):**
```typescript
{
  ok: true,
  data: { deleted: true }
}
```

**Error responses:**

| Code | Status | When |
|---|---|---|
| `MEMORY_UNAVAILABLE` | 503 | Honcho is unreachable |
| `MEMORY_NOT_FOUND` | 404 | Document does not exist |
| `FORBIDDEN` | 403 | User lacks `agent_operator` role |

**Example:**
```bash
curl -X DELETE http://localhost:3001/api/memory/documents/doc_abc123 \
  -H "Cookie: session=..."
```

```json
{
  "ok": true,
  "data": { "deleted": true }
}
```

---

### Sessions

Memory sessions map 1:1 to AgentPane sessions. This endpoint exposes the Honcho-side session metadata, including message counts and derivation status.

#### `GET /api/memory/codespaces/:codespaceId/sessions`

List memory sessions for a codespace.

**Minimum role:** `viewer`

**Path params:**

| Param | Type | Description |
|---|---|---|
| `codespaceId` | `string` | Codespace ID (CUID2) |

**Query params (Zod schema):**

```typescript
const listMemorySessionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
```

**Response (200):**
```typescript
{
  ok: true,
  data: Array<{
    id: string,                  // Honcho session ID
    agentPaneSessionId: string,  // Corresponding AgentPane session ID
    messageCount: number,        // Number of captured messages
    conclusionCount: number,     // Number of derived conclusions
    isFinalized: boolean,        // Whether derivation has completed
    createdAt: string,           // ISO 8601 timestamp
    closedAt: string | null      // When session was finalized
  }>,
  pagination: {
    limit: number,
    offset: number,
    total: number,
    hasMore: boolean
  }
}
```

**Error responses:**

| Code | Status | When |
|---|---|---|
| `MEMORY_UNAVAILABLE` | 503 | Honcho is unreachable |
| `INVALID_PARAMS` | 400 | Invalid query parameters |

**Example:**
```bash
curl http://localhost:3001/api/memory/codespaces/abc123/sessions?limit=20 \
  -H "Cookie: session=..."
```

```json
{
  "ok": true,
  "data": [
    {
      "id": "hsess_abc123",
      "agentPaneSessionId": "sess_xyz789",
      "messageCount": 42,
      "conclusionCount": 3,
      "isFinalized": true,
      "createdAt": "2026-03-20T09:00:00Z",
      "closedAt": "2026-03-20T09:45:00Z"
    }
  ],
  "pagination": {
    "limit": 20,
    "offset": 0,
    "total": 1,
    "hasMore": false
  }
}
```

---

### Search

#### `POST /api/memory/codespaces/:codespaceId/search`

Perform a semantic search across conclusions and documents for a codespace. Uses Honcho's vector-based similarity search (pgvector) to find relevant memory entries.

**Minimum role:** `viewer`

**Path params:**

| Param | Type | Description |
|---|---|---|
| `codespaceId` | `string` | Codespace ID (CUID2) |

**Request body (Zod schema):**

```typescript
const searchMemorySchema = z.object({
  query: z.string().min(1).max(1024),
  types: z.array(z.enum(['conclusions', 'documents'])).default(['conclusions', 'documents']),
  limit: z.number().int().min(1).max(50).default(10),
  collection: z.string().optional(),      // Restrict document search to a collection
  minScore: z.number().min(0).max(1).optional(),  // Minimum similarity threshold
});
```

**Response (200):**
```typescript
{
  ok: true,
  data: {
    results: Array<{
      type: 'conclusion' | 'document',
      id: string,
      content: string,
      score: number,          // Similarity score (0-1, higher is more relevant)
      metadata: Record<string, unknown>  // Source metadata
    }>,
    query: string,            // Echo of the search query
    totalResults: number      // Total matches found
  }
}
```

**Error responses:**

| Code | Status | When |
|---|---|---|
| `MEMORY_UNAVAILABLE` | 503 | Honcho is unreachable |
| `VALIDATION_ERROR` | 400 | Invalid body (missing query, bad types) |

**Example:**
```bash
curl -X POST http://localhost:3001/api/memory/codespaces/abc123/search \
  -H "Cookie: session=..." \
  -H "Content-Type: application/json" \
  -d '{"query": "how to deploy to production", "types": ["documents", "conclusions"], "limit": 5}'
```

```json
{
  "ok": true,
  "data": {
    "results": [
      {
        "type": "document",
        "id": "doc_deploy01",
        "content": "# Deployment\n\nUse docker compose up -d to deploy...",
        "score": 0.92,
        "metadata": { "filePath": "/repo/docs/deploy.md", "collection": "reference" }
      },
      {
        "type": "conclusion",
        "id": "concl_dep02",
        "content": "Production deployments require running migrations before starting the API server.",
        "score": 0.85,
        "metadata": { "source": "derived", "sessionId": "sess_xyz789" }
      }
    ],
    "query": "how to deploy to production",
    "totalResults": 2
  }
}
```

---

## Error Codes

Memory-specific error codes defined in `src/lib/errors/memory-errors.ts`:

```typescript
import { createError } from './base.js';

export const MemoryErrors = {
  UNAVAILABLE: createError(
    'MEMORY_UNAVAILABLE',
    'Memory service is not available. Honcho backend is unreachable.',
    503
  ),

  NOT_FOUND: (entity: string) => createError(
    'MEMORY_NOT_FOUND',
    `Memory ${entity} not found`,
    404,
    { entity }
  ),

  WORKSPACE_NOT_FOUND: (codespaceId: string) => createError(
    'MEMORY_WORKSPACE_NOT_FOUND',
    `No memory workspace found for codespace ${codespaceId}`,
    404,
    { codespaceId }
  ),

  CAPTURE_FAILED: (reason: string) => createError(
    'MEMORY_CAPTURE_FAILED',
    `Failed to capture memory: ${reason}`,
    500,
    { reason }
  ),

  QUERY_FAILED: (reason: string) => createError(
    'MEMORY_QUERY_FAILED',
    `Memory query failed: ${reason}`,
    500,
    { reason }
  ),

  CONTENT_TOO_LARGE: (maxBytes: number) => createError(
    'MEMORY_CONTENT_TOO_LARGE',
    `Content exceeds maximum size of ${maxBytes} bytes`,
    413,
    { maxBytes }
  ),
};
```

### Error Code Reference

| Code | HTTP Status | Description |
|---|---|---|
| `MEMORY_UNAVAILABLE` | 503 | Honcho server is unreachable or not configured |
| `MEMORY_NOT_FOUND` | 404 | Requested conclusion, document, or session does not exist |
| `MEMORY_WORKSPACE_NOT_FOUND` | 404 | No Honcho workspace mapped to the given codespace |
| `MEMORY_CAPTURE_FAILED` | 500 | Failed to write message/event to Honcho |
| `MEMORY_QUERY_FAILED` | 500 | Honcho query returned an unexpected error |
| `MEMORY_CONTENT_TOO_LARGE` | 413 | Document or conclusion content exceeds size limit |
| `VALIDATION_ERROR` | 400 | Request body fails Zod validation |
| `INVALID_PARAMS` | 400 | Query parameters are malformed |
| `FORBIDDEN` | 403 | User lacks required RBAC role |

---

## Pagination

Memory endpoints use **offset-based pagination** rather than cursor-based pagination. This is appropriate because:

1. Memory data is relatively static (conclusions and documents don't change between page requests)
2. The Memory UI uses a simple paginated list rather than infinite scroll
3. Honcho's SDK uses offset-based queries natively

### Pagination Parameters

All list endpoints accept:

| Param | Type | Default | Max | Description |
|---|---|---|---|---|
| `limit` | `number` | 50 | 100 | Items per page |
| `offset` | `number` | 0 | -- | Number of items to skip |

### Pagination Response

```typescript
{
  pagination: {
    limit: number,       // Requested page size
    offset: number,      // Current offset
    total: number,       // Total items matching the query
    hasMore: boolean     // Whether more pages exist (offset + limit < total)
  }
}
```

---

## Rate Limiting

Memory endpoints are covered by the global AgentPane rate limiter:

| Client Type | Limit |
|---|---|
| Per IP | 200 requests/minute |
| Per API token | 100 requests/minute |

### Additional Considerations

- **Search endpoint**: The `POST /api/memory/codespaces/:codespaceId/search` endpoint invokes vector similarity search on pgvector, which is more expensive than standard queries. Consider applying a stricter per-endpoint limit (e.g., 30 requests/minute) if search volume becomes a concern.
- **Document indexing**: The `POST /api/memory/codespaces/:codespaceId/documents` endpoint triggers embedding generation in Honcho. Bulk indexing should be throttled client-side to avoid overloading the embedding pipeline.
- **Health checks**: The `POST /api/memory/health` endpoint is lightweight and should not require stricter limits beyond the global rate limiter.

---

## Validation Schemas (Complete)

All Zod schemas used by memory routes, consolidated for reference:

```typescript
// src/server/routes/memory.ts (or src/server/validation.ts)

import { z } from 'zod';

// === Query Schemas ===

export const listConclusionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  search: z.string().optional(),
  source: z.enum(['derived', 'manual']).optional(),
});

export const listDocumentsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  collection: z.string().optional(),
});

export const listMemorySessionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// === Body Schemas ===

export const createConclusionSchema = z.object({
  content: z.string().min(1).max(4096),
});

export const createDocumentSchema = z.object({
  title: z.string().min(1).max(255),
  content: z.string().min(1).max(65536),
  collection: z.string().min(1).max(64).default('reference'),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const searchMemorySchema = z.object({
  query: z.string().min(1).max(1024),
  types: z.array(z.enum(['conclusions', 'documents'])).default(['conclusions', 'documents']),
  limit: z.number().int().min(1).max(50).default(10),
  collection: z.string().optional(),
  minScore: z.number().min(0).max(1).optional(),
});
```

---

## Cross-References

| Spec | Relationship |
|---|---|
| [Memory Architecture](./architecture.md) | System design, data model mapping, service structure |
| [Memory Data Model](./data-model.md) | Honcho entity mapping, workspace/peer naming |
| [API Endpoints](../application/api/endpoints.md) | Parent API spec, route factory pattern |
| [Pagination](../application/api/pagination.md) | Platform pagination patterns |
| [Error Catalog](../application/errors/error-catalog.md) | Error architecture, `createError` pattern |
| [Settings](../application/api/endpoints.md#settings) | `memory.*` settings keys |
