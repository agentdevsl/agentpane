/**
 * @vitest-environment node
 *
 * Tests for K8s error types — covers all error constructors, error codes,
 * HTTP statuses, messages, and detail payloads.
 */
import { describe, expect, it } from 'vitest';

import { K8S_ERROR_IDS, K8sErrors } from '@/lib/errors/k8s-errors';

// =============================================================================
// K8S_ERROR_IDS constant tests
// =============================================================================

describe('K8S_ERROR_IDS', () => {
  it('defines cluster connectivity error IDs in the 001-099 range', () => {
    expect(K8S_ERROR_IDS.CLUSTER_UNREACHABLE).toBe('K8S-001');
    expect(K8S_ERROR_IDS.KUBECONFIG_NOT_FOUND).toBe('K8S-002');
    expect(K8S_ERROR_IDS.KUBECONFIG_INVALID).toBe('K8S-003');
    expect(K8S_ERROR_IDS.CONTEXT_NOT_FOUND).toBe('K8S-004');
  });

  it('defines namespace error IDs in the 100-199 range', () => {
    expect(K8S_ERROR_IDS.NAMESPACE_NOT_FOUND).toBe('K8S-100');
    expect(K8S_ERROR_IDS.NAMESPACE_CREATION_FAILED).toBe('K8S-101');
    expect(K8S_ERROR_IDS.NAMESPACE_ACCESS_DENIED).toBe('K8S-102');
  });

  it('defines pod lifecycle error IDs in the 200-299 range', () => {
    expect(K8S_ERROR_IDS.POD_NOT_FOUND).toBe('K8S-200');
    expect(K8S_ERROR_IDS.POD_CREATION_FAILED).toBe('K8S-201');
    expect(K8S_ERROR_IDS.POD_STARTUP_TIMEOUT).toBe('K8S-202');
    expect(K8S_ERROR_IDS.POD_DELETION_FAILED).toBe('K8S-203');
    expect(K8S_ERROR_IDS.POD_NOT_RUNNING).toBe('K8S-204');
    expect(K8S_ERROR_IDS.POD_ALREADY_EXISTS).toBe('K8S-205');
  });

  it('defines exec error IDs in the 300-399 range', () => {
    expect(K8S_ERROR_IDS.EXEC_FAILED).toBe('K8S-300');
    expect(K8S_ERROR_IDS.EXEC_TIMEOUT).toBe('K8S-301');
    expect(K8S_ERROR_IDS.EXEC_CONNECTION_FAILED).toBe('K8S-302');
  });

  it('defines image error IDs in the 400-499 range', () => {
    expect(K8S_ERROR_IDS.IMAGE_PULL_FAILED).toBe('K8S-400');
    expect(K8S_ERROR_IDS.IMAGE_PULL_BACKOFF).toBe('K8S-401');
    expect(K8S_ERROR_IDS.IMAGE_NOT_FOUND).toBe('K8S-402');
  });

  it('defines warm pool error IDs in the 1100-1199 range', () => {
    expect(K8S_ERROR_IDS.WARM_POOL_EMPTY).toBe('K8S-1100');
    expect(K8S_ERROR_IDS.WARM_POOL_EXHAUSTED).toBe('K8S-1101');
    expect(K8S_ERROR_IDS.WARM_POOL_ALLOCATION_FAILED).toBe('K8S-1102');
    expect(K8S_ERROR_IDS.WARM_POOL_NOT_ENABLED).toBe('K8S-1103');
    expect(K8S_ERROR_IDS.WARM_POD_NOT_FOUND).toBe('K8S-1104');
    expect(K8S_ERROR_IDS.WARM_POOL_DISCOVERY_FAILED).toBe('K8S-1105');
  });
});

// =============================================================================
// K8sErrors — Cluster connectivity
// =============================================================================

