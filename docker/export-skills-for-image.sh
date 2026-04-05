#!/bin/bash
# Export cached skills, agents, and foundations from the AgentPane database
# and org repos into files suitable for baking into the Docker image.
#
# Usage: ./docker/export-skills-for-image.sh [DB_PATH]
#
# Creates:
#   docker/skills-cache/{skillId}/SKILL.md
#   docker/agents-cache/{agentName}.md
#   docker/foundations-cache/  (cloned from org repo)

set -euo pipefail

DB_PATH="${1:-./data/agentpane.db}"

if [ ! -f "$DB_PATH" ]; then
  echo "Database not found at $DB_PATH — skipping skill/agent export" >&2
  exit 0
fi

SKILLS_DIR="docker/skills-cache"
AGENTS_DIR="docker/agents-cache"
FOUNDATIONS_DIR="docker/foundations-cache"

rm -rf "$SKILLS_DIR" "$AGENTS_DIR" "$FOUNDATIONS_DIR"
mkdir -p "$SKILLS_DIR" "$AGENTS_DIR"

# Export skills
skill_count=$(sqlite3 "$DB_PATH" "
  SELECT json_each.value
  FROM templates, json_each(cached_skills)
  WHERE templates.status = 'active' AND cached_skills IS NOT NULL
" | python3 -c "
import sys, json, os, re
safe_pattern = re.compile(r'^[a-zA-Z0-9][a-zA-Z0-9_-]*$')
def escape_yaml(s):
    return s.replace('\\\\', '\\\\\\\\').replace('\"', '\\\\\"').replace('\\n', '\\\\n').replace('\\r', '\\\\r')
count = 0
for line in sys.stdin:
    try:
        skill = json.loads(line.strip())
        sid = skill.get('id', skill.get('name', ''))
        if not sid:
            continue
        if not safe_pattern.match(sid):
            print(f'Warning: unsafe skill ID rejected: {sid}', file=sys.stderr)
            continue
        content = skill.get('content', '')
        name = skill.get('name', sid)
        desc = skill.get('description', '')
        exec_skill = skill.get('executionSkill', '')
        os.makedirs(f'$SKILLS_DIR/{sid}', exist_ok=True)
        with open(f'$SKILLS_DIR/{sid}/SKILL.md', 'w') as f:
            f.write('---\n')
            f.write(f'name: \"{escape_yaml(name)}\"\n')
            if desc:
                f.write(f'description: \"{escape_yaml(desc)}\"\n')
            f.write('source: image\n')
            if exec_skill:
                f.write(f'executionSkill: {escape_yaml(exec_skill)}\n')
            f.write('---\n')
            f.write(content)
        count += 1
    except Exception as e:
        print(f'Warning: failed to export skill: {e}', file=sys.stderr)
print(count)
")

# Export agents
agent_count=$(sqlite3 "$DB_PATH" "
  SELECT json_each.value
  FROM templates, json_each(cached_agents)
  WHERE templates.status = 'active' AND cached_agents IS NOT NULL
" | python3 -c "
import sys, json, os, re
safe_pattern = re.compile(r'^[a-zA-Z0-9][a-zA-Z0-9_-]*$')
def escape_yaml(s):
    return s.replace('\\\\', '\\\\\\\\').replace('\"', '\\\\\"').replace('\\n', '\\\\n').replace('\\r', '\\\\r')
count = 0
for line in sys.stdin:
    try:
        agent = json.loads(line.strip())
        name = agent.get('name', '')
        if not name:
            continue
        if not safe_pattern.match(name):
            print(f'Warning: unsafe agent name rejected: {name}', file=sys.stderr)
            continue
        content = agent.get('content', '')
        desc = agent.get('description', '')
        with open(f'$AGENTS_DIR/{name}.md', 'w') as f:
            f.write('---\n')
            f.write(f'name: \"{escape_yaml(name)}\"\n')
            if desc:
                f.write(f'description: \"{escape_yaml(desc)}\"\n')
            f.write('source: image\n')
            f.write('---\n')
            f.write(content)
        count += 1
    except Exception as e:
        print(f'Warning: failed to export agent: {e}', file=sys.stderr)
print(count)
")

echo "Exported ${skill_count:-0} skills to $SKILLS_DIR"
echo "Exported ${agent_count:-0} agents to $AGENTS_DIR"

# Export .foundations, .github, and .agents from the org repo
# These are referenced by skill workflows but not synced via the template system
REPO_OWNER=$(sqlite3 "$DB_PATH" "SELECT github_owner FROM templates WHERE status='active' LIMIT 1" 2>/dev/null)
REPO_NAME=$(sqlite3 "$DB_PATH" "SELECT github_repo FROM templates WHERE status='active' LIMIT 1" 2>/dev/null)
REPO_BRANCH=$(sqlite3 "$DB_PATH" "SELECT branch FROM templates WHERE status='active' LIMIT 1" 2>/dev/null)

if [ -n "$REPO_OWNER" ] && [ -n "$REPO_NAME" ]; then
  echo "Cloning workspace files from ${REPO_OWNER}/${REPO_NAME}@${REPO_BRANCH:-main}..."
  TEMP_CLONE=$(mktemp -d)
  if git clone --depth 1 --branch "${REPO_BRANCH:-main}" \
    "https://github.com/${REPO_OWNER}/${REPO_NAME}.git" "$TEMP_CLONE" 2>/dev/null; then

    # Copy workspace directories into cache (names avoid conflict with agents-cache)
    for pair in ".foundations:foundations-cache" ".github:github-cache" ".agents:dot-agents-cache"; do
      src_dir="${pair%%:*}"
      cache_name="${pair#*:}"
      if [ -d "$TEMP_CLONE/$src_dir" ]; then
        cp -r "$TEMP_CLONE/$src_dir" "docker/$cache_name"
        echo "Exported $src_dir to docker/$cache_name"
      else
        echo "No $src_dir directory in repo — skipping"
      fi
    done

    # Copy MCP config and Claude settings (these go to workspace root)
    mkdir -p docker/claude-config-cache
    for f in .mcp.json .mcp-ci.json; do
      if [ -f "$TEMP_CLONE/$f" ]; then
        cp "$TEMP_CLONE/$f" "docker/claude-config-cache/$f"
        echo "Exported $f"
      fi
    done
    # Copy .claude/settings.local.json and CLAUDE.md
    if [ -f "$TEMP_CLONE/.claude/settings.local.json" ]; then
      cp "$TEMP_CLONE/.claude/settings.local.json" "docker/claude-config-cache/settings.local.json"
      echo "Exported .claude/settings.local.json"
    fi
    if [ -f "$TEMP_CLONE/.claude/CLAUDE.md" ]; then
      cp "$TEMP_CLONE/.claude/CLAUDE.md" "docker/claude-config-cache/CLAUDE.md"
      echo "Exported .claude/CLAUDE.md"
    fi
  else
    echo "Warning: could not clone ${REPO_OWNER}/${REPO_NAME} — foundations/github/agents will be missing" >&2
  fi
  rm -rf "$TEMP_CLONE"
fi
