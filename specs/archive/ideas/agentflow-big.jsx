import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const TM = {
  orchestrator: { icon: '◇', color: '#FFD866' },
  planner: { icon: '◈', color: '#A78BFA' },
  coder: { icon: '⟨⟩', color: '#67E8F9' },
  reviewer: { icon: '◎', color: '#C084FC' },
  tester: { icon: '⬡', color: '#FCA572' },
  scanner: { icon: '⊘', color: '#F87171' },
  deployer: { icon: '▲', color: '#34D399' },
};
const SM = {
  completed: { color: '#A78BFA', bg: '#A78BFA14', border: '#A78BFA35', label: 'Done', icon: '✓' },
  running: {
    color: '#34D399',
    bg: '#34D39914',
    border: '#34D39935',
    label: 'Running',
    icon: '●',
    pulse: true,
  },
  verifying: {
    color: '#FFD866',
    bg: '#FFD86614',
    border: '#FFD86635',
    label: 'Verify',
    icon: '◎',
    pulse: true,
  },
  blocked: { color: '#FCA572', bg: '#FCA57214', border: '#FCA57235', label: 'Blocked', icon: '⊘' },
  failed: { color: '#F87171', bg: '#F8717114', border: '#F8717135', label: 'Failed', icon: '✕' },
  queued: { color: '#475569', bg: '#47556910', border: '#47556925', label: 'Queued', icon: '○' },
};
const DC = {
  auto_verify: { icon: '⚡', color: '#34D399', label: 'Auto-Verify' },
  route: { icon: '⑂', color: '#67E8F9', label: 'Route' },
  retry: { icon: '↻', color: '#FCA572', label: 'Retry' },
  escalate: { icon: '▲', color: '#F87171', label: 'Escalate' },
  spawn: { icon: '◊', color: '#A78BFA', label: 'Spawn' },
  tool_select: { icon: '⚙', color: '#FFD866', label: 'Tool' },
  delegate: { icon: '→', color: '#67E8F9', label: 'Delegate' },
  throttle: { icon: '◑', color: '#FCA572', label: 'Throttle' },
  prioritize: { icon: '★', color: '#FFD866', label: 'Priority' },
};
const confColor = (v) =>
  v >= 0.85 ? '#34D399' : v >= 0.6 ? '#FFD866' : v >= 0.3 ? '#FCA572' : '#F87171';

let _id = 0;
const uid = () => ++_id;
const fmtT = (ts) => {
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
};

const REASONS = {
  auto_verify: [
    {
      summary: 'All tests passed, coverage 94.2%',
      detail:
        '42/42 test cases passed. Code coverage 94.2% exceeds 90% threshold. No SAST vulnerabilities detected. Lint score 9.8/10.',
      criteria: ['test_pass_rate = 100%', 'coverage ≥ 90%', 'sast_vulns = 0', 'lint ≥ 9.0'],
      alts: [],
      policy: 'auto-verify-v2',
    },
    {
      summary: 'Schema contract validated',
      detail:
        'Generated API endpoints match OpenAPI 3.1 schema. Response types validated against TypeScript interfaces. No breaking changes detected.',
      criteria: ['schema_valid = true', 'type_check = pass', 'breaking = 0'],
      alts: [],
      policy: 'contract-verify-v1',
    },
    {
      summary: 'Diff within safe change bounds',
      detail:
        'File diff: +342/-28 lines. No modifications to critical paths. Change complexity score 3.2/10 below 5.0 auto-approve threshold.',
      criteria: ['critical_changes = 0', 'complexity < 5.0'],
      alts: [],
      policy: 'safe-diff-v1',
    },
  ],
  route: [
    {
      summary: 'Routed to least loaded agent',
      detail:
        'Agent pool utilization: α=87%, β=34%, γ=62%. Selected β based on lowest throughput and matching capability profile.',
      criteria: ['capability = match', 'utilization < 50%'],
      alts: ['Reviewer α (87% util)', 'Reviewer γ (62% util)'],
      policy: 'load-balance-v1',
    },
    {
      summary: 'Specialist agent matched',
      detail:
        'Task requires Terraform HCL expertise. TF Reviewer scores 0.94 relevance vs. general reviewer at 0.61.',
      criteria: ['relevance ≥ 0.8'],
      alts: ['General (0.61)', 'Security (0.45)'],
      policy: 'capability-route-v2',
    },
  ],
  retry: [
    {
      summary: 'Transient error, auto-retry 1/3',
      detail:
        'Error: RATE_LIMIT_EXCEEDED. Retry count: 1/3. Backoff: 2.4s exponential. Circuit breaker closed.',
      criteria: ['error ∈ transient', 'retries < max', 'breaker = closed'],
      alts: ['Escalate to human', 'Fail permanently'],
      policy: 'retry-v1',
    },
    {
      summary: 'Quality below threshold, regenerating',
      detail:
        'Generated code scored 0.42 on quality rubric (threshold: 0.7). Missing error handling and input validation. Augmenting prompt.',
      criteria: ['quality < 0.7', 'retries < 2'],
      alts: ['Escalate', 'Accept with warnings'],
      policy: 'quality-retry-v1',
    },
  ],
  escalate: [
    {
      summary: 'Confidence too low for auto-approve',
      detail:
        'Decision confidence: 0.43 — below 0.85 auto-approve threshold. Ambiguous requirements detected in 3 API endpoints.',
      criteria: ['confidence < 0.85', 'ambiguity = true'],
      alts: [],
      policy: 'escalation-v2',
    },
    {
      summary: 'Security-sensitive path modified',
      detail:
        'Modifications to authentication middleware detected. Policy mandates human review for auth, payment, and PII paths.',
      criteria: ['security_path = true'],
      alts: [],
      policy: 'security-escalation-v1',
    },
  ],
  spawn: [
    {
      summary: '3 parallel paths detected',
      detail:
        'Dependency graph analysis: 3 independent modules can execute concurrently. Estimated speedup: 2.6x.',
      criteria: ['independent ≥ 2', 'budget ≥ 30%'],
      alts: ['Sequential (1x)'],
      policy: 'parallel-spawn-v1',
    },
  ],
  tool_select: [
    {
      summary: 'Sonnet selected for code generation',
      detail:
        'Sonnet optimal for speed/cost on code gen. Opus is 3.2x cost for <5% quality improvement.',
      criteria: ['task = code_gen', 'complexity < high'],
      alts: ['Opus (+4.8% quality, 3.2x cost)', 'Haiku (-22% quality)'],
      policy: 'model-select-v3',
    },
  ],
  delegate: [
    {
      summary: 'Subtask extracted to specialist',
      detail:
        'Test generation subtask extracted. Specialist agent has 40% higher test quality scores.',
      criteria: ['extractable = true', 'specialist avail'],
      alts: [],
      policy: 'delegation-v1',
    },
  ],
  throttle: [
    {
      summary: 'Rate limit approaching, throttled',
      detail: 'Current rate: 847/1000 req/min (84.7%). Proactive throttle at 80% threshold.',
      criteria: ['rate > 80%'],
      alts: [],
      policy: 'throttle-v1',
    },
  ],
  prioritize: [
    {
      summary: 'Critical path — priority boosted',
      detail:
        '4 downstream agents blocked. Token allocation increased 50%, priority elevated to P0.',
      criteria: ['downstream_blocked ≥ 3', 'critical_path = true'],
      alts: [],
      policy: 'critical-path-v1',
    },
  ],
};
function pickR(type) {
  const p = REASONS[type];
  return p
    ? p[Math.floor(Math.random() * p.length)]
    : {
        summary: `Auto ${type}`,
        detail: 'Policy applied.',
        criteria: [],
        alts: [],
        policy: 'default-v1',
      };
}

