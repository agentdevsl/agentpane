export function AgentEdgeMarkers(): React.JSX.Element {
  return (
    <svg aria-hidden="true" style={{ position: 'absolute', width: 0, height: 0 }}>
      <defs>
        {/* Default arrow marker (gray) */}
        <marker
          id="agent-arrow-default"
          markerWidth="8"
          markerHeight="8"
          refX="7"
          refY="4"
          orient="auto"
          markerUnits="strokeWidth"
        >
          <path
            d="M1,1 L7,4 L1,7"
            fill="none"
            stroke="#475569"
            strokeWidth="1.5"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </marker>
        {/* Running arrow marker (green) */}
        <marker
          id="agent-arrow-running"
          markerWidth="8"
          markerHeight="8"
          refX="7"
          refY="4"
          orient="auto"
          markerUnits="strokeWidth"
        >
          <path
            d="M1,1 L7,4 L1,7"
            fill="none"
            stroke="#34D399"
            strokeWidth="1.5"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </marker>
        {/* Completed arrow marker (purple) */}
        <marker
          id="agent-arrow-completed"
          markerWidth="8"
          markerHeight="8"
          refX="7"
          refY="4"
          orient="auto"
          markerUnits="strokeWidth"
        >
          <path
            d="M1,1 L7,4 L1,7"
            fill="none"
            stroke="#A78BFA"
            strokeWidth="1.5"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </marker>
        {/* Skill dependency arrow marker (accent blue, smaller) */}
        <marker
          id="skill-arrow"
          markerWidth="6"
          markerHeight="6"
          refX="5"
          refY="3"
          orient="auto"
          markerUnits="strokeWidth"
        >
          <path
            d="M1,1 L5,3 L1,5"
            fill="none"
            stroke="var(--accent-muted, rgba(56, 139, 253, 0.4))"
            strokeWidth="1"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </marker>
        {/* Glow filter for running agents */}
        <filter id="agent-glow-running" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="4" result="blur" />
          <feFlood floodColor="#34D399" floodOpacity="0.4" result="color" />
          <feComposite in="color" in2="blur" operator="in" result="glow" />
          <feMerge>
            <feMergeNode in="glow" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        {/* Glow filter for verifying agents */}
        <filter id="agent-glow-verifying" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="4" result="blur" />
          <feFlood floodColor="#FFD866" floodOpacity="0.3" result="color" />
          <feComposite in="color" in2="blur" operator="in" result="glow" />
          <feMerge>
            <feMergeNode in="glow" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
    </svg>
  );
}
