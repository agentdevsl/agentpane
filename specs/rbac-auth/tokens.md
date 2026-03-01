# API Token Specification

## Overview

This specification defines the API token system for AgentPane's RBAC. API tokens provide programmatic access to the AgentPane API with fine-grained scoping. Tokens are issued to users and inherit (at most) the issuing user's permissions, subject to a role ceiling and optional project/tag restrictions.

**Design Principles**:

- **One-Time Display**: The raw token is shown to the user exactly once at creation time and is never retrievable afterward
- **Hash-Only Storage**: Only the SHA-256 hash of the token is stored in the database
- **Role Ceiling**: A token's effective permissions can never exceed its assigned role, regardless of the holder's actual role
- **Scoped by Default**: Tokens can be restricted to specific projects and/or tags
- **Auditable**: Every token usage updates `lastUsedAt` for monitoring

---

## Token Format

### Structure

```
ap_<32 random bytes encoded as base64url>
```

| Component | Description |
|-----------|-------------|
| `ap_` | Fixed prefix identifying AgentPane API tokens |
| Payload | 32 cryptographically random bytes encoded as base64url (no padding) |

**Total length**: ~47 characters (4-char prefix + 43-char base64url payload)

### Examples

```
ap_7G3kM9vPxQ2rT5wB8nH1jL4cF6dS0eA3iO7uY9
ap_Xm2Kp8RtWv4Qa6Nj0Gy1Lf3Hd5Bs7Ec9Iu0Ow2
```

### Generation

```typescript
// lib/rbac/token-utils.ts

import { randomBytes, createHash } from 'crypto';

const TOKEN_PREFIX = 'ap_';
const TOKEN_BYTE_LENGTH = 32;

/**
 * Generate a new API token.
 *
 * @returns The raw token string (show to user once) and its SHA-256 hash (store in DB).
 */
export function generateApiToken(): { rawToken: string; tokenHash: string; tokenPrefix: string } {
  const bytes = randomBytes(TOKEN_BYTE_LENGTH);
  const encoded = bytes.toString('base64url');
  const rawToken = `${TOKEN_PREFIX}${encoded}`;

  const tokenHash = hashToken(rawToken);
  const tokenPrefix = rawToken.substring(0, 12); // "ap_" + first 8 chars of payload

  return { rawToken, tokenHash, tokenPrefix };
}

/**
 * Compute the SHA-256 hash of a token for storage and lookup.
 */
export function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

/**
 * Validate the format of a raw token string.
 */
export function isValidTokenFormat(token: string): boolean {
  if (!token.startsWith(TOKEN_PREFIX)) return false;
  const payload = token.substring(TOKEN_PREFIX.length);
  // base64url: [A-Za-z0-9_-], length should be ~43 chars for 32 bytes
  return /^[A-Za-z0-9_-]{42,44}$/.test(payload);
}
```

---

## Storage Schema

### `api_tokens` Table

```typescript
// db/schema/api-tokens.ts

import { pgTable, text, timestamp, jsonb, boolean, integer } from 'drizzle-orm/pg-core';
import { createId } from '@paralleldrive/cuid2';

export const apiTokens = pgTable('api_tokens', {
  // Primary key
  id: text('id').primaryKey().$defaultFn(() => createId()),

  // Owner
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),

  // Token identification
  name: text('name').notNull(),                  // Human-readable name, e.g. "CI Pipeline"
  tokenHash: text('token_hash').notNull().unique(), // SHA-256 hex digest
  tokenPrefix: text('token_prefix').notNull(),   // First 12 chars for display ("ap_7G3kM9vP")

  // RBAC scoping
  role: text('role').notNull(),                  // Maximum role: 'admin' | 'agent_operator' | 'viewer'
  scopeProjectIds: jsonb('scope_project_ids')
    .$type<string[] | null>()
    .default(null),                              // null = all projects
  scopeTags: jsonb('scope_tags')
    .$type<string[] | null>()
    .default(null),                              // null = all tags

  // Status
  status: text('status').notNull().default('active'), // 'active' | 'revoked' | 'expired'

  // Expiry
  expiresAt: timestamp('expires_at'),            // null = never expires

  // Usage tracking
  lastUsedAt: timestamp('last_used_at'),
  useCount: integer('use_count').notNull().default(0),

  // Timestamps
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  revokedAt: timestamp('revoked_at'),
});

export type ApiToken = typeof apiTokens.$inferSelect;
export type NewApiToken = typeof apiTokens.$inferInsert;
```