function mkA(id, n, t, s, p, tk, v, ch, pa) {
  return {
    id,
    name: n,
    type: t,
    status: s,
    progress: p,
    tokens: tk,
    cost: tk * 0.000003,
    msgs: Math.floor(tk / 200),
    verification: v,
    children: ch,
    parents: pa,
    flash: 0,
    decs: 0,
  };
}
function createTasks() {
  return [
    {
      id: 't1',
      name: 'API Platform v2',
      pri: 'P0',
      agents: [
        mkA(
          't1-o',
          'Orchestrator',
          'orchestrator',
          'running',
          72,
          14200,
          'auto',
          ['t1-p', 't1-c1', 't1-c2'],
          []
        ),
        mkA(
          't1-p',
          'Planner',
          'planner',
          'completed',
          100,
          8400,
          'approved',
          ['t1-c1', 't1-c2'],
          ['t1-o']
        ),
        mkA(
          't1-c1',
          'API Builder',
          'coder',
          'running',
          64,
          31500,
          'pending',
          ['t1-t1', 't1-r1'],
          ['t1-o', 't1-p']
        ),
        mkA(
          't1-c2',
          'UI Crafter',
          'coder',
          'verifying',
          91,
          28300,
          'human',
          ['t1-t2', 't1-r2'],
          ['t1-o', 't1-p']
        ),
        mkA('t1-t1', 'Unit Tests', 'tester', 'queued', 0, 0, 'pending', ['t1-s'], ['t1-c1']),
        mkA('t1-t2', 'E2E Runner', 'tester', 'queued', 0, 0, 'auto', ['t1-s'], ['t1-c2']),
        mkA('t1-r1', 'Reviewer α', 'reviewer', 'queued', 0, 0, 'pending', ['t1-d'], ['t1-c1']),
        mkA('t1-r2', 'Reviewer β', 'reviewer', 'queued', 0, 0, 'human', ['t1-d'], ['t1-c2']),
        mkA('t1-s', 'Scanner', 'scanner', 'queued', 0, 0, 'auto', ['t1-d'], ['t1-t1', 't1-t2']),
        mkA(
          't1-d',
          'Deployer',
          'deployer',
          'queued',
          0,
          0,
          'human',
          [],
          ['t1-r1', 't1-r2', 't1-s']
        ),
      ],
    },
    {
      id: 't2',
      name: 'Auth Migration',
      pri: 'P0',
      agents: [
        mkA(
          't2-o',
          'Orchestrator',
          'orchestrator',
          'running',
          45,
          9200,
          'auto',
          ['t2-p', 't2-c1'],
          []
        ),
        mkA('t2-p', 'Planner', 'planner', 'completed', 100, 5100, 'approved', ['t2-c1'], ['t2-o']),
        mkA('t2-c1', 'OIDC Agent', 'coder', 'running', 55, 18700, 'pending', ['t2-t1'], ['t2-p']),
        mkA('t2-t1', 'Auth Tests', 'tester', 'queued', 0, 0, 'auto', ['t2-d'], ['t2-c1']),
        mkA('t2-d', 'Deployer', 'deployer', 'queued', 0, 0, 'auto', [], ['t2-t1']),
      ],
    },
    {
      id: 't3',
      name: 'Terraform Refactor',
      pri: 'P1',
      agents: [
        mkA(
          't3-o',
          'Orchestrator',
          'orchestrator',
          'running',
          88,
          22100,
          'auto',
          ['t3-c1', 't3-c2', 't3-c3'],
          []
        ),
        mkA(
          't3-c1',
          'VPC Module',
          'coder',
          'completed',
          100,
          15400,
          'approved',
          ['t3-r'],
          ['t3-o']
        ),
        mkA('t3-c2', 'EKS Module', 'coder', 'running', 82, 19800, 'pending', ['t3-r'], ['t3-o']),
        mkA('t3-c3', 'RDS Module', 'coder', 'completed', 100, 12300, 'auto', ['t3-r'], ['t3-o']),
        mkA(
          't3-r',
          'TF Reviewer',
          'reviewer',
          'queued',
          0,
          0,
          'pending',
          ['t3-d'],
          ['t3-c1', 't3-c2', 't3-c3']
        ),
        mkA('t3-d', 'TF Apply', 'deployer', 'queued', 0, 0, 'human', [], ['t3-r']),
      ],
    },
    {
      id: 't4',
      name: 'Dashboard Redesign',
      pri: 'P1',
      agents: [
        mkA(
          't4-o',
          'Orchestrator',
          'orchestrator',
          'running',
          55,
          11200,
          'auto',
          ['t4-c1', 't4-c2'],
          []
        ),
        mkA(
          't4-c1',
          'Components',
          'coder',
          'completed',
          100,
          24300,
          'approved',
          ['t4-r'],
          ['t4-o']
        ),
        mkA('t4-c2', 'Pages', 'coder', 'running', 62, 16800, 'pending', ['t4-r'], ['t4-o']),
        mkA('t4-r', 'Reviewer', 'reviewer', 'queued', 0, 0, 'human', ['t4-t'], ['t4-c1', 't4-c2']),
        mkA('t4-t', 'Visual Tests', 'tester', 'queued', 0, 0, 'auto', [], ['t4-r']),
      ],
    },
    {
      id: 't5',
      name: 'Data Pipeline ETL',
      pri: 'P0',
      agents: [
        mkA(
          't5-o',
          'Orchestrator',
          'orchestrator',
          'running',
          60,
          13800,
          'auto',
          ['t5-c1', 't5-c2'],
          []
        ),
        mkA('t5-c1', 'Extractor', 'coder', 'completed', 100, 20100, 'auto', ['t5-c2'], ['t5-o']),
        mkA('t5-c2', 'Transformer', 'coder', 'verifying', 88, 18400, 'human', ['t5-t'], ['t5-c1']),
        mkA('t5-t', 'Validator', 'tester', 'queued', 0, 0, 'auto', ['t5-d'], ['t5-c2']),
        mkA('t5-d', 'Deployer', 'deployer', 'queued', 0, 0, 'auto', [], ['t5-t']),
      ],
    },
    {
      id: 't6',
      name: 'CI Optimization',
      pri: 'P2',
      agents: [
        mkA('t6-o', 'Orchestrator', 'orchestrator', 'running', 30, 6200, 'auto', ['t6-c1'], []),
        mkA('t6-c1', 'Pipeline Agent', 'coder', 'running', 30, 8900, 'pending', [], ['t6-o']),
      ],
    },
  ];
}

