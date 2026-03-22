# Sandbox Architecture

Multi-provider sandbox system for isolated agent execution. The `SandboxService` manages container lifecycle (create, idle-check, stop) while the `ContainerAgentService` orchestrates agent processes inside those containers — including skill injection from org/template configurations — via stdout event bridging or SSE invocation.

```mermaid
flowchart TB
    TASK["Task moved to in_progress"]
    CAS["ContainerAgentService<br/><i>container-agent.service.ts</i>"]
    SS["SandboxService<br/><i>sandbox.service.ts</i>"]
    CREDS["CredentialsInjector<br/><i>OAuth token -> ~/.claude/.credentials.json</i>"]
    SKILLS["SkillInjector<br/><i>skill-injector.ts</i><br/><small>org/template skills → .claude/skills/</small>"]
    PS{{"Provider Selection<br/><i>SandboxProvider interface</i>"}}

    TASK --> CAS
    CAS --> SS
    SS --> CREDS
    CREDS --> SKILLS
    SKILLS --> PS

    PS --> DOCKER
    PS --> NOMAD
    PS --> K8S
    PS --> AGENTCORE
    PS --> DEVCONT

    subgraph DOCKER ["DockerProvider"]
        direction TB
        D1["docker-provider.ts"]
        D2["Dockerode API"]
        D3["agent-sandbox container<br/><i>Dockerfile.agent-sandbox</i>"]
        D1 --> D2 --> D3
    end

    subgraph NOMAD ["NomadSandboxProvider"]
        direction TB
        N1["nomad-sandbox-provider.ts"]
        N2["Nomad HTTP API"]
        N3["Nomad job allocation"]
        N1 --> N2 --> N3
    end

    subgraph K8S ["K8sProvider (archived)"]
        direction TB
        K1["k8s-provider.ts"]
        K2["@kubernetes/client-node"]
        K3["K8s Pod"]
        K1 --> K2 --> K3
    end

    subgraph AGENTCORE ["AgentCoreProvider"]
        direction TB
        AC1["agentcore-sandbox-provider.ts"]
        AC2["AWS Bedrock AgentCore API"]
        AC3["Firecracker microVM<br/><i>Dockerfile.agentcore</i>"]
        AC1 --> AC2 --> AC3
    end

    subgraph DEVCONT ["AgentSandboxProvider"]
        direction TB
        DC1["agent-sandbox-provider.ts"]
        DC2["DevContainer CLI"]
        DC3["Dev Container"]
        DC1 --> DC2 --> DC3
    end

    subgraph Container ["Inside Sandbox Container"]
        direction TB
        ENTRY["entrypoint.sh<br/><i>fix permissions</i>"]
        RUNNER["Agent Runner<br/><i>/opt/agent-runner/dist/index.js</i>"]
        CLI["Claude Code CLI<br/><i>claude-agent-sdk</i>"]
        WS["/workspace<br/><i>bind-mounted project dir</i>"]
        SKILLDIR[".claude/skills/<br/><i>materialized skill files</i>"]
        ENTRY --> RUNNER
        RUNNER --> CLI
        CLI --> WS
        CLI --> SKILLDIR
    end

    D3 --> Container
    N3 --> Container
    K3 --> Container
    DC3 --> Container

    RUNNER -- "stdout JSON events" --> CAS
    CAS -- "bridge events" --> DS["DurableStreamsService"]

    style TASK fill:#7c3aed,color:#fff
    style Container fill:#1e3a5f,color:#e2e8f0
```

## Provider Comparison

| Provider | Runtime | Isolation | Use Case |
|----------|---------|-----------|----------|
| DockerProvider | Docker Engine / OrbStack | Container | Local dev, single-machine deployment |
| NomadSandboxProvider | HashiCorp Nomad | Job allocation | Multi-node orchestration |
| K8sProvider | Kubernetes | Pod | Cloud-native orchestration (archived) |
| AgentCoreProvider | AWS Bedrock AgentCore | Firecracker microVM | Managed AWS runtime, SSE invoke |
| AgentSandboxProvider | DevContainer CLI | Dev Container | IDE-integrated sandboxes |

## Container Configuration

Defaults from `SANDBOX_DEFAULTS`:
- **Image**: `srlynch1/agent-sandbox:latest`
- **Memory**: configurable per-codespace
- **CPU**: configurable per-codespace
- **Idle timeout**: auto-stop after inactivity (checked every 5 minutes)
- **Volume mounts**: project path bind-mounted to `/workspace`
- **Security**: non-root `node` user, limited sudo, `git safe.directory *`
- **Skill injection**: org/template skills materialized to `/workspace/.claude/skills/{skillId}/SKILL.md` before agent execution (non-fatal on failure)
