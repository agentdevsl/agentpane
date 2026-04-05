import { BookOpen, MagnifyingGlass, Tag } from '@phosphor-icons/react';
import { useCallback, useMemo, useState } from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/app/components/ui/select.js';
import { useWatchEffect } from '@/app/hooks/use-watch-effect.js';
import { apiClient } from '@/lib/api/client.js';
import { cn } from '@/lib/utils/cn.js';

// ============================================================================
// TYPES
// ============================================================================

interface Skill {
  id: string;
  name: string;
  description: string;
  tags?: string[];
  sourceType: 'local' | 'project' | 'org';
  sourceName: string;
  executionSkill?: string;
}

export interface SkillChangeEvent {
  skillId: string | null;
  skillName: string | null;
  executionSkillId: string | null;
  executionSkillName: string | null;
}

export interface SkillPickerProps {
  /** Codespace to fetch skills for */
  codespaceId: string;
  /** Currently selected skill ID */
  value: string | null;
  /** Called when skill selection changes */
  onChange: (
    skillId: string | null,
    skillName: string | null,
    executionSkill?: SkillChangeEvent
  ) => void;
  /** Additional CSS classes */
  className?: string;
  /** Compact display mode */
  compact?: boolean;
  /** Test ID */
  'data-testid'?: string;
}

// ============================================================================
// SOURCE TYPE LABELS
// ============================================================================

const SOURCE_TYPE_LABELS: Record<string, string> = {
  org: 'Organization',
  project: 'Project',
  local: 'Local',
};

const SOURCE_TYPE_ORDER: string[] = ['org', 'project', 'local'];

// ============================================================================
// HELPERS
// ============================================================================

/** Collect all unique tags from a list of skills, sorted alphabetically. */
function collectUniqueTags(skills: Skill[]): string[] {
  const tagSet = new Set<string>();
  for (const skill of skills) {
    if (skill.tags) {
      for (const tag of skill.tags) {
        tagSet.add(tag);
      }
    }
  }
  return Array.from(tagSet).sort();
}

/** Filter skills to only those matching ALL selected tags (AND logic). */
function filterByTags(skills: Skill[], selectedTags: Set<string>): Skill[] {
  if (selectedTags.size === 0) return skills;
  return skills.filter((skill) => {
    if (!skill.tags) return false;
    for (const tag of selectedTags) {
      if (!skill.tags.includes(tag)) return false;
    }
    return true;
  });
}

// ============================================================================
// COMPONENT
// ============================================================================

/**
 * Skill picker dropdown.
 * Fetches available skills for a codespace and lets users select one.
 * Skills are grouped by sourceType (org / project / local).
 * Supports optional tag-based filtering when skills have tags.
 */
