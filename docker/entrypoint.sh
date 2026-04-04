#!/bin/bash
# Entrypoint script for agent-sandbox container
# Fixes workspace permissions for bind-mounted volumes

set -e

# Fix workspace permissions if they're not writable by current user
if [ -d /workspace ] && [ ! -w /workspace ]; then
    # Try to fix permissions (will only work if running as root or with sudo)
    sudo chown -R node:node /workspace 2>/dev/null || \
    chown -R node:node /workspace 2>/dev/null || \
    echo "[entrypoint] Warning: Could not fix /workspace permissions" >&2
fi

# Ensure .claude directories exist for SDK (plans, credentials, etc.)
mkdir -p /home/node/.claude/plans 2>/dev/null || true

# Populate workspace with cached skills and agents from image if not already present.
# Skills/agents baked into the image at build time provide fast startup;
# runtime injection from the DB can override or add new ones.
if [ -d /opt/skills-cache ] && [ -d /workspace ]; then
    mkdir -p /workspace/.claude/skills 2>/dev/null || true
    for skill_dir in /opt/skills-cache/*/; do
        skill_name="$(basename "$skill_dir")"
        if [ ! -d "/workspace/.claude/skills/$skill_name" ]; then
            cp -r "$skill_dir" "/workspace/.claude/skills/$skill_name" 2>/dev/null || true
        fi
    done
fi

if [ -d /opt/agents-cache ] && [ -d /workspace ]; then
    mkdir -p /workspace/.claude/agents 2>/dev/null || true
    for agent_file in /opt/agents-cache/*.md; do
        [ -f "$agent_file" ] || continue
        agent_name="$(basename "$agent_file")"
        if [ ! -f "/workspace/.claude/agents/$agent_name" ]; then
            cp "$agent_file" "/workspace/.claude/agents/$agent_name" 2>/dev/null || true
        fi
    done
fi

# Copy workspace directories from image cache (used by skill workflows)
for cache_pair in "foundations-cache:.foundations" "github-cache:.github" "dot-agents-cache:.agents"; do
    cache_dir="/opt/${cache_pair%%:*}"
    target_dir="/workspace/${cache_pair#*:}"
    if [ -d "$cache_dir" ] && [ -d /workspace ] && [ ! -d "$target_dir" ]; then
        cp -r "$cache_dir" "$target_dir" 2>/dev/null || true
    fi
done

# Execute the command
exec "$@"
