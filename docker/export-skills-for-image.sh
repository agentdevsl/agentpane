#!/bin/bash
# Export cached skills and agents from the AgentPane database into files
# suitable for baking into the Docker image.
#
# Usage: ./docker/export-skills-for-image.sh [DB_PATH]
#
# Creates:
#   docker/skills-cache/{skillId}/SKILL.md
#   docker/agents-cache/{agentName}.md

set -euo pipefail

DB_PATH="${1:-./data/agentpane.db}"

if [ ! -f "$DB_PATH" ]; then
  echo "Database not found at $DB_PATH — skipping skill/agent export" >&2
  exit 0
fi

SKILLS_DIR="docker/skills-cache"
AGENTS_DIR="docker/agents-cache"

rm -rf "$SKILLS_DIR" "$AGENTS_DIR"
mkdir -p "$SKILLS_DIR" "$AGENTS_DIR"

# Export skills
skill_count=$(sqlite3 "$DB_PATH" "
  SELECT json_each.value
  FROM templates, json_each(cached_skills)
  WHERE templates.status = 'active' AND cached_skills IS NOT NULL
" | python3 -c "
import sys, json, os
count = 0
for line in sys.stdin:
    try:
        skill = json.loads(line.strip())
        sid = skill.get('id', skill.get('name', ''))
        if not sid:
            continue
        content = skill.get('content', '')
        name = skill.get('name', sid)
        desc = skill.get('description', '')
        os.makedirs(f'$SKILLS_DIR/{sid}', exist_ok=True)
        with open(f'$SKILLS_DIR/{sid}/SKILL.md', 'w') as f:
            f.write('---\n')
            f.write(f'name: \"{name}\"\n')
            if desc:
                f.write(f'description: \"{desc}\"\n')
            f.write('source: image\n')
            f.write('---\n')
            f.write(content)
        count += 1
    except Exception as e:
        print(f'Warning: failed to export skill: {e}', file=sys.stderr)
print(count)
" 2>/dev/null)

# Export agents
agent_count=$(sqlite3 "$DB_PATH" "
  SELECT json_each.value
  FROM templates, json_each(cached_agents)
  WHERE templates.status = 'active' AND cached_agents IS NOT NULL
" | python3 -c "
import sys, json, os
count = 0
for line in sys.stdin:
    try:
        agent = json.loads(line.strip())
        name = agent.get('name', '')
        if not name:
            continue
        content = agent.get('content', '')
        desc = agent.get('description', '')
        with open(f'$AGENTS_DIR/{name}.md', 'w') as f:
            f.write('---\n')
            f.write(f'name: \"{name}\"\n')
            if desc:
                f.write(f'description: \"{desc}\"\n')
            f.write('source: image\n')
            f.write('---\n')
            f.write(content)
        count += 1
    except Exception as e:
        print(f'Warning: failed to export agent: {e}', file=sys.stderr)
print(count)
" 2>/dev/null)

echo "Exported ${skill_count:-0} skills to $SKILLS_DIR"
echo "Exported ${agent_count:-0} agents to $AGENTS_DIR"