export function SkillPicker({
  codespaceId,
  value,
  onChange,
  className,
  compact = false,
  'data-testid': testId = 'skill-picker',
}: SkillPickerProps): React.JSX.Element | null {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');

  // Fetch skills when codespaceId changes
  useWatchEffect(() => {
    if (!codespaceId) return;

    let cancelled = false;
    setIsLoading(true);

    apiClient.codespaces
      .getSkills(codespaceId)
      .then((result) => {
        if (cancelled) return;
        if (result.ok) {
          setSkills(result.data as Skill[]);
          setSelectedTags(new Set());
        } else {
          console.error('[SkillPicker] Failed to fetch skills:', result.error);
        }
      })
      .catch((error) => {
        if (!cancelled) console.error('[SkillPicker] Unexpected error:', error);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [codespaceId]);

  // Collect all unique tags from fetched skills
  const allTags = useMemo(() => collectUniqueTags(skills), [skills]);

  // Filter skills by selected tags
  const filteredSkills = useMemo(() => filterByTags(skills, selectedTags), [skills, selectedTags]);

  // Group filtered skills by sourceType
  const groupedSkills = useMemo(() => {
    const groups: Record<string, Skill[]> = {};
    for (const skill of filteredSkills) {
      const key = skill.sourceType;
      if (!groups[key]) groups[key] = [];
      groups[key].push(skill);
    }
    // Return groups sorted by SOURCE_TYPE_ORDER
    return SOURCE_TYPE_ORDER.filter((key) => groups[key]?.length).map((key) => ({
      sourceType: key,
      label: SOURCE_TYPE_LABELS[key] ?? key,
      items: groups[key] ?? [],
    }));
  }, [filteredSkills]);

  // Apply search query on top of tag-filtered grouped skills
  const displayedGroups = useMemo(() => {
    if (!searchQuery.trim()) return groupedSkills;
    const q = searchQuery.toLowerCase().trim();
    return groupedSkills
      .map((group) => ({
        ...group,
        items: group.items.filter(
          (s) => s.name.toLowerCase().includes(q) || s.description?.toLowerCase().includes(q)
        ),
      }))
      .filter((group) => group.items.length > 0);
  }, [groupedSkills, searchQuery]);

  // Toggle a tag filter
  const toggleTag = useCallback((tag: string) => {
    setSelectedTags((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) {
        next.delete(tag);
      } else {
        next.add(tag);
      }
      return next;
    });
  }, []);

  // Get display name for current value
  const getDisplayValue = () => {
    if (!value) return 'No skill';
    const skill = skills.find((s) => s.id === value);
    return skill?.name ?? value;
  };

  // Don't render if no skills available and nothing selected
  if (!isLoading && skills.length === 0 && !value) {
    return null;
  }

  return (
    <Select
      value={value ?? '__none__'}
      onValueChange={(v) => {
        if (v === '__none__') {
          onChange(null, null, {
            skillId: null,
            skillName: null,
            executionSkillId: null,
            executionSkillName: null,
          });
        } else {
          const skill = skills.find((s) => s.id === v);
          const execSkill = skill?.executionSkill
            ? skills.find((s) => s.id === skill.executionSkill)
            : undefined;
          onChange(v, skill?.name ?? v, {
            skillId: v,
            skillName: skill?.name ?? v,
            executionSkillId: skill?.executionSkill ?? null,
            executionSkillName: execSkill?.name ?? skill?.executionSkill ?? null,
          });
        }
      }}
    >
      <SelectTrigger
        className={cn('min-w-[180px]', compact && 'h-8', className)}
        data-testid={testId}
      >
        <div className="flex items-center gap-2">
          <BookOpen className="h-4 w-4 text-fg-muted flex-shrink-0" />
          <SelectValue placeholder={getDisplayValue()}>{getDisplayValue()}</SelectValue>
        </div>
      </SelectTrigger>
      <SelectContent className="max-w-[480px]">
        {/* Search input */}
        <div className="px-2 py-1.5 border-b border-border">
          <div className="relative">
            <MagnifyingGlass className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-muted" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
              placeholder="Search skills…"
              className="w-full rounded-md border border-border bg-surface-subtle py-1 pl-7 pr-2 text-xs text-fg placeholder:text-fg-subtle focus:border-accent focus:outline-none"
            />
          </div>
        </div>

        {/* No skill option */}
        <SelectItem value="__none__" className="flex flex-col items-start">
          <div className="font-medium">No skill</div>
          <div className="text-[11px] text-fg-muted">Run without a specific skill</div>
        </SelectItem>

        {/* Tag filter chips — only shown when tags exist */}
        {allTags.length > 0 && (
          <div className="px-2 py-1.5 flex flex-wrap gap-1 border-b border-border">
            <Tag className="h-3 w-3 text-fg-subtle flex-shrink-0 mt-0.5" weight="bold" />
            {allTags.map((tag) => (
              <button
                key={tag}
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  toggleTag(tag);
                }}
                className={cn(
                  'inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors',
                  'border cursor-pointer select-none',
                  selectedTags.has(tag)
                    ? 'bg-accent-subtle border-accent text-accent'
                    : 'bg-surface-subtle border-border text-fg-muted hover:border-fg-subtle'
                )}
              >
                {tag}
              </button>
            ))}
          </div>
        )}

        {/* Grouped skills */}
        {displayedGroups.map((group) => (
          <div key={group.sourceType}>
            {/* Group header */}
            <div className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-fg-subtle border-b border-border/50">
              {group.label}
            </div>
            {group.items.map((skill) => (
              <SelectItem
                key={skill.id}
                value={skill.id}
                className="flex flex-col items-start border-b border-border/30 last:border-b-0"
              >
                <div className="font-medium text-[13px]">{skill.name}</div>
                {skill.description && (
                  <div className="text-[11px] text-fg-muted line-clamp-2 leading-relaxed mt-0.5">
                    {skill.description}
                  </div>
                )}
                {skill.executionSkill && (
                  <div className="text-[10px] text-accent mt-0.5">
                    {'→ '}
                    {skills.find((s) => s.id === skill.executionSkill)?.name ??
                      skill.executionSkill}
                  </div>
                )}
                {skill.tags && skill.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1">
                    {skill.tags.map((tag) => (
                      <span
                        key={tag}
                        className="inline-flex items-center rounded-full bg-surface-subtle px-1.5 py-px text-[9px] text-fg-subtle border border-border/50"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
              </SelectItem>
            ))}
          </div>
        ))}

        {/* Empty state when filters eliminate all results */}
        {!isLoading &&
          displayedGroups.length === 0 &&
          (filteredSkills.length === 0 || searchQuery) && (
            <div className="px-2 py-4 text-center text-xs text-fg-muted">
              No skills match {searchQuery ? `"${searchQuery}"` : 'the selected tags'}
            </div>
          )}

        {isLoading && <div className="px-2 py-2 text-xs text-fg-muted">Loading skills...</div>}
      </SelectContent>
    </Select>
  );
}

/**
 * Inline skill picker for compact spaces (e.g., metadata sections).
 */
export function SkillPickerInline({
  codespaceId,
  value,
  onChange,
}: Omit<SkillPickerProps, 'compact'>): React.JSX.Element {
  return (
    <SkillPicker
      codespaceId={codespaceId}
      value={value}
      onChange={onChange}
      compact
      className="h-7 text-xs"
    />
  );
}
