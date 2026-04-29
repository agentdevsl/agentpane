# Vendored Kubernetes manifests

This directory contains upstream Kubernetes manifests that AgentPane applies
at bootstrap. Vendoring (rather than fetching at runtime) closes the supply-
chain hole tracked as **arch29-W1-C / F04-11**: the previous bootstrap path
shelled out to:

```
kubectl apply -f https://github.com/kubernetes-sigs/agent-sandbox/releases/latest/download/install.yaml
```

A compromise of either the upstream repository or the release process would
land a malicious controller in every cluster running auto-install. The
vendored copy is reviewed at PR time and verified against a SHA-256 checksum
at apply time.

## Files

| File | Source | SHA-256 sidecar |
| --- | --- | --- |
| `agent-sandbox-v0.4.3.yaml` | <https://github.com/kubernetes-sigs/agent-sandbox/releases/download/v0.4.3/manifest.yaml> | `agent-sandbox-v0.4.3.yaml.sha256` |
| `agent-sandbox-extensions-v0.4.3.yaml` | <https://github.com/kubernetes-sigs/agent-sandbox/releases/download/v0.4.3/extensions.yaml> | `agent-sandbox-extensions-v0.4.3.yaml.sha256` |

## Rotation procedure

1. Pick a new release at <https://github.com/kubernetes-sigs/agent-sandbox/releases>.
2. Download the assets:

   ```bash
   TAG=v0.5.0
   curl -sSL "https://github.com/kubernetes-sigs/agent-sandbox/releases/download/$TAG/manifest.yaml" \
     -o "k8s/vendored/agent-sandbox-$TAG.yaml"
   curl -sSL "https://github.com/kubernetes-sigs/agent-sandbox/releases/download/$TAG/extensions.yaml" \
     -o "k8s/vendored/agent-sandbox-extensions-$TAG.yaml"
   ```

3. Compute checksums and update the `.sha256` sidecar files.
4. Update `VENDORED_AGENT_SANDBOX_MANIFEST` and `VENDORED_AGENT_SANDBOX_SHA256`
   in `src/server/bootstrap/sandbox/k8s-init.ts`.
5. Run the regression suite: `bun vitest run tests/integration/k8s-bootstrap-vendored-manifest.test.ts`.
6. Open a PR, the diff will surface every changed manifest line for review.