### Indexes

```typescript
export const apiTokensIndexes = {
  hashIdx: index('api_tokens_hash_idx').on(apiTokens.tokenHash),     // Primary lookup path
  userIdx: index('api_tokens_user_idx').on(apiTokens.userId),
  statusIdx: index('api_tokens_status_idx').on(apiTokens.status),
};
```

### Storage Details

| Field | What's Stored | Purpose |
|-------|--------------|---------|
| `tokenHash` | SHA-256 hex digest of the full raw token | Lookup and authentication |
| `tokenPrefix` | First 12 characters of the raw token (`ap_` + 8 chars) | Display in UI for identification |
| `name` | User-provided label (e.g., "CI Pipeline", "Staging Deploy") | Human identification |

The raw token is **never** stored. After creation, it cannot be recovered. If lost, the user must create a new token.

---

## Token Lifecycle

### Creation

```typescript
// services/rbac-token.service.ts

import type { Database } from '@/types/database';
import type { RbacRole } from '@/lib/rbac/types';
import { ROLE_LEVELS } from '@/lib/rbac/types';
import { generateApiToken, isValidTokenFormat } from '@/lib/rbac/token-utils';
import { err, ok, type Result } from '@/lib/utils/result';

const MAX_TOKENS_PER_USER = 25;

export interface CreateTokenInput {
  userId: string;
  name: string;
  role: RbacRole;
  scopeProjectIds?: string[] | null;
  scopeTags?: string[] | null;
  expiresAt?: Date | null;
}

export interface CreateTokenResult {
  tokenId: string;
  rawToken: string;       // Shown ONCE to the user
  tokenPrefix: string;
  name: string;
  role: RbacRole;
  expiresAt: Date | null;
}

export type TokenError =
  | { code: 'TOKEN_LIMIT_EXCEEDED'; message: string }
  | { code: 'INVALID_ROLE'; message: string }
  | { code: 'INSUFFICIENT_ROLE'; message: string }
  | { code: 'NOT_FOUND'; message: string }
  | { code: 'ALREADY_REVOKED'; message: string }
  | { code: 'STORAGE_ERROR'; message: string };

export class RbacTokenService {
  constructor(private db: Database) {}

  /**
   * Create a new API token.
   *
   * The raw token is returned ONCE in the result.
   * The caller must display it to the user immediately.
   *
   * @param input - Token creation parameters
   * @param creatorRole - The role of the user creating the token
   * @returns The raw token (one-time) and metadata
   */
  async createToken(
    input: CreateTokenInput,
    creatorRole: RbacRole,
  ): Promise<Result<CreateTokenResult, TokenError>> {
    // Validate: token role cannot exceed creator's role
    if (ROLE_LEVELS[input.role] > ROLE_LEVELS[creatorRole]) {
      return err({
        code: 'INSUFFICIENT_ROLE',
        message: `Cannot create a token with role '${input.role}' — your role is '${creatorRole}'.`,
      });
    }

    // Validate: tokens cannot be scoped to 'owner' (ownership is not delegable via tokens)
    if (input.role === 'owner') {
      return err({
        code: 'INVALID_ROLE',
        message: 'API tokens cannot be assigned the owner role.',
      });
    }

    // Check token count limit
    const existingCount = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(apiTokens)
      .where(
        and(
          eq(apiTokens.userId, input.userId),
          ne(apiTokens.status, 'revoked'),
        )
      );

    if (existingCount[0].count >= MAX_TOKENS_PER_USER) {
      return err({
        code: 'TOKEN_LIMIT_EXCEEDED',
        message: `Maximum of ${MAX_TOKENS_PER_USER} active tokens per user. Revoke unused tokens first.`,
      });
    }

    // Generate token
    const { rawToken, tokenHash, tokenPrefix } = generateApiToken();

    // Store in database
    const [saved] = await this.db
      .insert(apiTokens)
      .values({
        userId: input.userId,
        name: input.name,
        tokenHash,
        tokenPrefix,
        role: input.role,
        scopeProjectIds: input.scopeProjectIds ?? null,
        scopeTags: input.scopeTags ?? null,
        expiresAt: input.expiresAt ?? null,
        status: 'active',
      })
      .returning();

    return ok({
      tokenId: saved.id,
      rawToken,               // <— show to user ONCE
      tokenPrefix,
      name: saved.name,
      role: input.role,
      expiresAt: input.expiresAt ?? null,
    });
  }
}
```