// ═══ SIM ══════════════════════════════════════════════════════════════════════
function canStart(a, all) {
  return (
    !a.parents?.length ||
    a.parents.every((pid) => {
      const p = all.find((x) => x.id === pid);
      return p && p.status === 'completed';
    })
  );
}
function simTick(tasks, emitD) {
  const t = Date.now();
  return tasks.map((task) => ({
    ...task,
    agents: task.agents.map((agent) => {
      const a = { ...agent };
      if (a.status === 'queued' && canStart(a, task.agents) && Math.random() < 0.09) {
        a.status = 'running';
        a.progress = 1;
        emitD({
          id: uid(),
          ts: t,
          taskId: task.id,
          taskName: task.name,
          agentId: a.id,
          agentName: a.name,
          agentType: a.type,
          type: 'route',
          confidence: 0.7 + Math.random() * 0.3,
          reasoning: pickR('route'),
          overridden: false,
          from: 'queued',
          to: 'running',
        });
        a.flash = t + 2000;
        a.decs++;
      }
      if (a.status === 'running' && a.progress < 100) {
        a.progress = Math.min(100, a.progress + 0.6 + Math.random() * 2.5);
        a.tokens += Math.floor(Math.random() * 300 + 80);
        a.cost = a.tokens * 0.000003;
        a.msgs += Math.random() < 0.2 ? 1 : 0;
        if (Math.random() < 0.006) {
          const dt = ['tool_select', 'delegate', 'throttle', 'prioritize'][
            Math.floor(Math.random() * 4)
          ];
          emitD({
            id: uid(),
            ts: t,
            taskId: task.id,
            taskName: task.name,
            agentId: a.id,
            agentName: a.name,
            agentType: a.type,
            type: dt,
            confidence: 0.5 + Math.random() * 0.5,
            reasoning: pickR(dt),
            overridden: false,
            from: a.status,
            to: a.status,
          });
          a.decs++;
        }
        if (Math.random() < 0.003) {
          if (Math.random() < 0.6) {
            emitD({
              id: uid(),
              ts: t,
              taskId: task.id,
              taskName: task.name,
              agentId: a.id,
              agentName: a.name,
              agentType: a.type,
              type: 'retry',
              confidence: 0.6 + Math.random() * 0.3,
              reasoning: pickR('retry'),
              overridden: false,
              from: 'running',
              to: 'running',
            });
            a.progress = Math.max(0, a.progress - 15);
            a.decs++;
          } else {
            a.status = 'failed';
            a.verification = 'rejected';
            emitD({
              id: uid(),
              ts: t,
              taskId: task.id,
              taskName: task.name,
              agentId: a.id,
              agentName: a.name,
              agentType: a.type,
              type: 'escalate',
              confidence: 0.3 + Math.random() * 0.3,
              reasoning: pickR('escalate'),
              overridden: false,
              from: 'running',
              to: 'failed',
            });
            a.flash = t + 2000;
            a.decs++;
          }
        }
        if (Math.random() < 0.004 && a.progress < 75) {
          a.status = 'blocked';
          a.flash = t + 2000;
        }
      }
      if (a.status === 'running' && a.progress >= 100) {
        a.progress = 100;
        if (a.verification === 'human') {
          a.status = 'verifying';
          emitD({
            id: uid(),
            ts: t,
            taskId: task.id,
            taskName: task.name,
            agentId: a.id,
            agentName: a.name,
            agentType: a.type,
            type: 'escalate',
            confidence: 0.4 + Math.random() * 0.2,
            reasoning: { ...pickR('escalate'), summary: 'Human gate — awaiting review' },
            overridden: false,
            from: 'running',
            to: 'verifying',
          });
          a.flash = t + 2000;
          a.decs++;
        } else {
          a.status = 'completed';
          a.verification = 'approved';
          emitD({
            id: uid(),
            ts: t,
            taskId: task.id,
            taskName: task.name,
            agentId: a.id,
            agentName: a.name,
            agentType: a.type,
            type: 'auto_verify',
            confidence: 0.85 + Math.random() * 0.15,
            reasoning: pickR('auto_verify'),
            overridden: false,
            from: 'running',
            to: 'completed',
          });
          const ds = task.agents.filter((x) => x.parents?.includes(a.id) && x.status === 'queued');
          if (ds.length > 1) {
            emitD({
              id: uid(),
              ts: t,
              taskId: task.id,
              taskName: task.name,
              agentId: a.id,
              agentName: a.name,
              agentType: a.type,
              type: 'spawn',
              confidence: 0.8 + Math.random() * 0.2,
              reasoning: pickR('spawn'),
              overridden: false,
              from: 'completed',
              to: 'completed',
            });
            a.decs++;
          }
          a.flash = t + 2000;
          a.decs++;
        }
      }
      if (a.status === 'verifying' && a.verification === 'auto' && Math.random() < 0.05) {
        a.status = 'completed';
        a.verification = 'approved';
        emitD({
          id: uid(),
          ts: t,
          taskId: task.id,
          taskName: task.name,
          agentId: a.id,
          agentName: a.name,
          agentType: a.type,
          type: 'auto_verify',
          confidence: 0.88 + Math.random() * 0.12,
          reasoning: pickR('auto_verify'),
          overridden: false,
          from: 'verifying',
          to: 'completed',
        });
        a.flash = t + 2000;
        a.decs++;
      }
      if (a.status === 'blocked' && Math.random() < 0.012) {
        a.status = 'running';
        a.flash = t + 2000;
      }
      return a;
    }),
  }));
}

