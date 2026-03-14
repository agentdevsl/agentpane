# Authentication Flow

GitHub OAuth login with session-based authentication and RBAC role resolution. API access is protected by auth middleware that supports session cookies, API tokens (RBAC tokens), and a dev-mode bypass.

```mermaid
sequenceDiagram
    participant User as Browser
    participant App as AgentPane Frontend
    participant API as Bun API :3001
    participant GH as GitHub OAuth
    participant DB as SQLite DB
    participant RBAC as RbacService

    Note over User,RBAC: Login Flow

    User->>App: Click "Sign in with GitHub"
    App->>API: GET /api/auth/github
    API->>API: Generate random state token
    API->>User: Set oauth_state cookie (CSRF)
    API->>User: 302 Redirect to GitHub

    User->>GH: Authorize AgentPane app
    GH->>User: 302 Redirect to callback with code + state

    User->>API: GET /api/auth/github/callback?code=...&state=...
    API->>API: Verify state matches oauth_state cookie
    API->>GH: POST /login/oauth/access_token (exchange code)
    GH-->>API: access_token

    API->>GH: GET /api/user (fetch profile)
    GH-->>API: {id, login, name, email, avatar_url}

    API->>DB: Upsert user (by github_id)
    API->>DB: Insert user_session (hashed token, 30d expiry)
    API->>User: Set agentpane_session cookie + redirect to app

    Note over User,RBAC: Authenticated API Request

    User->>App: Navigate / interact
    App->>API: GET /api/projects (with session cookie)
    API->>API: Extract token from cookie
    API->>DB: Validate session (hash lookup, check expiry)
    DB-->>API: userId

    API->>RBAC: resolveUserRole(userId, projectId)

    alt Direct project member
        RBAC->>DB: Query project_members
        DB-->>RBAC: role override
    else Team membership
        RBAC->>DB: JOIN team_members + team_projects
        DB-->>RBAC: highest role across linked teams
    end

    RBAC-->>API: effective role (viewer|agent_operator|admin|owner)
    API->>API: canPerformAction(role, action)?

    alt Authorized
        API-->>App: 200 JSON response
    else Forbidden
        API-->>App: 403 Forbidden
    end

    Note over User,RBAC: API Token (RBAC Token) Flow

    App->>API: GET /api/... (Authorization: Bearer <token>)
    API->>DB: Validate rbac_token (hash lookup, check expiry)
    DB-->>API: token record (role ceiling, project scope, tags)
    API->>RBAC: resolveUserRole(token.userId, projectId)
    RBAC-->>API: membership role
    API->>API: applyTokenCeiling(membershipRole, tokenRole)
    API->>API: checkProjectScope + checkTagAccess

    Note over User,RBAC: Logout

    User->>App: Click logout
    App->>API: POST /api/auth/logout
    API->>DB: DELETE user_session
    API->>User: Clear agentpane_session cookie
```

## RBAC Permission Matrix

| Role | Level | Example Permissions |
|------|-------|-------------------|
| **viewer** | 10 | Read projects, tasks, sessions, agents |
| **agent_operator** | 20 | Create/update tasks, start/stop agents, approve plans |
| **admin** | 30 | Create/delete projects, manage members, update settings |
| **owner** | 40 | Delete team, transfer ownership |

## Role Resolution Order

1. **Direct project_members override** -- if the user has a row in `project_members` for this project, use that role
2. **Team membership via team_projects** -- JOIN `team_members` with `team_projects`, take the highest role across all linked teams
3. **No membership found** -- deny access (return null)

## API Token Scoping

RBAC tokens support three scoping mechanisms:
- **Role ceiling**: effective role = min(membership role, token role)
- **Project scope**: token can be restricted to a single project
- **Tag access**: token scope tags must overlap with resource tags