describe('K8sErrors - Cluster connectivity', () => {
  it('CLUSTER_UNREACHABLE has code, message with reason, and status 503', () => {
    const error = K8sErrors.CLUSTER_UNREACHABLE('connection refused');

    expect(error.code).toBe('K8S_CLUSTER_UNREACHABLE');
    expect(error.message).toContain('connection refused');
    expect(error.status).toBe(503);
  });

  it('KUBECONFIG_NOT_FOUND with path includes path in message and details', () => {
    const error = K8sErrors.KUBECONFIG_NOT_FOUND('/home/user/.kube/config');

    expect(error.code).toBe('K8S_KUBECONFIG_NOT_FOUND');
    expect(error.message).toContain('/home/user/.kube/config');
    expect(error.status).toBe(404);
    expect(error.details).toEqual({ path: '/home/user/.kube/config' });
  });

  it('KUBECONFIG_NOT_FOUND without path uses generic message', () => {
    const error = K8sErrors.KUBECONFIG_NOT_FOUND();

    expect(error.code).toBe('K8S_KUBECONFIG_NOT_FOUND');
    expect(error.message).toBe('Kubeconfig not found');
    expect(error.status).toBe(404);
  });

  it('KUBECONFIG_INVALID has status 400 and includes the reason', () => {
    const error = K8sErrors.KUBECONFIG_INVALID('invalid YAML');

    expect(error.code).toBe('K8S_KUBECONFIG_INVALID');
    expect(error.message).toContain('invalid YAML');
    expect(error.status).toBe(400);
  });

  it('CONTEXT_NOT_FOUND has status 404 and context detail', () => {
    const error = K8sErrors.CONTEXT_NOT_FOUND('minikube');

    expect(error.code).toBe('K8S_CONTEXT_NOT_FOUND');
    expect(error.message).toContain('minikube');
    expect(error.status).toBe(404);
    expect(error.details).toEqual({ context: 'minikube' });
  });
});

// =============================================================================
// K8sErrors — Namespace
// =============================================================================

describe('K8sErrors - Namespace', () => {
  it('NAMESPACE_NOT_FOUND has status 404 and namespace detail', () => {
    const error = K8sErrors.NAMESPACE_NOT_FOUND('agentpane-sandboxes');

    expect(error.code).toBe('K8S_NAMESPACE_NOT_FOUND');
    expect(error.message).toContain('agentpane-sandboxes');
    expect(error.status).toBe(404);
    expect(error.details).toEqual({ namespace: 'agentpane-sandboxes' });
  });

  it('NAMESPACE_CREATION_FAILED has status 500 with namespace detail', () => {
    const error = K8sErrors.NAMESPACE_CREATION_FAILED('test-ns', 'quota exceeded');

    expect(error.code).toBe('K8S_NAMESPACE_CREATION_FAILED');
    expect(error.message).toContain('test-ns');
    expect(error.message).toContain('quota exceeded');
    expect(error.status).toBe(500);
    expect(error.details).toEqual({ namespace: 'test-ns' });
  });

  it('NAMESPACE_ACCESS_DENIED has status 403 with namespace detail', () => {
    const error = K8sErrors.NAMESPACE_ACCESS_DENIED('kube-system');

    expect(error.code).toBe('K8S_NAMESPACE_ACCESS_DENIED');
    expect(error.message).toContain('kube-system');
    expect(error.status).toBe(403);
    expect(error.details).toEqual({ namespace: 'kube-system' });
  });
});

// =============================================================================
// K8sErrors — Pod lifecycle
// =============================================================================

