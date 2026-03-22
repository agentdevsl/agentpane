import { Lightning, Spinner, X } from '@phosphor-icons/react';
import { useCallback, useState } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/app/components/ui/dropdown-menu';
import { useWatchEffect } from '@/app/hooks/use-watch-effect';
import { apiClient } from '@/lib/api/client';
import { cn } from '@/lib/utils/cn';

interface Skill {
  id: string;
  name: string;
  description?: string;
  sourceType?: string;
  sourceName?: string;
}

interface TaskSkillProps {
  codespaceId: string;
  skillId: string | null;
  skillName: string | null;
  onChange: (skillId: string | null, skillName: string | null) => void;
}

export function TaskSkill({
  codespaceId,
  skillId,
  skillName,
  onChange,
}: TaskSkillProps): React.JSX.Element {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [hasFetched, setHasFetched] = useState(false);

  const fetchSkills = useCallback(async () => {
    if (hasFetched || isLoading) return;
    setIsLoading(true);
    try {
      const result = await apiClient.codespaces.getSkills(codespaceId);
      if (result.ok) {
        setSkills(result.data as Skill[]);
      }
    } catch (error) {
      console.error('[TaskSkill] Failed to fetch skills:', error);
    } finally {
      setIsLoading(false);
      setHasFetched(true);
    }
  }, [codespaceId, hasFetched, isLoading]);

  // Reset fetch state if codespaceId changes
  useWatchEffect(() => {
    setHasFetched(false);
    setSkills([]);
  }, [codespaceId]);

  const handleClear = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onChange(null, null);
    },
    [onChange]
  );

  const handleSelect = useCallback(
    (skill: Skill) => {
      onChange(skill.id, skill.name);
    },
    [onChange]
  );

  // Available skills excluding the currently selected one
  const availableSkills = skills.filter((s) => s.id !== skillId);

  return (
    <div className="space-y-2">
      <h3 className="text-xs font-medium uppercase tracking-wide text-fg-muted">Skill</h3>

      {skillId ? (
        /* Assigned skill display */
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium',
              'bg-claude-muted text-claude'
            )}
          >
            <Lightning weight="fill" className="h-3 w-3" />
            {skillName || skillId}
          </span>

          {/* Change skill dropdown */}
          <DropdownMenu onOpenChange={(open) => open && fetchSkills()}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={cn(
                  'inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2 py-1 text-xs font-medium text-fg-muted',
                  'hover:border-fg-subtle hover:text-fg transition-colors'
                )}
              >
                Change
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-60 overflow-y-auto">
              {isLoading ? (
                <div className="flex items-center justify-center px-2 py-3">
                  <Spinner className="h-4 w-4 animate-spin text-fg-muted" />
                </div>
              ) : availableSkills.length > 0 ? (
                availableSkills.map((skill) => (
                  <DropdownMenuItem
                    key={skill.id}
                    onSelect={() => handleSelect(skill)}
                    className="flex flex-col items-start gap-0.5"
                  >
                    <div className="flex items-center gap-1.5">
                      <Lightning weight="fill" className="h-3 w-3 text-claude" />
                      <span className="font-medium">{skill.name}</span>
                    </div>
                    {skill.description && (
                      <span className="text-[11px] text-fg-muted pl-[18px] line-clamp-1">
                        {skill.description}
                      </span>
                    )}
                  </DropdownMenuItem>
                ))
              ) : (
                <div className="px-2 py-2 text-xs text-fg-subtle italic">
                  No other skills available
                </div>
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Clear button */}
          <button
            type="button"
            onClick={handleClear}
            className={cn(
              'inline-flex items-center justify-center rounded-full p-1',
              'text-fg-muted hover:text-fg hover:bg-surface-muted transition-colors'
            )}
            aria-label="Remove skill"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ) : (
        /* No skill assigned - show add button */
        <DropdownMenu onOpenChange={(open) => open && fetchSkills()}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full border border-dashed border-border px-2.5 py-1 text-xs font-medium text-fg-muted',
                'hover:border-fg-subtle hover:text-fg transition-colors'
              )}
            >
              <Lightning className="h-3 w-3" />
              Add skill
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-60 overflow-y-auto">
            {isLoading ? (
              <div className="flex items-center justify-center px-2 py-3">
                <Spinner className="h-4 w-4 animate-spin text-fg-muted" />
              </div>
            ) : skills.length > 0 ? (
              skills.map((skill) => (
                <DropdownMenuItem
                  key={skill.id}
                  onSelect={() => handleSelect(skill)}
                  className="flex flex-col items-start gap-0.5"
                >
                  <div className="flex items-center gap-1.5">
                    <Lightning weight="fill" className="h-3 w-3 text-claude" />
                    <span className="font-medium">{skill.name}</span>
                  </div>
                  {skill.description && (
                    <span className="text-[11px] text-fg-muted pl-[18px] line-clamp-1">
                      {skill.description}
                    </span>
                  )}
                </DropdownMenuItem>
              ))
            ) : (
              <div className="px-2 py-2 text-xs text-fg-subtle italic">
                No skills available for this codespace
              </div>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