// ═══ POPOVER ══════════════════════════════════════════════════════════════════
function Popover({ d, pos, onClose, onOverride }) {
  if (!d) return null;
  const dc = DC[d.type] || DC.auto_verify;
  const r = d.reasoning;
  const cc = confColor(d.confidence);
  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 90 }} />
      <div
        style={{
          position: 'fixed',
          top: Math.min(pos.y, window.innerHeight - 440),
          left: Math.min(pos.x + 12, window.innerWidth - 380),
          width: 360,
          maxHeight: 420,
          overflowY: 'auto',
          zIndex: 100,
          backgroundColor: 'rgba(14,16,24,0.97)',
          backdropFilter: 'blur(20px)',
          border: `1px solid ${dc.color}30`,
          borderRadius: 12,
          boxShadow: `0 24px 80px rgba(0,0,0,0.7), 0 0 30px ${dc.color}08`,
          animation: 'popIn 0.15s ease',
        }}
      >
        <div
          style={{ padding: '14px 16px 12px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 8,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 7,
                  backgroundColor: `${dc.color}15`,
                  border: `1px solid ${dc.color}35`,
                  display: 'grid',
                  placeItems: 'center',
                  fontSize: 14,
                  color: dc.color,
                }}
              >
                {dc.icon}
              </span>
              <div>
                <div
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    color: dc.color,
                    letterSpacing: '0.06em',
                    textTransform: 'uppercase',
                  }}
                >
                  {dc.label}
                </div>
                <div style={{ fontSize: 13, fontWeight: 800, color: '#F3F4F6' }}>{r.summary}</div>
              </div>
            </div>
            <button
              onClick={onClose}
              style={{
                width: 24,
                height: 24,
                borderRadius: 6,
                border: '1px solid rgba(255,255,255,0.1)',
                backgroundColor: 'transparent',
                color: '#6B7280',
                fontSize: 12,
                cursor: 'pointer',
                display: 'grid',
                placeItems: 'center',
              }}
            >
              ×
            </button>
          </div>
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
            <span
              style={{
                padding: '2px 8px',
                borderRadius: 4,
                fontSize: 10,
                fontWeight: 700,
                color: TM[d.agentType]?.color,
                backgroundColor: `${TM[d.agentType]?.color}12`,
              }}
            >
              {TM[d.agentType]?.icon} {d.agentName}
            </span>
            <span
              style={{
                padding: '2px 8px',
                borderRadius: 4,
                fontSize: 10,
                color: '#6B7280',
                backgroundColor: 'rgba(255,255,255,0.04)',
              }}
            >
              {d.taskName}
            </span>
            <span
              style={{
                padding: '2px 8px',
                borderRadius: 4,
                fontSize: 10,
                fontWeight: 700,
                color: cc,
                backgroundColor: `${cc}12`,
              }}
            >
              {(d.confidence * 100).toFixed(0)}% conf
            </span>
            {d.from !== d.to && (
              <span
                style={{
                  padding: '2px 8px',
                  borderRadius: 4,
                  fontSize: 10,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 3,
                }}
              >
                <span
                  style={{
                    color: SM[d.from]?.color,
                    opacity: 0.5,
                    textDecoration: 'line-through',
                    textTransform: 'uppercase',
                  }}
                >
                  {SM[d.from]?.label}
                </span>
                <span style={{ color: '#374151' }}>→</span>
                <span
                  style={{ color: SM[d.to]?.color, fontWeight: 700, textTransform: 'uppercase' }}
                >
                  {SM[d.to]?.label}
                </span>
              </span>
            )}
            {d.overridden && (
              <span
                style={{
                  padding: '2px 8px',
                  borderRadius: 4,
                  fontSize: 10,
                  fontWeight: 800,
                  color: '#F87171',
                  backgroundColor: '#F8717112',
                }}
              >
                OVERRIDDEN
              </span>
            )}
          </div>
        </div>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
          <div style={{ fontSize: 12, color: '#C5C9D2', lineHeight: 1.55, marginBottom: 10 }}>
            {r.detail}
          </div>
          <div
            style={{
              height: 6,
              borderRadius: 3,
              backgroundColor: 'rgba(255,255,255,0.05)',
              overflow: 'hidden',
              position: 'relative',
              marginBottom: 3,
            }}
          >
            <div
              style={{
                position: 'absolute',
                left: '85%',
                top: 0,
                bottom: 0,
                width: 1,
                backgroundColor: '#34D39940',
              }}
            />
            <div
              style={{
                position: 'absolute',
                left: '60%',
                top: 0,
                bottom: 0,
                width: 1,
                backgroundColor: '#FFD86630',
              }}
            />
            <div
              style={{
                height: '100%',
                width: `${d.confidence * 100}%`,
                borderRadius: 3,
                backgroundColor: cc,
              }}
            />
          </div>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              fontSize: 8,
              color: '#374151',
            }}
          >
            <span>0</span>
            <span style={{ color: '#FFD86640' }}>60</span>
            <span style={{ color: '#34D39940' }}>85</span>
            <span>100</span>
          </div>
        </div>
        {r.criteria?.length > 0 && (
          <div style={{ padding: '10px 16px', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
            <div
              style={{
                fontSize: 9,
                fontWeight: 700,
                color: '#4B5563',
                letterSpacing: '0.1em',
                marginBottom: 6,
              }}
            >
              CRITERIA
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {r.criteria.map((c, i) => (
                <span
                  key={i}
                  style={{
                    padding: '3px 8px',
                    borderRadius: 4,
                    fontSize: 10,
                    fontFamily: "'JetBrains Mono',monospace",
                    color: '#34D399',
                    backgroundColor: 'rgba(52,211,153,0.08)',
                    border: '1px solid rgba(52,211,153,0.15)',
                  }}
                >
                  ✓ {c}
                </span>
              ))}
            </div>
          </div>
        )}
        {r.alts?.length > 0 && (
          <div style={{ padding: '10px 16px', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
            <div
              style={{
                fontSize: 9,
                fontWeight: 700,
                color: '#4B5563',
                letterSpacing: '0.1em',
                marginBottom: 6,
              }}
            >
              ALTERNATIVES
            </div>
            {r.alts.map((a, i) => (
              <div key={i} style={{ fontSize: 11, color: '#6B7280', marginBottom: 3 }}>
                — {a}
              </div>
            ))}
          </div>
        )}
        <div
          style={{
            padding: '10px 16px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <span
            style={{
              padding: '3px 8px',
              borderRadius: 4,
              fontSize: 10,
              fontFamily: "'JetBrains Mono',monospace",
              color: '#4B5563',
              backgroundColor: 'rgba(255,255,255,0.04)',
            }}
          >
            {r.policy}
          </span>
          {!d.overridden && (
            <button
              onClick={() => onOverride(d.id)}
              style={{
                padding: '5px 14px',
                borderRadius: 5,
                border: '1px solid #F8717125',
                backgroundColor: '#F8717108',
                color: '#F87171',
                fontSize: 11,
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              ⊘ Override
            </button>
          )}
        </div>
      </div>
    </>
  );
}

// ═══ PIPELINE ROW ═════════════════════════════════════════════════════════════
function PipelineRow({
  task,
  decisions,
  selectedAgentId,
  onSelectAgent,
  expanded,
  onToggle,
  onDecisionClick,
}) {
  const ordered = useMemo(() => {
    const vis = new Set(),
      res = [];
    function v(id) {
      if (vis.has(id)) return;
      vis.add(id);
      const a = task.agents.find((x) => x.id === id);
      if (!a) return;
      (a.parents || []).forEach(v);
      res.push(a);
    }
    task.agents.forEach((a) => v(a.id));
    return res;
  }, [task.agents]);

  const gates = task.agents.filter(
    (a) => a.verification === 'human' && a.status === 'verifying'
  ).length;
  const overall = Math.round(task.agents.reduce((s, a) => s + a.progress, 0) / task.agents.length);
  const totalCost = task.agents.reduce((s, a) => s + a.cost, 0);
  const totalDecs = task.agents.reduce((s, a) => s + a.decs, 0);
  const taskDecs = decisions.filter((d) => d.taskId === task.id);
  const recentDecs = taskDecs.slice(0, 4);
  const t = Date.now();
  const healthColor = task.agents.some((a) => a.status === 'failed')
    ? '#F87171'
    : task.agents.some((a) => a.status === 'blocked')
      ? '#FCA572'
      : task.agents.every((a) => a.status === 'completed')
        ? '#A78BFA'
        : '#34D399';

  return (
    <div
      style={{
        borderRadius: 12,
        overflow: 'hidden',
        backgroundColor: 'rgba(255,255,255,0.015)',
        border: '1px solid rgba(255,255,255,0.05)',
        transition: 'all 0.2s',
      }}
    >
      {/* Header row */}
      <div
        onClick={onToggle}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          padding: '12px 18px',
          cursor: 'pointer',
          transition: 'background 0.1s',
        }}
        onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.025)')}
        onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
      >
        <span
          style={{
            fontSize: 12,
            color: '#6B7280',
            transform: expanded ? 'rotate(90deg)' : 'none',
            transition: 'transform 0.15s',
            flexShrink: 0,
          }}
        >
          ▶
        </span>
        <span
          style={{
            fontSize: 11,
            fontWeight: 800,
            padding: '3px 8px',
            borderRadius: 4,
            fontFamily: "'JetBrains Mono',monospace",
            color: task.pri === 'P0' ? '#F87171' : task.pri === 'P1' ? '#FCA572' : '#475569',
            backgroundColor:
              task.pri === 'P0' ? '#F8717110' : task.pri === 'P1' ? '#FCA57208' : 'transparent',
            flexShrink: 0,
          }}
        >
          {task.pri}
        </span>
        <span
          style={{
            fontSize: 14,
            fontWeight: 700,
            color: '#F3F4F6',
            width: 170,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flexShrink: 0,
          }}
        >
          {task.name}
        </span>

        {/* Pipeline nodes — BIG */}
        <div style={{ display: 'flex', gap: 2, flex: 1, alignItems: 'center', minWidth: 0 }}>
          {ordered.map((a, i) => {
            const sm = SM[a.status];
            const isGate = a.verification === 'human' && a.status === 'verifying';
            const isSel = selectedAgentId === a.id;
            const isFlash = a.flash > t;
            const agentDecs = taskDecs.filter((d) => d.agentId === a.id).slice(0, 4);
            const nodeSize = isSel ? 40 : isGate ? 36 : 30;

            return (
              <div key={a.id} style={{ display: 'flex', alignItems: 'center' }}>
                {i > 0 && (
                  <div
                    style={{
                      width: 12,
                      height: 2,
                      borderRadius: 1,
                      backgroundColor:
                        a.status === 'queued' ? 'rgba(255,255,255,0.04)' : `${sm.color}30`,
                      transition: 'all 0.4s',
                    }}
                  />
                )}
                <div
                  style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}
                >
                  {/* Node */}
                  <div
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelectAgent(a.id, task.id);
                    }}
                    title={`${a.name} — ${sm.label} ${a.progress > 0 ? `(${Math.round(a.progress)}%)` : ''}`}
                    style={{
                      position: 'relative',
                      width: nodeSize,
                      height: nodeSize,
                      borderRadius: isGate ? 8 : nodeSize,
                      flexShrink: 0,
                      cursor: 'pointer',
                      backgroundColor: `${sm.color}${isSel ? '22' : '10'}`,
                      border: `2px solid ${sm.color}${isSel ? '70' : '35'}`,
                      display: 'grid',
                      placeItems: 'center',
                      transition: 'all 0.25s',
                      boxShadow: isFlash
                        ? `0 0 16px ${sm.color}50, inset 0 0 12px ${sm.color}15`
                        : isSel
                          ? `0 0 12px ${sm.color}25`
                          : 'none',
                      animation: isFlash ? 'flashN 0.5s ease' : 'none',
                    }}
                  >
                    {/* Progress ring */}
                    {a.progress > 0 && a.progress < 100 && (
                      <svg
                        style={{
                          position: 'absolute',
                          inset: -3,
                          width: 'calc(100% + 6px)',
                          height: 'calc(100% + 6px)',
                        }}
                        viewBox="0 0 44 44"
                      >
                        <circle
                          cx="22"
                          cy="22"
                          r="19"
                          fill="none"
                          stroke={`${sm.color}12`}
                          strokeWidth="2.5"
                        />
                        <circle
                          cx="22"
                          cy="22"
                          r="19"
                          fill="none"
                          stroke={sm.color}
                          strokeWidth="2.5"
                          strokeDasharray={`${a.progress * 1.194} ${119.4 - a.progress * 1.194}`}
                          strokeDashoffset="29.85"
                          strokeLinecap="round"
                          style={{ transition: 'stroke-dasharray 0.6s' }}
                        />
                      </svg>
                    )}
                    {/* Completed fill */}
                    {a.status === 'completed' && (
                      <div
                        style={{
                          position: 'absolute',
                          inset: 3,
                          borderRadius: isGate ? 5 : nodeSize,
                          backgroundColor: `${sm.color}15`,
                        }}
                      />
                    )}
                    {/* Icon */}
                    <span
                      style={{
                        fontSize: isGate ? 14 : 12,
                        color: sm.color,
                        fontWeight: 700,
                        position: 'relative',
                        filter:
                          a.status === 'running' || a.status === 'verifying'
                            ? `drop-shadow(0 0 4px ${sm.color}60)`
                            : 'none',
                      }}
                    >
                      {isGate ? '👁' : TM[a.type]?.icon}
                    </span>
                    {/* Status dot */}
                    {a.status !== 'queued' && (
                      <div
                        style={{
                          position: 'absolute',
                          top: -2,
                          right: -2,
                          width: 10,
                          height: 10,
                          borderRadius: 10,
                          backgroundColor: '#08090E',
                          display: 'grid',
                          placeItems: 'center',
                        }}
                      >
                        <div
                          style={{
                            width: 7,
                            height: 7,
                            borderRadius: 7,
                            backgroundColor: sm.color,
                            boxShadow: sm.pulse ? `0 0 6px ${sm.color}` : 'none',
                          }}
                        />
                      </div>
                    )}
                    {/* Decision count badge */}
                    {a.decs > 0 && (
                      <div
                        style={{
                          position: 'absolute',
                          bottom: -2,
                          right: -2,
                          minWidth: 14,
                          height: 14,
                          borderRadius: 7,
                          backgroundColor: '#08090E',
                          display: 'grid',
                          placeItems: 'center',
                          padding: '0 3px',
                        }}
                      >
                        <span
                          style={{
                            fontSize: 8,
                            fontWeight: 800,
                            color: '#FFD866',
                            fontFamily: "'JetBrains Mono',monospace",
                          }}
                        >
                          ⚡{a.decs}
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Agent name below node */}
                  <span
                    style={{
                      fontSize: 9,
                      color: isSel ? '#D1D5DB' : '#4B5563',
                      fontWeight: isSel ? 700 : 500,
                      maxWidth: nodeSize + 16,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      textAlign: 'center',
                    }}
                  >
                    {a.name}
                  </span>

                  {/* Decision dots below name */}
                  {agentDecs.length > 0 && (
                    <div style={{ display: 'flex', gap: 2 }}>
                      {agentDecs.map((d) => {
                        const dc = DC[d.type];
                        return (
                          <div
                            key={d.id}
                            onClick={(e) => {
                              e.stopPropagation();
                              onDecisionClick(d, { x: e.clientX, y: e.clientY });
                            }}
                            title={d.reasoning.summary}
                            style={{
                              width: 8,
                              height: 8,
                              borderRadius: 2,
                              cursor: 'pointer',
                              backgroundColor: `${dc?.color || '#555'}40`,
                              border: `1px solid ${dc?.color || '#555'}50`,
                              transition: 'all 0.15s',
                            }}
                            onMouseEnter={(e) => {
                              e.currentTarget.style.backgroundColor = dc?.color || '#555';
                              e.currentTarget.style.transform = 'scale(1.4)';
                            }}
                            onMouseLeave={(e) => {
                              e.currentTarget.style.backgroundColor = `${dc?.color || '#555'}40`;
                              e.currentTarget.style.transform = 'scale(1)';
                            }}
                          />
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Right summary */}
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexShrink: 0 }}>
          {totalDecs > 0 && (
            <span
              style={{
                fontSize: 11,
                color: '#FFD86680',
                fontWeight: 700,
                fontFamily: "'JetBrains Mono',monospace",
              }}
            >
              ⚡{totalDecs}
            </span>
          )}
          {gates > 0 && (
            <span
              style={{
                padding: '2px 8px',
                borderRadius: 4,
                fontSize: 10,
                fontWeight: 700,
                color: '#FFD866',
                backgroundColor: '#FFD86610',
                border: '1px solid #FFD86625',
              }}
            >
              👁 {gates}
            </span>
          )}
          <span
            style={{
              fontSize: 14,
              fontWeight: 800,
              color: healthColor,
              fontFamily: "'JetBrains Mono',monospace",
              width: 44,
              textAlign: 'right',
            }}
          >
            {overall}%
          </span>
          <span
            style={{
              fontSize: 11,
              color: '#4B5563',
              fontFamily: "'JetBrains Mono',monospace",
              width: 54,
              textAlign: 'right',
            }}
          >
            ${totalCost.toFixed(2)}
          </span>
        </div>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div
          style={{
            padding: '4px 18px 14px',
            borderTop: '1px solid rgba(255,255,255,0.04)',
            animation: 'expandIn 0.2s ease',
          }}
        >
          {/* Agent cards */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
              gap: 8,
              marginTop: 8,
            }}
          >
            {ordered.map((a) => {
              const sm = SM[a.status];
              const tm = TM[a.type];
              const isSel = selectedAgentId === a.id;
              return (
                <div
                  key={a.id}
                  onClick={() => onSelectAgent(a.id, task.id)}
                  style={{
                    padding: '10px 12px',
                    borderRadius: 8,
                    cursor: 'pointer',
                    backgroundColor: isSel ? `${tm.color}0A` : 'rgba(255,255,255,0.015)',
                    border: `1px solid ${isSel ? `${tm.color}30` : 'rgba(255,255,255,0.04)'}`,
                    position: 'relative',
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      right: 0,
                      height: 3,
                      backgroundColor: sm.color,
                      opacity: a.status === 'queued' ? 0.08 : 0.4,
                    }}
                  />
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      marginBottom: 6,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: 12, color: tm.color }}>{tm.icon}</span>
                      <span style={{ fontSize: 12, fontWeight: 700, color: '#E5E7EB' }}>
                        {a.name}
                      </span>
                    </div>
                    <span
                      style={{
                        padding: '2px 6px',
                        borderRadius: 3,
                        fontSize: 9,
                        fontWeight: 700,
                        color: sm.color,
                        backgroundColor: sm.bg,
                        border: `1px solid ${sm.border}`,
                        textTransform: 'uppercase',
                      }}
                    >
                      {sm.label}
                    </span>
                  </div>
                  <div
                    style={{
                      height: 3,
                      borderRadius: 2,
                      backgroundColor: 'rgba(255,255,255,0.04)',
                      overflow: 'hidden',
                      marginBottom: 6,
                    }}
                  >
                    <div
                      style={{
                        height: '100%',
                        width: `${a.progress}%`,
                        backgroundColor: sm.color,
                        transition: 'width 0.5s',
                        boxShadow: a.progress > 0 ? `0 0 6px ${sm.color}25` : 'none',
                      }}
                    />
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span
                      style={{
                        fontSize: 10,
                        color: '#4B5563',
                        fontFamily: "'JetBrains Mono',monospace",
                      }}
                    >
                      {a.tokens > 0 ? `${(a.tokens / 1000).toFixed(1)}k tok` : 'idle'}
                      {a.decs > 0 ? ` · ⚡${a.decs}` : ''}
                    </span>
                    <span
                      style={{
                        fontSize: 12,
                        fontWeight: 800,
                        color: sm.color,
                        fontFamily: "'JetBrains Mono',monospace",
                      }}
                    >
                      {Math.round(a.progress)}%
                    </span>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Inline recent decisions */}
          {recentDecs.length > 0 && (
            <div
              style={{
                marginTop: 8,
                padding: '8px 10px',
                borderRadius: 8,
                backgroundColor: 'rgba(255,216,102,0.025)',
                border: '1px solid rgba(255,216,102,0.08)',
              }}
            >
              <div
                style={{
                  fontSize: 9,
                  fontWeight: 700,
                  color: '#FFD86660',
                  letterSpacing: '0.08em',
                  marginBottom: 5,
                }}
              >
                RECENT DECISIONS
              </div>
              {recentDecs.map((d) => {
                const dc = DC[d.type];
                return (
                  <div
                    key={d.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      onDecisionClick(d, { x: e.clientX, y: e.clientY });
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '4px 0',
                      cursor: 'pointer',
                      borderRadius: 4,
                    }}
                    onMouseEnter={(e) =>
                      (e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.025)')
                    }
                    onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
                  >
                    <span style={{ fontSize: 11, color: dc?.color, flexShrink: 0 }}>
                      {dc?.icon}
                    </span>
                    <span
                      style={{
                        fontSize: 11,
                        color: '#9CA3AF',
                        flex: 1,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {d.reasoning.summary}
                    </span>
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: 2,
                        backgroundColor: confColor(d.confidence),
                        flexShrink: 0,
                      }}
                    />
                    <span
                      style={{
                        fontSize: 9,
                        color: '#374151',
                        fontFamily: "'JetBrains Mono',monospace",
                        flexShrink: 0,
                      }}
                    >
                      {fmtT(d.ts)}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ═══ MAIN ═════════════════════════════════════════════════════════════════════
export default function AgentFlowBig() {
  const [tasks, setTasks] = useState(createTasks);
  const [decisions, setDecisions] = useState([]);
  const [selectedAgentId, setSelectedAgentId] = useState(null);
  const [expandedTasks, setExpandedTasks] = useState(new Set(['t1']));
  const [simRunning, setSimRunning] = useState(true);
  const [simSpeed, setSimSpeed] = useState(1);
  const [popover, setPopover] = useState(null);
  const [popoverPos, setPopoverPos] = useState({ x: 0, y: 0 });
  const [showRail, setShowRail] = useState(false);
  const [railFilter, setRailFilter] = useState('all');
  const cpsRef = useRef(0);
  const [cps, setCps] = useState(0);

  const emitD = useCallback((d) => {
    setDecisions((prev) => [d, ...prev.slice(0, 499)]);
    cpsRef.current++;
  }, []);
  useEffect(() => {
    const iv = setInterval(() => {
      setCps(cpsRef.current);
      cpsRef.current = 0;
    }, 1000);
    return () => clearInterval(iv);
  }, []);
  useEffect(() => {
    if (!simRunning) return;
    const iv = setInterval(
      () => setTasks((prev) => simTick(prev, emitD)),
      Math.max(50, 350 / simSpeed)
    );
    return () => clearInterval(iv);
  }, [simRunning, simSpeed, emitD]);
  const handleOverride = useCallback((id) => {
    setDecisions((prev) => prev.map((d) => (d.id === id ? { ...d, overridden: true } : d)));
    setPopover((prev) => (prev?.id === id ? { ...prev, overridden: true } : prev));
  }, []);

  const allAgents = tasks.flatMap((t) => t.agents);
  const active = allAgents.filter((a) => a.status === 'running' || a.status === 'verifying').length;
  const tokens = allAgents.reduce((s, a) => s + a.tokens, 0);
  const cost = allAgents.reduce((s, a) => s + a.cost, 0);
  const gates = allAgents.filter(
    (a) => a.verification === 'human' && a.status === 'verifying'
  ).length;
  const statusCounts = {};
  Object.keys(SM).forEach(
    (s) => (statusCounts[s] = allAgents.filter((a) => a.status === s).length)
  );
  const decCounts = useMemo(() => {
    const c = {};
    decisions.forEach((d) => (c[d.type] = (c[d.type] || 0) + 1));
    return c;
  }, [decisions]);
  const railDecisions = useMemo(() => {
    let d = decisions;
    if (railFilter !== 'all') d = d.filter((x) => x.type === railFilter);
    return d.slice(0, 80);
  }, [decisions, railFilter]);

  return (
    <div
      style={{
        width: '100%',
        height: '100vh',
        backgroundColor: '#08090E',
        fontFamily: "'DM Sans',system-ui,sans-serif",
        color: '#D1D5DB',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,300;9..40,400;9..40,500;9..40,600;9..40,700;9..40,800&family=JetBrains+Mono:wght@400;500;600;700&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{width:5px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.06);border-radius:4px}
        @keyframes pulseGlow{0%,100%{opacity:.4}50%{opacity:1}}
        @keyframes shimmer{0%{transform:translateX(-200%)}100%{transform:translateX(300%)}}
        @keyframes slideIn{from{transform:translateX(-4px);opacity:0}to{transform:translateX(0);opacity:1}}
        @keyframes expandIn{from{opacity:0;max-height:0}to{opacity:1;max-height:1000px}}
        @keyframes flashN{0%{filter:brightness(1)}30%{filter:brightness(1.8)}100%{filter:brightness(1)}}
        @keyframes popIn{from{opacity:0;transform:scale(0.95) translateY(-4px)}to{opacity:1;transform:scale(1) translateY(0)}}
      `}</style>

      {/* ═══ HEADER ═══════════════════════════════════════════════════════ */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 20px',
          borderBottom: '1px solid rgba(255,255,255,0.05)',
          backgroundColor: 'rgba(8,9,14,0.95)',
          flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div
              style={{
                width: 24,
                height: 24,
                borderRadius: 6,
                background: 'linear-gradient(135deg, #67E8F9, #A78BFA)',
                display: 'grid',
                placeItems: 'center',
                fontSize: 12,
                fontWeight: 900,
                color: '#08090E',
              }}
            >
              ◇
            </div>
            <span style={{ fontSize: 14, fontWeight: 800, color: '#F3F4F6' }}>AgentFlow</span>
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              padding: '3px 8px',
              borderRadius: 5,
              backgroundColor: 'rgba(255,255,255,0.03)',
              border: '1px solid rgba(255,255,255,0.05)',
            }}
          >
            <button
              onClick={() => setSimRunning(!simRunning)}
              style={{
                width: 20,
                height: 20,
                borderRadius: 4,
                border: 'none',
                backgroundColor: simRunning ? 'rgba(52,211,153,0.12)' : 'rgba(255,255,255,0.05)',
                color: simRunning ? '#34D399' : '#6B7280',
                fontSize: 9,
                cursor: 'pointer',
                display: 'grid',
                placeItems: 'center',
              }}
            >
              {simRunning ? '⏸' : '▶'}
            </button>
            {[1, 3, 8].map((s) => (
              <button
                key={s}
                onClick={() => setSimSpeed(s)}
                style={{
                  padding: '2px 6px',
                  borderRadius: 3,
                  border: 'none',
                  backgroundColor: simSpeed === s ? 'rgba(103,232,249,0.1)' : 'transparent',
                  color: simSpeed === s ? '#67E8F9' : '#374151',
                  fontSize: 10,
                  fontWeight: 700,
                  cursor: 'pointer',
                  fontFamily: "'JetBrains Mono',monospace",
                }}
              >
                {s}x
              </button>
            ))}
          </div>
          <span
            style={{
              fontSize: 10,
              color: cps > 0 ? '#34D399' : '#374151',
              fontWeight: 700,
              fontFamily: "'JetBrains Mono',monospace",
            }}
          >
            ● {cps}/s
          </span>
          {/* Status bar */}
          <div
            style={{
              display: 'flex',
              gap: 2,
              height: 20,
              borderRadius: 4,
              overflow: 'hidden',
              width: 180,
            }}
          >
            {Object.entries(SM).map(([s, m]) =>
              statusCounts[s] ? (
                <div
                  key={s}
                  style={{
                    flex: statusCounts[s],
                    backgroundColor: m.bg,
                    borderTop: `2.5px solid ${m.color}`,
                    display: 'grid',
                    placeItems: 'center',
                    position: 'relative',
                    overflow: 'hidden',
                    transition: 'flex 0.6s',
                    minWidth: 12,
                  }}
                >
                  {m.pulse && (
                    <div
                      style={{
                        position: 'absolute',
                        inset: 0,
                        opacity: 0.1,
                        background: `linear-gradient(90deg, transparent, ${m.color}40, transparent)`,
                        animation: 'shimmer 3s ease infinite',
                      }}
                    />
                  )}
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 900,
                      color: m.color,
                      fontFamily: "'JetBrains Mono',monospace",
                      position: 'relative',
                    }}
                  >
                    {statusCounts[s]}
                  </span>
                </div>
              ) : null
            )}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 20, alignItems: 'center' }}>
          {[
            { l: 'AGENTS', v: `${active}/${allAgents.length}`, c: '#34D399' },
            { l: 'TOKENS', v: `${(tokens / 1000).toFixed(0)}k`, c: '#67E8F9' },
            { l: 'COST', v: `$${cost.toFixed(2)}`, c: '#A78BFA' },
            { l: 'DECISIONS', v: decisions.length, c: '#FFD866' },
          ].map((s) => (
            <div key={s.l} style={{ textAlign: 'right' }}>
              <div
                style={{ fontSize: 8, color: '#374151', fontWeight: 600, letterSpacing: '0.1em' }}
              >
                {s.l}
              </div>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 800,
                  color: s.c,
                  fontFamily: "'JetBrains Mono',monospace",
                }}
              >
                {s.v}
              </div>
            </div>
          ))}
          {gates > 0 && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                padding: '4px 10px',
                borderRadius: 5,
                backgroundColor: '#FFD86608',
                border: '1px solid #FFD86620',
                animation: 'pulseGlow 2s ease infinite',
              }}
            >
              <span style={{ fontSize: 11 }}>👁</span>
              <span style={{ fontSize: 11, fontWeight: 700, color: '#FFD866' }}>{gates}</span>
            </div>
          )}
          <button
            onClick={() => setShowRail(!showRail)}
            style={{
              padding: '4px 10px',
              borderRadius: 5,
              border: `1px solid ${showRail ? '#FFD86625' : 'rgba(255,255,255,0.06)'}`,
              backgroundColor: showRail ? '#FFD86608' : 'transparent',
              color: showRail ? '#FFD866' : '#4B5563',
              fontSize: 10,
              fontWeight: 700,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            ⚡ Log
          </button>
        </div>
      </div>

      {/* ═══ BODY ══════════════════════════════════════════════════════════ */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <div style={{ flex: 1, overflowY: 'auto', padding: '10px 16px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {tasks.map((task) => (
              <PipelineRow
                key={task.id}
                task={task}
                decisions={decisions}
                selectedAgentId={selectedAgentId}
                onSelectAgent={(aid, tid) => setSelectedAgentId(aid)}
                expanded={expandedTasks.has(task.id)}
                onToggle={() =>
                  setExpandedTasks((prev) => {
                    const n = new Set(prev);
                    n.has(task.id) ? n.delete(task.id) : n.add(task.id);
                    return n;
                  })
                }
                onDecisionClick={(d, pos) => {
                  setPopover(d);
                  setPopoverPos(pos);
                }}
              />
            ))}
          </div>
        </div>

        {/* Rail */}
        {showRail && (
          <div
            style={{
              width: 280,
              borderLeft: '1px solid rgba(255,255,255,0.05)',
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
              backgroundColor: 'rgba(255,255,255,0.008)',
              flexShrink: 0,
              animation: 'slideIn 0.15s ease',
            }}
          >
            <div
              style={{
                padding: '8px 10px',
                borderBottom: '1px solid rgba(255,255,255,0.04)',
                display: 'flex',
                gap: 3,
                flexWrap: 'wrap',
                flexShrink: 0,
              }}
            >
              <button
                onClick={() => setRailFilter('all')}
                style={{
                  padding: '3px 7px',
                  borderRadius: 3,
                  border: 'none',
                  backgroundColor: railFilter === 'all' ? 'rgba(255,255,255,0.06)' : 'transparent',
                  color: railFilter === 'all' ? '#D1D5DB' : '#374151',
                  fontSize: 9,
                  fontWeight: 700,
                  cursor: 'pointer',
                }}
              >
                All
              </button>
              {Object.entries(DC).map(([type, meta]) => {
                const cnt = decCounts[type] || 0;
                if (!cnt) return null;
                return (
                  <button
                    key={type}
                    onClick={() => setRailFilter(railFilter === type ? 'all' : type)}
                    style={{
                      padding: '3px 7px',
                      borderRadius: 3,
                      border: 'none',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 3,
                      backgroundColor: railFilter === type ? `${meta.color}12` : 'transparent',
                      color: railFilter === type ? meta.color : '#374151',
                      fontSize: 9,
                      cursor: 'pointer',
                    }}
                  >
                    <span>{meta.icon}</span>
                    <span style={{ fontWeight: 700, fontFamily: "'JetBrains Mono',monospace" }}>
                      {cnt}
                    </span>
                  </button>
                );
              })}
            </div>
            <div style={{ flex: 1, overflowY: 'auto' }}>
              {railDecisions.map((d, i) => {
                const dc = DC[d.type];
                const cc = confColor(d.confidence);
                return (
                  <div
                    key={d.id}
                    onClick={(e) => {
                      setPopover(d);
                      setPopoverPos({ x: e.clientX - 380, y: e.clientY });
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '5px 10px',
                      cursor: 'pointer',
                      borderBottom: '1px solid rgba(255,255,255,0.02)',
                      opacity: Math.max(0.3, 1 - i * 0.012),
                      animation: i === 0 ? 'slideIn 0.2s ease' : 'none',
                    }}
                    onMouseEnter={(e) =>
                      (e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.02)')
                    }
                    onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
                  >
                    <span style={{ fontSize: 11, color: dc?.color, flexShrink: 0 }}>
                      {dc?.icon}
                    </span>
                    <span
                      style={{
                        fontSize: 10,
                        color: '#9CA3AF',
                        flex: 1,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {d.reasoning.summary}
                    </span>
                    <span
                      style={{
                        width: 5,
                        height: 5,
                        borderRadius: 2,
                        backgroundColor: cc,
                        flexShrink: 0,
                      }}
                    />
                    <span
                      style={{
                        fontSize: 8,
                        color: '#2A2D35',
                        fontFamily: "'JetBrains Mono',monospace",
                        flexShrink: 0,
                      }}
                    >
                      {fmtT(d.ts)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <Popover
        d={popover}
        pos={popoverPos}
        onClose={() => setPopover(null)}
        onOverride={handleOverride}
      />
    </div>
  );
}
