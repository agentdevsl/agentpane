# Wireframes — CLI Monitor Designs

21 HTML wireframe designs exploring different visual metaphors for the CLI monitor dashboard.

**Location**: `specs/application/wireframes/cli-monitor/`

---

## Catalog

### Core Designs

| File | Concept |
|------|---------|
| `cli-monitor.html` | Base design — standard dashboard layout |
| `cli-monitor-timeline.html` | Swimlane timeline with project Y-axis and time X-axis |
| `cli-monitor-terminal.html` | Terminal/CLI aesthetic with monospace everything |
| `cli-monitor-heatmap.html` | Activity heatmap grid showing session intensity |

### Thematic Explorations

| File | Concept |
|------|---------|
| `cli-monitor-matrix.html` | Matrix rain aesthetic with green terminal text |
| `cli-monitor-cyberpunk.html` | Neon-lit cyberpunk dashboard |
| `cli-monitor-lcars.html` | Star Trek LCARS interface style |
| `cli-monitor-f1.html` | F1 race telemetry dashboard |
| `cli-monitor-satellite.html` | Satellite ground control layout |
| `cli-monitor-subway.html` | Transit map / subway diagram |

### Nature/Science Metaphors

| File | Concept |
|------|---------|
| `cli-monitor-aquarium.html` | Sessions as fish in an aquarium |
| `cli-monitor-aurora.html` | Northern lights ambient visualization |
| `cli-monitor-greenhouse.html` | Sessions as plants growing in a greenhouse |
| `cli-monitor-volcanic.html` | Volcanic activity monitoring |
| `cli-monitor-neural.html` | Neural network / brain connectivity map |
| `cli-monitor-mixer.html` | Audio mixing console with session channels |

### Numbered Design Series

| File | Concept |
|------|---------|
| `design-1-neural-observatory.html` | Neural observatory with node graph |
| `design-2-the-foundry.html` | Industrial foundry / forge metaphor |
| `design-3-bioluminescent-depths.html` | Deep sea bioluminescent organisms |
| `design-4-noir-command.html` | Film noir command center |
| `design-5-celestial-cartography.html` | Star map / celestial navigation |

---

## Design Direction

The implemented frontend (`src/app/routes/cli-monitor/index.tsx`) follows a clean, functional approach closest to the base `cli-monitor.html` design with elements from the timeline wireframe:

- **Summary strip** at top (from timeline design)
- **Grouped session list** (card-based, not timeline)
- **Detail panel** at bottom (from timeline design)
- **Status indicator** in header (LIVE/WAITING/IDLE)
- **Alert toasts** for status transitions

### Key Visual Elements Adopted

| Element | Source Wireframe | Implementation |
|---------|-----------------|----------------|
| Status dot with pulse | timeline | SessionCard working state |
| Summary cards (4-grid) | timeline | SummaryCard component |
| Accent glow on install CTA | multiple | Install state command block |
| Radar pulse animation | satellite | Waiting state animation |
| Token breakdown panel | terminal, f1 | Session detail sidebar |

---

## Install / Waiting / Active States

All wireframes focused on the active state. The install and waiting states were designed during implementation:

### Install State
- Terminal command as primary CTA (`$ npx @agentpane/cli-monitor`)
- Ghost preview showing what active state will look like
- Alternative install methods (npm global, Homebrew)

### Waiting State
- Radar pulse animation (three concentric rings)
- Example command prompt to guide user

### Active State
- Summary strip with aggregate metrics
- Project-grouped session cards
- Slide-up detail panel with stream output + token breakdown