describe('K8sErrors - Pod lifecycle', () => {
  it('POD_NOT_FOUND has status 404 with podName and namespace', () => {
    const error = K8sErrors.POD_NOT_FOUND('agent-pod-1', 'sandboxes');

    expect(error.code).toBe('K8S_POD_NOT_FOUND');
    expect(error.message).toContain('agent-pod-1');
    expect(error.message).toContain('sandboxes');
    expect(error.status).toBe(404);
    expect(error.details).toEqual({ podName: 'agent-pod-1', namespace: 'sandboxes' });
  });

  it('POD_CREATION_FAILED has status 500 with podName detail', () => {
    const error = K8sErrors.POD_CREATION_FAILED('my-pod', 'image not found');

    expect(error.code).toBe('K8S_POD_CREATION_FAILED');
    expect(error.message).toContain('my-pod');
    expect(error.message).toContain('image not found');
    expect(error.status).toBe(500);
    expect(error.details).toEqual({ podName: 'my-pod' });
  });

  it('POD_STARTUP_TIMEOUT has status 408 with podName and timeoutSeconds', () => {
    const error = K8sErrors.POD_STARTUP_TIMEOUT('slow-pod', 60);

    expect(error.code).toBe('K8S_POD_STARTUP_TIMEOUT');
    expect(error.message).toContain('slow-pod');
    expect(error.message).toContain('60');
    expect(error.status).toBe(408);
    expect(error.details).toEqual({ podName: 'slow-pod', timeoutSeconds: 60 });
  });

  it('POD_DELETION_FAILED has status 500 with podName detail', () => {
    const error = K8sErrors.POD_DELETION_FAILED('old-pod', 'finalizer stuck');

    expect(error.code).toBe('K8S_POD_DELETION_FAILED');
    expect(error.message).toContain('old-pod');
    expect(error.message).toContain('finalizer stuck');
    expect(error.status).toBe(500);
    expect(error.details).toEqual({ podName: 'old-pod' });
  });

  it('POD_NOT_RUNNING has status 400 with podName and currentPhase', () => {
    const error = K8sErrors.POD_NOT_RUNNING('stuck-pod', 'Pending');

    expect(error.code).toBe('K8S_POD_NOT_RUNNING');
    expect(error.message).toContain('stuck-pod');
    expect(error.message).toContain('Pending');
    expect(error.status).toBe(400);
    expect(error.details).toEqual({ podName: 'stuck-pod', currentPhase: 'Pending' });
  });

  it('POD_ALREADY_EXISTS has status 409 with codespaceId detail', () => {
    const error = K8sErrors.POD_ALREADY_EXISTS('proj-123');

    expect(error.code).toBe('K8S_POD_ALREADY_EXISTS');
    expect(error.status).toBe(409);
    expect(error.details).toEqual({ codespaceId: 'proj-123' });
  });
});

// =============================================================================
// K8sErrors — Exec
// =============================================================================

describe('K8sErrors - Exec', () => {
  it('EXEC_FAILED has status 500 with command detail', () => {
    const error = K8sErrors.EXEC_FAILED('npm install', 'exit code 1');

    expect(error.code).toBe('K8S_EXEC_FAILED');
    expect(error.message).toContain('exit code 1');
    expect(error.status).toBe(500);
    expect(error.details).toEqual({ command: 'npm install' });
  });

  it('EXEC_TIMEOUT has status 408 with command and timeoutMs', () => {
    const error = K8sErrors.EXEC_TIMEOUT('long-running-cmd', 30_000);

    expect(error.code).toBe('K8S_EXEC_TIMEOUT');
    expect(error.message).toContain('30000');
    expect(error.status).toBe(408);
    expect(error.details).toEqual({ command: 'long-running-cmd', timeoutMs: 30_000 });
  });

  it('EXEC_CONNECTION_FAILED has status 503 with podName detail', () => {
    const error = K8sErrors.EXEC_CONNECTION_FAILED('agent-pod', 'WebSocket error');

    expect(error.code).toBe('K8S_EXEC_CONNECTION_FAILED');
    expect(error.message).toContain('agent-pod');
    expect(error.message).toContain('WebSocket error');
    expect(error.status).toBe(503);
    expect(error.details).toEqual({ podName: 'agent-pod' });
  });
});

// =============================================================================
// K8sErrors — Image
// =============================================================================