### Validation Flow

When an incoming request provides a Bearer token, the following validation flow executes:

```
1. Extract token from `Authorization: Bearer ap_xxx...` header
2. Validate format: must start with `ap_` and have valid base64url payload
3. Compute SHA-256 hash of the raw token
4. Look up `api_tokens` by `tokenHash`
5. Check `status`:
   - 'revoked' → 401 "Token has been revoked"
   - 'expired' → 401 "Token has expired"
   - 'active'  → proceed
6. Check `expiresAt`:
   - If set and in the past → update status to 'expired', return 401
7. Update `lastUsedAt` and increment `useCount` (non-blocking)
8. Resolve effective permissions using token's role and scope
```

### Validation Implementation

```typescript
// lib/rbac/token-validator.ts

import type { Database } from '@/types/database';
import { hashToken, isValidTokenFormat } from './token-utils';
import { err, ok, type Result } from '@/lib/utils/result';

export interface ValidatedToken {
  tokenId: string;
  userId: string;
  role: RbacRole;
  scopeProjectIds: string[] | null;
  scopeTags: string[] | null;
}

export type TokenValidationError =
  | { code: 'INVALID_FORMAT'; message: string }
  | { code: 'TOKEN_NOT_FOUND'; message: string }
  | { code: 'TOKEN_REVOKED'; message: string }
  | { code: 'TOKEN_EXPIRED'; message: string };

export async function validateApiToken(
  db: Database,
  rawToken: string,
): Promise<Result<ValidatedToken, TokenValidationError>> {
  // Step 1-2: Format validation
  if (!isValidTokenFormat(rawToken)) {
    return err({
      code: 'INVALID_FORMAT',
      message: 'Invalid API token format.',
    });
  }

  // Step 3: Hash the token
  const hash = hashToken(rawToken);

  // Step 4: Database lookup
  const token = await db.query.apiTokens.findFirst({
    where: eq(apiTokens.tokenHash, hash),
  });

  if (!token) {
    return err({
      code: 'TOKEN_NOT_FOUND',
      message: 'API token not recognized.',
    });
  }

  // Step 5: Status check
  if (token.status === 'revoked') {
    return err({
      code: 'TOKEN_REVOKED',
      message: 'This API token has been revoked.',
    });
  }

  // Step 6: Expiry check
  if (token.expiresAt && new Date(token.expiresAt) < new Date()) {
    // Update status to expired (fire-and-forget)
    db.update(apiTokens)
      .set({ status: 'expired', updatedAt: new Date() })
      .where(eq(apiTokens.id, token.id))
      .catch(() => {}); // Best effort

    return err({
      code: 'TOKEN_EXPIRED',
      message: 'This API token has expired.',
    });
  }

  // Step 7: Update usage tracking (non-blocking)
  db.update(apiTokens)
    .set({
      lastUsedAt: new Date(),
      useCount: sql`${apiTokens.useCount} + 1`,
    })
    .where(eq(apiTokens.id, token.id))
    .catch(() => {}); // Best effort

  // Step 8: Return validated token data
  return ok({
    tokenId: token.id,
    userId: token.userId,
    role: token.role as RbacRole,
    scopeProjectIds: token.scopeProjectIds,
    scopeTags: token.scopeTags,
  });
}
```

### Integration with `authMiddleware`

The existing `getAuthContext()` in `src/lib/api/auth-middleware.ts` accepts an `AuthOptions.validateApiKey` callback. The RBAC token validator plugs into this:

```typescript
// In src/server/router.ts or auth setup:

import { validateApiToken } from '@/lib/rbac/token-validator';

const authOptions: AuthOptions = {
  validateApiKey: async (bearerToken: string): Promise<string | null> => {
    const result = await validateApiToken(db, bearerToken);
    if (!result.ok) return null;

    // Store token metadata for downstream middleware
    // (enrichAuthContext reads this in step 3)
    tokenCache.set(result.value.userId, result.value);

    return result.value.userId;
  },
};
```

---

## Revocation

Tokens can be revoked by the token owner or any admin:

```typescript
/**
 * Revoke an API token. This is irreversible.
 */
async revokeToken(
  tokenId: string,
  revokerId: string,
): Promise<Result<void, TokenError>> {
  const token = await this.db.query.apiTokens.findFirst({
    where: eq(apiTokens.id, tokenId),
  });

  if (!token) {
    return err({ code: 'NOT_FOUND', message: 'Token not found.' });
  }

  if (token.status === 'revoked') {
    return err({ code: 'ALREADY_REVOKED', message: 'Token is already revoked.' });
  }

  await this.db
    .update(apiTokens)
    .set({
      status: 'revoked',
      revokedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(apiTokens.id, tokenId));

  return ok(undefined);
}
```

---

## Token Listing

Users can list their own tokens. Admins can list all tokens for the team:

```typescript
export interface TokenListItem {
  id: string;
  name: string;
  tokenPrefix: string;    // "ap_7G3kM9vP" — for user identification
  role: RbacRole;
  scopeProjectIds: string[] | null;
  scopeTags: string[] | null;
  status: 'active' | 'revoked' | 'expired';
  expiresAt: string | null;
  lastUsedAt: string | null;
  useCount: number;
  createdAt: string;
}
```

The `rawToken` is never included in list responses. Only the `tokenPrefix` is shown so users can identify which token is which.

---

## Scoping

### Role Ceiling

The token's `role` field acts as a ceiling on the effective permissions:

```
effective_role = min(user_membership_role, token_role)
```

Tokens cannot be created with the `owner` role. The maximum token role is `admin`.

| Token Role | User's Membership Role | Effective Role |
|-----------|----------------------|----------------|
| `admin` | `owner` | `admin` |
| `admin` | `admin` | `admin` |
| `agent_operator` | `admin` | `agent_operator` |
| `viewer` | `agent_operator` | `viewer` |
| `agent_operator` | `viewer` | `viewer` |

### Project Restriction

When `scopeProjectIds` is set (non-null), the token can only access the listed projects. Requests targeting other projects receive a 403 response.

```typescript
// In requireRole middleware:
if (auth.tokenScope?.projectIds !== null) {
  if (!auth.tokenScope.projectIds.includes(projectId)) {
    return 403; // "API token is not authorized for this project."
  }
}
```

When `scopeProjectIds` is `null`, the token can access all projects the user has membership to.

### Tag Restriction

When `scopeTags` is set (non-null), the token can only access resources whose tags overlap with the allowed set. This is enforced by the `requireTagAccess()` middleware.

```typescript
// Example: Token scoped to tags ["frontend", "ui"]
// Task with labels ["frontend", "auth"] → ALLOWED (overlap: "frontend")
// Task with labels ["backend", "api"]   → DENIED (no overlap)
// Task with labels []                   → ALLOWED (untagged resources are unrestricted)
```

When `scopeTags` is `null`, no tag filtering is applied.

---

## Rate Limiting

API tokens inherit the global rate limiter configured in `src/server/router.ts`:

```typescript
app.use('/api/*', rateLimiter({ max: 200, windowMs: 60_000 }));
```

Rate limiting is applied per-token (using the token hash as the identifier) rather than per-user when the request is authenticated via an API token. This prevents a single token from consuming another token's rate limit budget.

```typescript
// In rate limiter configuration:
function getRateLimitKey(c: Context): string {
  const auth = c.get('auth') as AuthContext | undefined;
  if (auth?.tokenScope?.tokenId) {
    return `token:${auth.tokenScope.tokenId}`;
  }
  if (auth?.userId) {
    return `user:${auth.userId}`;
  }
  return `ip:${c.req.header('x-forwarded-for') ?? 'unknown'}`;
}
```

---

## Token Statuses

| Status | Description | Transitions |
|--------|-------------|-------------|
| `active` | Token is valid and can be used for authentication | Can transition to `revoked` or `expired` |
| `revoked` | Token was manually revoked by owner or admin. Irreversible. | Terminal state |
| `expired` | Token's `expiresAt` timestamp has passed. Set lazily on next use. | Terminal state |

### Status Transition Diagram

```
                  ┌──────────┐
  (creation) ───▶ │  active  │
                  └────┬─────┘
                       │
              ┌────────┴────────┐
              ▼                 ▼
        ┌──────────┐     ┌──────────┐
        │ revoked  │     │ expired  │
        └──────────┘     └──────────┘
        (terminal)       (terminal)
```

