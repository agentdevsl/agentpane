// Hoisted static style objects to avoid re-creating on every render
const nodeStyleBlue = { filter: 'drop-shadow(0 0 2px #58a6ff)' } as const;
const nodeStylePurple = { filter: 'drop-shadow(0 0 3px #a371f7)', animationDelay: '0.4s' } as const;
const nodeStyleGreen = { filter: 'drop-shadow(0 0 2px #3fb950)', animationDelay: '0.8s' } as const;
const nodeStylePink = { filter: 'drop-shadow(0 0 3px #f778ba)', animationDelay: '1.2s' } as const;
const nodeStyleGold = { filter: 'drop-shadow(0 0 2px #d29922)', animationDelay: '1.6s' } as const;

/**
 * Animated AgentPane logo icon for welcome/empty screens.
 * A larger version of the sidebar logo with animated nodes.
 *
 * Accepts an optional `gradientId` prop so multiple instances on the same page
 * can avoid SVG <defs> id collisions.
 */
export function AgentPaneLogo({
  gradientId = 'agentPaneCoreGrad',
}: {
  gradientId?: string;
} = {}): React.JSX.Element {
  return (
    <div className="relative flex h-28 w-28 items-center justify-center overflow-hidden rounded-2xl bg-surface-subtle shadow-[0_2px_4px_rgba(0,0,0,0.06),0_4px_16px_rgba(0,0,0,0.1),0_0_0_1px_rgba(0,0,0,0.05)] dark:shadow-[0_1px_0_0_rgba(255,255,255,0.04)_inset,0_-1px_0_0_rgba(0,0,0,0.3)_inset,0_4px_24px_-2px_rgba(0,0,0,0.5),0_0_0_1px_rgba(255,255,255,0.06)]">
      <div className="absolute inset-0 animate-pulse rounded-2xl bg-gradient-radial from-done/10 to-transparent dark:from-done/15" />
      <svg
        className="relative z-10 h-16 w-16 drop-shadow-[0_0_12px_rgba(163,113,247,0.4)]"
        viewBox="0 0 32 32"
        fill="none"
        aria-hidden="true"
      >
        <defs>
          <radialGradient id={gradientId} cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#fff" />
            <stop offset="50%" stopColor="#3fb950" />
            <stop offset="100%" stopColor="#3fb950" stopOpacity="0" />
          </radialGradient>
        </defs>
        {/* Connection lines */}
        <line x1="14" y1="14" x2="6" y2="8" stroke="#58a6ff" strokeOpacity="0.4" strokeWidth="1" />
        <line x1="14" y1="14" x2="22" y2="6" stroke="#a371f7" strokeOpacity="0.4" strokeWidth="1" />
        <line
          x1="14"
          y1="14"
          x2="26"
          y2="16"
          stroke="#3fb950"
          strokeOpacity="0.4"
          strokeWidth="1"
        />
        <line
          x1="14"
          y1="14"
          x2="20"
          y2="26"
          stroke="#f778ba"
          strokeOpacity="0.4"
          strokeWidth="1"
        />
        <line x1="14" y1="14" x2="6" y2="22" stroke="#d29922" strokeOpacity="0.4" strokeWidth="1" />
        {/* Outer nodes */}
        <circle
          className="animate-pulse"
          cx="6"
          cy="8"
          r="2"
          fill="#58a6ff"
          style={nodeStyleBlue}
        />
        <circle
          className="animate-pulse"
          cx="22"
          cy="6"
          r="2.5"
          fill="#a371f7"
          style={nodeStylePurple}
        />
        <circle
          className="animate-pulse"
          cx="26"
          cy="16"
          r="2"
          fill="#3fb950"
          style={nodeStyleGreen}
        />
        <circle
          className="animate-pulse"
          cx="20"
          cy="26"
          r="3"
          fill="#f778ba"
          style={nodeStylePink}
        />
        <circle
          className="animate-pulse"
          cx="6"
          cy="22"
          r="2"
          fill="#d29922"
          style={nodeStyleGold}
        />
        {/* Center hub */}
        <circle cx="14" cy="14" r="5" fill={`url(#${gradientId})`} />
        <circle cx="14" cy="14" r="2" fill="#fff" />
      </svg>
    </div>
  );
}
