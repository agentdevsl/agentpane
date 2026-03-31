#!/bin/bash
# AgentPane Kubernetes Teardown Script (Minikube)
#
# Tears down AgentPane Kubernetes resources with three modes:
#   --resources  Delete CRD resources only (default)
#   --stop       Delete resources + stop minikube
#   --delete     Delete resources + delete minikube cluster entirely
#
# Usage:
#   ./scripts/k8s-teardown-minikube.sh               # Delete CRD resources only
#   ./scripts/k8s-teardown-minikube.sh --resources    # Same as above (explicit)
#   ./scripts/k8s-teardown-minikube.sh --stop         # Resources + stop minikube
#   ./scripts/k8s-teardown-minikube.sh --delete       # Resources + delete cluster
#   ./scripts/k8s-teardown-minikube.sh --help         # Show help

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
NAMESPACE="agentpane-sandboxes"

# ---------------------------------------------------------------------------
# Colors
# ---------------------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

log_info()    { echo -e "  ${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "  ${GREEN}[OK]${NC} $1"; }
log_warn()    { echo -e "  ${YELLOW}[WARN]${NC} $1"; }
log_error()   { echo -e "  ${RED}[ERROR]${NC} $1"; }

# ---------------------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------------------
MODE="resources"

case "${1:-}" in
  --resources) MODE="resources" ;;
  --stop)      MODE="stop" ;;
  --delete)    MODE="delete" ;;
  --help|-h)
    cat <<EOF
AgentPane Kubernetes Teardown (Minikube)

Usage: ./scripts/k8s-teardown-minikube.sh [MODE]

Modes:
  --resources   Delete CRD resources only (sandboxes, templates, pools)
                This is the default when no flag is provided.

  --stop        Delete CRD resources + stop minikube cluster.
                The cluster data is preserved and can be restarted.

  --delete      Delete CRD resources + delete minikube cluster entirely.
                WARNING: This removes all cluster data permanently.

Options:
  --help, -h    Show this help message

Examples:
  ./scripts/k8s-teardown-minikube.sh               # Resources only
  ./scripts/k8s-teardown-minikube.sh --stop         # Resources + stop
  ./scripts/k8s-teardown-minikube.sh --delete       # Full cleanup
EOF
    exit 0
    ;;
  "")
    MODE="resources"
    ;;
  *)
    echo -e "${RED}Unknown option: $1${NC}"
    echo "Use --help for usage information."
    exit 1
    ;;
esac

# ---------------------------------------------------------------------------
# Confirmation for destructive modes
# ---------------------------------------------------------------------------
confirm() {
  local prompt="$1"
  echo ""
  echo -e "${YELLOW}${BOLD}$prompt${NC}"
  read -r -p "  Type 'yes' to confirm: " response
  if [[ "$response" != "yes" ]]; then
    echo "Aborted."
    exit 0
  fi
}

if [[ "$MODE" == "stop" ]]; then
  confirm "This will delete all AgentPane CRD resources and stop the minikube cluster."
elif [[ "$MODE" == "delete" ]]; then
  confirm "This will delete all AgentPane CRD resources and PERMANENTLY DELETE the minikube cluster."
fi

# ---------------------------------------------------------------------------
# Check prerequisites
# ---------------------------------------------------------------------------
echo ""
echo -e "${BOLD}AgentPane Kubernetes Teardown${NC} (mode: ${BOLD}$MODE${NC})"
echo ""

if ! command -v kubectl &>/dev/null; then
  log_error "kubectl not found"
  exit 1
fi

# ---------------------------------------------------------------------------
# Step 1: Delete CRD resources
# ---------------------------------------------------------------------------
echo -e "${BOLD}Deleting CRD resources in namespace '$NAMESPACE'...${NC}"

# Delete sandboxes first (they reference templates)
if kubectl get crd sandboxes.agents.x-k8s.io &>/dev/null 2>&1; then
  log_info "Deleting Sandboxes..."
  if kubectl delete sandboxes --all -n "$NAMESPACE" --timeout=60s 2>/dev/null; then
    log_success "Sandboxes deleted"
  else
    log_warn "No sandboxes found or deletion timed out"
  fi
else
  log_info "Sandbox CRD not installed, skipping sandbox deletion"
fi

# Delete warm pools
if kubectl get crd sandboxwarmpools.extensions.agents.x-k8s.io &>/dev/null 2>&1; then
  log_info "Deleting SandboxWarmPools..."
  if kubectl delete sandboxwarmpools --all -n "$NAMESPACE" --timeout=60s 2>/dev/null; then
    log_success "SandboxWarmPools deleted"
  else
    log_warn "No warm pools found or deletion timed out"
  fi
else
  log_info "SandboxWarmPool CRD not installed, skipping warm pool deletion"
fi

# Delete sandbox templates
if kubectl get crd sandboxtemplates.extensions.agents.x-k8s.io &>/dev/null 2>&1; then
  log_info "Deleting SandboxTemplates..."
  if kubectl delete sandboxtemplates --all -n "$NAMESPACE" --timeout=60s 2>/dev/null; then
    log_success "SandboxTemplates deleted"
  else
    log_warn "No sandbox templates found or deletion timed out"
  fi
else
  log_info "SandboxTemplate CRD not installed, skipping template deletion"
fi

# Delete standard K8s resources in the namespace
log_info "Deleting remaining resources in namespace..."
kubectl delete pods --all -n "$NAMESPACE" --timeout=60s 2>/dev/null && log_success "Pods deleted" || log_warn "No pods to delete"
kubectl delete networkpolicies --all -n "$NAMESPACE" 2>/dev/null && log_success "NetworkPolicies deleted" || log_warn "No network policies to delete"
kubectl delete limitranges --all -n "$NAMESPACE" 2>/dev/null && log_success "LimitRanges deleted" || log_warn "No limit ranges to delete"

echo ""
log_success "CRD resources cleaned up"

# ---------------------------------------------------------------------------
# Step 2: Stop or delete minikube (if requested)
# ---------------------------------------------------------------------------
if [[ "$MODE" == "stop" ]]; then
  echo ""
  echo -e "${BOLD}Stopping minikube...${NC}"

  if ! command -v minikube &>/dev/null; then
    log_error "minikube not found"
    exit 1
  fi

  if minikube status --format='{{.Host}}' 2>/dev/null | grep -q "Running"; then
    minikube stop
    log_success "minikube stopped"
  else
    log_info "minikube is not running"
  fi

  echo ""
  echo -e "${GREEN}${BOLD}Teardown complete.${NC} Cluster data preserved. Restart with: minikube start"

elif [[ "$MODE" == "delete" ]]; then
  echo ""
  echo -e "${BOLD}Deleting minikube cluster...${NC}"

  if ! command -v minikube &>/dev/null; then
    log_error "minikube not found"
    exit 1
  fi

  minikube delete
  log_success "minikube cluster deleted"

  echo ""
  echo -e "${GREEN}${BOLD}Teardown complete.${NC} Cluster and all data removed."
  echo "  To start fresh: ./scripts/k8s-setup-minikube.sh"

else
  echo ""
  echo -e "${GREEN}${BOLD}Teardown complete.${NC} CRD resources removed. Cluster still running."
  echo "  To re-apply resources: ./scripts/k8s-setup-minikube.sh"
fi