describe('K8sErrors - Image', () => {
  it('IMAGE_PULL_FAILED has status 500 with image detail', () => {
    const error = K8sErrors.IMAGE_PULL_FAILED('ghcr.io/agent:v1', 'auth required');

    expect(error.code).toBe('K8S_IMAGE_PULL_FAILED');
    expect(error.message).toContain('ghcr.io/agent:v1');
    expect(error.message).toContain('auth required');
    expect(error.status).toBe(500);
    expect(error.details).toEqual({ image: 'ghcr.io/agent:v1' });
  });

  it('IMAGE_PULL_BACKOFF has status 500 with image and reason', () => {
    const error = K8sErrors.IMAGE_PULL_BACKOFF('node:20', 'rate limit');

    expect(error.code).toBe('K8S_IMAGE_PULL_BACKOFF');
    expect(error.message).toContain('node:20');
    expect(error.message).toContain('rate limit');
    expect(error.status).toBe(500);
    expect(error.details).toEqual({ image: 'node:20', reason: 'rate limit' });
  });

  it('IMAGE_NOT_FOUND has status 404 with image detail', () => {
    const error = K8sErrors.IMAGE_NOT_FOUND('missing-image:latest');

    expect(error.code).toBe('K8S_IMAGE_NOT_FOUND');
    expect(error.message).toContain('missing-image:latest');
    expect(error.status).toBe(404);
    expect(error.details).toEqual({ image: 'missing-image:latest' });
  });
});

// =============================================================================
// K8sErrors — tmux
// =============================================================================

describe('K8sErrors - tmux', () => {
  it('TMUX_SESSION_NOT_FOUND has status 404 with sessionName detail', () => {
    const error = K8sErrors.TMUX_SESSION_NOT_FOUND('main');

    expect(error.code).toBe('K8S_TMUX_SESSION_NOT_FOUND');
    expect(error.message).toContain('main');
    expect(error.status).toBe(404);
    expect(error.details).toEqual({ sessionName: 'main' });
  });

  it('TMUX_SESSION_ALREADY_EXISTS has status 409 with sessionName detail', () => {
    const error = K8sErrors.TMUX_SESSION_ALREADY_EXISTS('agent-session');

    expect(error.code).toBe('K8S_TMUX_SESSION_EXISTS');
    expect(error.message).toContain('agent-session');
    expect(error.status).toBe(409);
    expect(error.details).toEqual({ sessionName: 'agent-session' });
  });

  it('TMUX_CREATION_FAILED has status 500 with sessionName detail', () => {
    const error = K8sErrors.TMUX_CREATION_FAILED('new-session', 'tmux not installed');

    expect(error.code).toBe('K8S_TMUX_CREATION_FAILED');
    expect(error.message).toContain('tmux not installed');
    expect(error.status).toBe(500);
    expect(error.details).toEqual({ sessionName: 'new-session' });
  });
});

// =============================================================================
// K8sErrors — Resources
// =============================================================================

describe('K8sErrors - Resources', () => {
  it('INSUFFICIENT_RESOURCES has status 400 with resource, requested, and available', () => {
    const error = K8sErrors.INSUFFICIENT_RESOURCES('memory', '4Gi', '2Gi');

    expect(error.code).toBe('K8S_INSUFFICIENT_RESOURCES');
    expect(error.message).toContain('memory');
    expect(error.message).toContain('4Gi');
    expect(error.message).toContain('2Gi');
    expect(error.status).toBe(400);
    expect(error.details).toEqual({ resource: 'memory', requested: '4Gi', available: '2Gi' });
  });
});

// =============================================================================
// K8sErrors — API / Internal
// =============================================================================

describe('K8sErrors - API and Internal', () => {
  it('API_ERROR uses the provided statusCode as the HTTP status', () => {
    const error = K8sErrors.API_ERROR(503, 'service unavailable');

    expect(error.code).toBe('K8S_API_ERROR');
    expect(error.message).toContain('503');
    expect(error.message).toContain('service unavailable');
    expect(error.status).toBe(503);
  });

  it('INTERNAL_ERROR has status 500 with the given message', () => {
    const error = K8sErrors.INTERNAL_ERROR('unexpected state');

    expect(error.code).toBe('K8S_INTERNAL_ERROR');
    expect(error.message).toBe('unexpected state');
    expect(error.status).toBe(500);
  });
});