---

## Constraints

| Constraint | Value | Rationale |
|-----------|-------|-----------|
| Max tokens per user | 25 | Prevent token sprawl; encourages cleanup |
| Max token role | `admin` | Owner privileges cannot be delegated via tokens |
| Token name max length | 100 chars | Display limitation |
| Token name uniqueness | Per-user | Users cannot have two tokens with the same name |
| Minimum token length | 46 chars | `ap_` + 42-char base64url minimum |
| Hash algorithm | SHA-256 | Industry standard, resistant to pre-image attacks |

---

## API Endpoints

### Create Token

```
POST /api/keys
```

**Request Body:**

```typescript
{
  name: string;                     // Human-readable label
  role: 'admin' | 'agent_operator' | 'viewer';
  scopeProjectIds?: string[];       // Omit or null for all projects
  scopeTags?: string[];             // Omit or null for all tags
  expiresAt?: string;               // ISO 8601 timestamp, omit for no expiry
}
```

**Response (201):**

```json
{
  "ok": true,
  "data": {
    "id": "clx1234567890",
    "rawToken": "ap_<base64url-random-token>",
    "tokenPrefix": "ap_7G3kM9vP",
    "name": "CI Pipeline",
    "role": "agent_operator",
    "scopeProjectIds": ["clx_project_1"],
    "scopeTags": null,
    "expiresAt": "2027-01-01T00:00:00Z",
    "createdAt": "2026-02-26T12:00:00Z"
  }
}
```

**Important**: The `rawToken` field is only present in the creation response. It is never returned again.

### List Tokens

```
GET /api/keys
```

**Response (200):**

```json
{
  "ok": true,
  "data": {
    "items": [
      {
        "id": "clx1234567890",
        "name": "CI Pipeline",
        "tokenPrefix": "ap_7G3kM9vP",
        "role": "agent_operator",
        "scopeProjectIds": ["clx_project_1"],
        "scopeTags": null,
        "status": "active",
        "expiresAt": "2027-01-01T00:00:00Z",
        "lastUsedAt": "2026-02-26T15:30:00Z",
        "useCount": 142,
        "createdAt": "2026-02-26T12:00:00Z"
      }
    ]
  }
}
```

### Revoke Token

```
DELETE /api/keys/:id
```

**Response (200):**

```json
{
  "ok": true,
  "data": { "revoked": true }
}
```

---

## Security Considerations

### Token Storage

- Raw tokens are **never** stored server-side. Only the SHA-256 hash is persisted.
- The `tokenPrefix` field stores enough characters for human identification but not enough to reconstruct the token.
- Database backups do not expose usable tokens.

### Token Transmission

- Tokens should only be transmitted over HTTPS (TLS).
- Tokens should not be included in URL query parameters (they may be logged).
- Tokens should be sent in the `Authorization: Bearer <token>` header.

### Token Display

- The raw token is displayed exactly once in the UI after creation.
- The UI should provide a "Copy to clipboard" button and warn that the token cannot be retrieved again.
- After the creation dialog is closed, only the `tokenPrefix` is visible.

### Rotation

- There is no automatic token rotation. Users should manually create a new token and revoke the old one.
- The 25-token limit encourages regular cleanup of unused tokens.
- Tokens with `expiresAt` set will automatically become unusable after expiry.

### Audit Trail

All token operations are logged:

| Event | Details Logged |
|-------|---------------|
| Token created | Token ID, name, role, scope, creator |
| Token used | Token ID, endpoint accessed, timestamp |
| Token revoked | Token ID, revoker, timestamp |
| Token expired | Token ID, expiry timestamp |
| Token validation failed | Token prefix (if available), reason |

---

## Cross-References

| Spec | Relationship |
|------|--------------|
| [Roles & Permissions](./roles-permissions.md) | Role hierarchy and resolution algorithm |
| [Middleware](./middleware.md) | enrichAuthContext hydrates tokenScope; requireRole applies ceiling |
| [Auth Middleware](../../src/lib/api/auth-middleware.ts) | Existing validateApiKey callback for token validation |
| [API Key Service](../../src/services/api-key.service.ts) | Existing service for third-party API keys (different from RBAC tokens) |
| [Rate Limiter](../../src/lib/api/rate-limiter.ts) | Per-token rate limiting |
| [Database Schema](../application/database/schema.md) | Existing schema this extends |
