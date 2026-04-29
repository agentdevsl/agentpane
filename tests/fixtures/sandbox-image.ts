/**
 * Shared sandbox-image fixture used by tests that exercise the production
 * image-handling code path (provider create / pullImage / DB persistence).
 *
 * arch29-W1-C / F04-01: tests must not reference mutable tags like
 * `srlynch1/agent-sandbox:latest` because:
 *   1. CI runners would pull from Docker Hub on every run, opening a
 *      typo-squat / account-compromise vector inside CI.
 *   2. The CI gate `! grep -RE "srlynch1/[^:]+:latest" docker/ k8s/ tests/ src/`
 *      rejects exactly that string.
 *
 * Use this constant whenever a test needs a "realistic" production image
 * reference. For unit tests that explicitly verify rejection of tag-only
 * refs, keep the literal string `srlynch1/agent-sandbox:latest` inline so
 * the test continues to assert the observable behaviour.
 *
 * The digest below is the multi-arch OCI index digest of
 * `srlynch1/agent-sandbox:latest` resolved via `docker manifest inspect`,
 * matching `SANDBOX_DEFAULTS.image` in `src/lib/sandbox/types.ts`.
 */
export const TEST_AGENT_SANDBOX_IMAGE =
  'docker.io/srlynch1/agent-sandbox@sha256:9b04cfd8f030360efb7fbd1023ce79b228b61edf82dbc0d82c38c867633d4126';

/**
 * Convenience alias used by older test suites that referenced
 * `srlynch1/agent-sandbox:latest` directly. New tests should import
 * `TEST_AGENT_SANDBOX_IMAGE`.
 */
export const TEST_AGENT_SANDBOX_LEGACY_REF = TEST_AGENT_SANDBOX_IMAGE;
