import { Check, Copy } from '@phosphor-icons/react';
import { cva } from 'class-variance-authority';
import { useState } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/app/components/ui/tooltip';
import type { PresenceUser } from '@/app/hooks/use-presence';
import { cn } from '@/lib/utils/cn';

interface PresenceBarProps {
  users: PresenceUser[];
  shareUrl: string;
}

// Avatar gradient color pairs for consistent styling
const avatarGradients = [
  'bg-gradient-to-br from-blue-400 to-blue-600',
  'bg-gradient-to-br from-purple-400 to-purple-600',
  'bg-gradient-to-br from-green-400 to-green-600',
  'bg-gradient-to-br from-orange-400 to-orange-600',
  'bg-gradient-to-br from-pink-400 to-pink-600',
  'bg-gradient-to-br from-cyan-400 to-cyan-600',
  'bg-gradient-to-br from-rose-400 to-rose-600',
  'bg-gradient-to-br from-amber-400 to-amber-600',
  'bg-gradient-to-br from-indigo-400 to-indigo-600',
  'bg-gradient-to-br from-teal-400 to-teal-600',
];

// Generate consistent gradient from user ID
function getUserGradient(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = userId.charCodeAt(i) + ((hash << 5) - hash);
  }
  const gradient = avatarGradients[Math.abs(hash) % avatarGradients.length];
  return gradient ?? 'bg-gradient-to-br from-blue-400 to-blue-600';
}

function getInitials(userId: string): string {
  // If it looks like a name, get initials
  if (userId.includes(' ')) {
    const parts = userId.split(' ');
    const firstPart = parts[0] || '';
    const secondPart = parts[1] || '';
    return ((firstPart[0] || '') + (secondPart[0] || '')).toUpperCase();
  }
  // Otherwise use first character
  return userId.slice(0, 1).toUpperCase();
}

const avatarVariants = cva(
  'relative flex items-center justify-center rounded-full font-semibold text-white cursor-pointer transition-all duration-150',
  {
    variants: {
      size: {
        sm: 'h-6 w-6 text-[10px]',
        default: 'h-8 w-8 text-xs',
        lg: 'h-10 w-10 text-sm',
      },
    },
    defaultVariants: {
      size: 'default',
    },
  }
);

interface AvatarProps {
  userId: string;
  isOnline?: boolean;
  size?: 'sm' | 'default' | 'lg';
  className?: string;
}

function Avatar({
  userId,
  isOnline = true,
  size = 'default',
  className,
}: AvatarProps): React.JSX.Element {
  const dotSizeClasses = {
    sm: 'h-1.5 w-1.5',
    default: 'h-2.5 w-2.5',
    lg: 'h-3 w-3',
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className={cn(
            avatarVariants({ size }),
            getUserGradient(userId),
            'hover:-translate-y-0.5 hover:z-10 hover:shadow-md',
            className
          )}
        >
          {getInitials(userId)}
          {isOnline && (
            <span
              className={cn(
                'absolute -bottom-0.5 -right-0.5 rounded-full bg-success ring-2 ring-surface-subtle',
                dotSizeClasses[size]
              )}
            />
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">
        {userId}
      </TooltipContent>
    </Tooltip>
  );
}

export function PresenceBar({ users, shareUrl }: PresenceBarProps): React.JSX.Element {
  const [copied, setCopied] = useState(false);

  const handleCopyUrl = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for older browsers
      const textArea = document.createElement('textarea');
      textArea.value = shareUrl;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  // Extract display URL (remove protocol)
  const displayUrl = shareUrl.replace(/^https?:\/\//, '');

  const visibleUsers = users.slice(0, 5);
  const overflowCount = users.length - 5;
  const now = Date.now();
  const STALE_THRESHOLD = 30000; // 30 seconds

  return (
    <div className="flex items-center justify-between border-b border-border bg-surface-subtle px-6 py-3">
      {/* Left side - User avatars */}
      <div className="flex items-center gap-4">
        {/* Avatar stack */}
        <div className="flex items-center -space-x-2">
          {visibleUsers.map((user) => (
            <Avatar
              key={user.userId}
              userId={user.userId}
              isOnline={now - user.lastSeen < STALE_THRESHOLD}
              className="border-2 border-surface-subtle"
            />
          ))}
          {overflowCount > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-surface text-xs font-medium text-fg-muted border-2 border-surface-subtle">
                  +{overflowCount}
                </div>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {users
                  .slice(5)
                  .map((u) => u.userId)
                  .join(', ')}
              </TooltipContent>
            </Tooltip>
          )}
        </div>

        {/* Participants label */}
        <span className="text-sm text-fg-muted">
          <strong className="font-medium text-fg">
            {users.length} participant{users.length !== 1 ? 's' : ''}
          </strong>{' '}
          in this session
        </span>
      </div>

      {/* Right side - Share URL */}
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium uppercase tracking-wider text-fg-subtle">Share</span>
        <div className="flex items-center overflow-hidden rounded-md border border-border bg-surface">
          <input
            type="text"
            readOnly
            value={displayUrl}
            className="w-52 bg-transparent px-3 py-1.5 font-mono text-sm text-accent outline-none"
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={handleCopyUrl}
                className={cn(
                  'flex h-full items-center justify-center border-l border-border px-3 py-1.5 transition-colors',
                  copied
                    ? 'bg-success text-white'
                    : 'bg-surface-subtle text-fg-muted hover:bg-accent hover:text-white'
                )}
              >
                {copied ? (
                  <Check className="h-4 w-4" weight="bold" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{copied ? 'Copied!' : 'Copy URL'}</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}

// Export Avatar for potential reuse
export { Avatar, getInitials, getUserGradient };