// =============================================================================
// K8sErrors — Network Policy
// =============================================================================

describe('K8sErrors - Network Policy', () => {
  it('NETWORK_POLICY_CREATION_FAILED has status 500 with policyName detail', () => {
    const error = K8sErrors.NETWORK_POLICY_CREATION_FAILED('deny-all', 'namespace not found');

    expect(error.code).toBe('K8S_NETWORK_POLICY_CREATION_FAILED');
    expect(error.message).toContain('deny-all');
    expect(error.message).toContain('namespace not found');
    expect(error.status).toBe(500);
    expect(error.details).toEqual({ policyName: 'deny-all' });
  });

  it('NETWORK_POLICY_NOT_FOUND has status 404 with policyName and namespace', () => {
    const error = K8sErrors.NETWORK_POLICY_NOT_FOUND('allow-egress', 'sandboxes');

    expect(error.code).toBe('K8S_NETWORK_POLICY_NOT_FOUND');
    expect(error.message).toContain('allow-egress');
    expect(error.message).toContain('sandboxes');
    expect(error.status).toBe(404);
    expect(error.details).toEqual({ policyName: 'allow-egress', namespace: 'sandboxes' });
  });

  it('NETWORK_POLICY_UPDATE_FAILED has status 500 with policyName detail', () => {
    const error = K8sErrors.NETWORK_POLICY_UPDATE_FAILED('ingress-policy', 'conflict');

    expect(error.code).toBe('K8S_NETWORK_POLICY_UPDATE_FAILED');
    expect(error.message).toContain('ingress-policy');
    expect(error.message).toContain('conflict');
    expect(error.status).toBe(500);
    expect(error.details).toEqual({ policyName: 'ingress-policy' });
  });

  it('NETWORK_POLICY_DELETION_FAILED has status 500 with policyName detail', () => {
    const error = K8sErrors.NETWORK_POLICY_DELETION_FAILED('old-policy', 'in use');

    expect(error.code).toBe('K8S_NETWORK_POLICY_DELETION_FAILED');
    expect(error.message).toContain('old-policy');
    expect(error.message).toContain('in use');
    expect(error.status).toBe(500);
    expect(error.details).toEqual({ policyName: 'old-policy' });
  });
});

// =============================================================================
// K8sErrors — RBAC
// =============================================================================

describe('K8sErrors - RBAC', () => {
  it('SERVICE_ACCOUNT_CREATION_FAILED has status 500 with name detail', () => {
    const error = K8sErrors.SERVICE_ACCOUNT_CREATION_FAILED('agent-sa', 'exists');

    expect(error.code).toBe('K8S_SERVICE_ACCOUNT_CREATION_FAILED');
    expect(error.message).toContain('agent-sa');
    expect(error.message).toContain('exists');
    expect(error.status).toBe(500);
    expect(error.details).toEqual({ name: 'agent-sa' });
  });

  it('ROLE_CREATION_FAILED has status 500 with name detail', () => {
    const error = K8sErrors.ROLE_CREATION_FAILED('sandbox-role', 'invalid spec');

    expect(error.code).toBe('K8S_ROLE_CREATION_FAILED');
    expect(error.message).toContain('sandbox-role');
    expect(error.message).toContain('invalid spec');
    expect(error.status).toBe(500);
    expect(error.details).toEqual({ name: 'sandbox-role' });
  });

  it('ROLE_BINDING_CREATION_FAILED has status 500 with name detail', () => {
    const error = K8sErrors.ROLE_BINDING_CREATION_FAILED('binding-1', 'role not found');

    expect(error.code).toBe('K8S_ROLE_BINDING_CREATION_FAILED');
    expect(error.message).toContain('binding-1');
    expect(error.message).toContain('role not found');
    expect(error.status).toBe(500);
    expect(error.details).toEqual({ name: 'binding-1' });
  });

  it('LIMIT_RANGE_CREATION_FAILED has status 500 with name detail', () => {
    const error = K8sErrors.LIMIT_RANGE_CREATION_FAILED('cpu-limit', 'invalid range');

    expect(error.code).toBe('K8S_LIMIT_RANGE_CREATION_FAILED');
    expect(error.message).toContain('cpu-limit');
    expect(error.message).toContain('invalid range');
    expect(error.status).toBe(500);
    expect(error.details).toEqual({ name: 'cpu-limit' });
  });
});

