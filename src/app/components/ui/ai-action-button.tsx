import { forwardRef } from 'react';
import { cn } from '@/lib/utils/cn';

export interface AIActionButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Compact mode hides the text label */
  compact?: boolean;
}

/**
 * A distinctive button for AI-powered actions featuring Claw'd mascot.
 * Features the official Claude logo and an animated Claw'd that walks
 * across the button on hover.
 *
 * Design choices:
 * - Orange border (#D97757) matches Claude brand
 * - Claw'd mascot walks on hover for playful interaction
 * - Claude logo icon signals AI-powered action
 * - Subtle glow on hover reinforces the magical feel
 */
export const AIActionButton = forwardRef<HTMLButtonElement, AIActionButtonProps>(
  ({ className, compact = false, children, ...props }, ref) => {
    return (
      <button
        ref={ref}
        className={cn(
          // Base layout
          'group relative inline-flex items-center justify-center',
          'font-medium text-sm',
          compact ? 'h-7 w-7 rounded-md' : 'h-10 px-[18px] gap-2.5 rounded-[10px]',
          // Colors
          'bg-surface-muted border border-border',
          'text-fg',
          // Hover states
          'hover:border-claude hover:shadow-[0_0_12px_rgba(217,119,87,0.3)]',
          // Focus & disabled states
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude/50 focus-visible:ring-offset-2 focus-visible:ring-offset-surface',
          'disabled:pointer-events-none disabled:opacity-50',
          // Transition
          'transition-all duration-300 ease-out',
          // Overflow for claw'd
          'overflow-visible',
          className
        )}
        {...props}
      >
        {/* Claw'd container - walks on hover */}
        <span
          className={cn(
            'absolute',
            'transition-[left] duration-[2000ms] ease-out',
            compact
              ? 'bottom-[-12px] left-0.5 w-3 h-[12px] group-hover:left-[calc(100%-14px)]'
              : 'bottom-[-18px] left-1 w-5 h-[18px] group-hover:left-[calc(100%-24px)]'
          )}
        >
          <svg
            viewBox="0 0 20 13"
            fill="none"
            aria-hidden="true"
            className="w-full h-full overflow-visible"
          >
            {/* Body — uses Claude brand orange via the design-system token */}
            <g className="origin-center group-hover:animate-[bob_0.2s_ease-in-out_infinite]">
              <rect x="3" y="0" width="14" height="9" fill="var(--claude)" />
              {/* Side nubs */}
              <rect x="0" y="4" width="3" height="3" fill="var(--claude)" />
              <rect x="17" y="4" width="3" height="3" fill="var(--claude)" />
              {/*
                Eyes — intentionally fixed dark-grey to preserve mascot
                identity on the orange body across themes. allowlisted.
              */}
              <rect x="6" y="3" width="2" height="2" fill="#1a1a1a" />
              <rect x="12" y="3" width="2" height="2" fill="#1a1a1a" />
            </g>
            {/* 4 short legs */}
            <g className="origin-[5px_9px] group-hover:animate-[step-l_0.2s_ease-in-out_infinite]">
              <rect x="4" y="9" width="3" height="4" fill="var(--claude)" />
            </g>
            <g className="origin-[8px_9px] group-hover:animate-[step-r_0.2s_ease-in-out_infinite]">
              <rect x="7" y="9" width="3" height="4" fill="var(--claude)" />
            </g>
            <g className="origin-[12px_9px] group-hover:animate-[step-l_0.2s_ease-in-out_infinite]">
              <rect x="10" y="9" width="3" height="4" fill="var(--claude)" />
            </g>
            <g className="origin-[15px_9px] group-hover:animate-[step-r_0.2s_ease-in-out_infinite]">
              <rect x="13" y="9" width="3" height="4" fill="var(--claude)" />
            </g>
          </svg>
        </span>

        {/* Claude logo */}
        <svg
          viewBox="0 0 248 248"
          fill="currentColor"
          aria-label="Claude"
          role="img"
          className={cn('text-claude', compact ? 'h-3.5 w-3.5' : 'h-[18px] w-[18px]')}
        >
          <path d="M52.4285 162.873L98.7844 136.879L99.5485 134.602L98.7844 133.334H96.4921L88.7237 132.862L62.2346 132.153L39.3113 131.207L17.0249 130.026L11.4214 128.844L6.2 121.873L6.7094 118.447L11.4214 115.257L18.171 115.847L33.0711 116.911L55.485 118.447L71.6586 119.392L95.728 121.873H99.5485L100.058 120.337L98.7844 119.392L97.7656 118.447L74.5877 102.732L49.4995 86.1905L36.3823 76.62L29.3779 71.7757L25.8121 67.2858L24.2839 57.3608L30.6515 50.2716L39.3113 50.8623L41.4763 51.4531L50.2636 58.1879L68.9842 72.7209L93.4357 90.6804L97.0015 93.6343L98.4374 92.6652L98.6571 91.9801L97.0015 89.2625L83.757 65.2772L69.621 40.8192L63.2534 30.6579L61.5978 24.632C60.9565 22.1032 60.579 20.0111 60.579 17.4246L67.8381 7.49965L71.9133 6.19995L81.7193 7.49965L85.7946 11.0443L91.9074 24.9865L101.714 46.8451L116.996 76.62L121.453 85.4816L123.873 93.6343L124.764 96.1155H126.292V94.6976L127.566 77.9197L129.858 57.3608L132.15 30.8942L132.915 23.4505L136.608 14.4708L143.994 9.62643L149.725 12.344L154.437 19.0788L153.8 23.4505L150.998 41.6463L145.522 70.1215L141.957 89.2625H143.994L146.414 86.7813L156.093 74.0206L172.266 53.698L179.398 45.6635L187.803 36.802L193.152 32.5484H203.34L210.726 43.6549L207.415 55.1159L196.972 68.3492L188.312 79.5739L175.896 96.2095L168.191 109.585L168.882 110.689L170.738 110.53L198.755 104.504L213.91 101.787L231.994 98.7149L240.144 102.496L241.036 106.395L237.852 114.311L218.495 119.037L195.826 123.645L162.07 131.592L161.696 131.893L162.137 132.547L177.36 133.925L183.855 134.279H199.774L229.447 136.524L237.215 141.605L241.8 147.867L241.036 152.711L229.065 158.737L213.019 154.956L175.45 145.977L162.587 142.787H160.805V143.85L171.502 154.366L191.242 172.089L215.82 195.011L217.094 200.682L213.91 205.172L210.599 204.699L188.949 188.394L180.544 181.069L161.696 165.118H160.422V166.772L164.752 173.152L187.803 207.771L188.949 218.405L187.294 221.832L181.308 223.959L174.813 222.777L161.187 203.754L147.305 182.486L136.098 163.345L134.745 164.2L128.075 235.42L125.019 239.082L117.887 241.8L111.902 237.31L108.718 229.984L111.902 215.452L115.722 196.547L118.779 181.541L121.58 162.873L123.291 156.636L123.14 156.219L121.773 156.449L107.699 175.752L86.304 204.699L69.3663 222.777L65.291 224.431L58.2867 220.768L58.9235 214.27L62.8713 208.48L86.304 178.705L100.44 160.155L109.551 149.507L109.462 147.967L108.959 147.924L46.6977 188.512L35.6182 189.93L30.7788 185.44L31.4156 178.115L33.7079 175.752L52.4285 162.873Z" />
        </svg>

        {/* Text */}
        {!compact && (
          <span className="transition-colors duration-200">
            {children ?? 'Create task with Claude'}
          </span>
        )}
      </button>
    );
  }
);

AIActionButton.displayName = 'AIActionButton';