// =============================================================================
// K8sErrors — Security
// =============================================================================

describe('K8sErrors - Security', () => {
  it('POD_SECURITY_VIOLATION has status 400 with podName and violation details', () => {
    const error = K8sErrors.POD_SECURITY_VIOLATION('bad-pod', 'privileged container');

    expect(error.code).toBe('K8S_POD_SECURITY_VIOLATION');
    expect(error.message).toContain('bad-pod');
    expect(error.message).toContain('privileged container');
    expect(error.status).toBe(400);
    expect(error.details).toEqual({ podName: 'bad-pod', violation: 'privileged container' });
  });
});

// =============================================================================
// K8sErrors — Warm Pool
// =============================================================================

describe('K8sErrors - Warm Pool', () => {
  it('WARM_POOL_EMPTY has status 503 with no details', () => {
    const error = K8sErrors.WARM_POOL_EMPTY();

    expect(error.code).toBe('K8S_WARM_POOL_EMPTY');
    expect(error.message).toContain('No warm pods available');
    expect(error.status).toBe(503);
  });

  it('WARM_POOL_EXHAUSTED has status 503 with maxSize detail', () => {
    const error = K8sErrors.WARM_POOL_EXHAUSTED(10);

    expect(error.code).toBe('K8S_WARM_POOL_EXHAUSTED');
    expect(error.message).toContain('10');
    expect(error.status).toBe(503);
    expect(error.details).toEqual({ maxSize: 10 });
  });

  it('WARM_POOL_ALLOCATION_FAILED has status 500 with podName detail', () => {
    const error = K8sErrors.WARM_POOL_ALLOCATION_FAILED('warm-pod-3', 'already claimed');

    expect(error.code).toBe('K8S_WARM_POOL_ALLOCATION_FAILED');
    expect(error.message).toContain('warm-pod-3');
    expect(error.message).toContain('already claimed');
    expect(error.status).toBe(500);
    expect(error.details).toEqual({ podName: 'warm-pod-3' });
  });

  it('WARM_POOL_NOT_ENABLED has status 400', () => {
    const error = K8sErrors.WARM_POOL_NOT_ENABLED();

    expect(error.code).toBe('K8S_WARM_POOL_NOT_ENABLED');
    expect(error.message).toContain('not enabled');
    expect(error.status).toBe(400);
  });

  it('WARM_POD_NOT_FOUND has status 404 with podName detail', () => {
    const error = K8sErrors.WARM_POD_NOT_FOUND('warm-pod-7');

    expect(error.code).toBe('K8S_WARM_POD_NOT_FOUND');
    expect(error.message).toContain('warm-pod-7');
    expect(error.status).toBe(404);
    expect(error.details).toEqual({ podName: 'warm-pod-7' });
  });

  it('WARM_POOL_DISCOVERY_FAILED has status 500', () => {
    const error = K8sErrors.WARM_POOL_DISCOVERY_FAILED('label selector error');

    expect(error.code).toBe('K8S_WARM_POOL_DISCOVERY_FAILED');
    expect(error.message).toContain('label selector error');
    expect(error.status).toBe(500);
  });
});

// =============================================================================
// K8sErrors — toString behavior
// =============================================================================

describe('K8sErrors - toString', () => {
  it('all errors return their message from toString()', () => {
    const error = K8sErrors.CLUSTER_UNREACHABLE('timeout');
    expect(error.toString()).toBe(error.message);
  });
});
