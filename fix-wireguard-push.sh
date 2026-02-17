#!/bin/bash
# Tears down WireGuard tunnels, flushes DNS, pushes to GitHub, then restores tunnels.

set -e

echo "==> Bringing down WireGuard interfaces..."
for iface in utun1 utun2 utun3; do
  if ifconfig "$iface" >/dev/null 2>&1; then
    sudo wg-quick down "$iface" 2>/dev/null && echo "    Down: $iface" || echo "    Skip: $iface (not a wg interface)"
  fi
done

echo "==> Flushing DNS cache..."
dscacheutil -flushcache
sudo killall -HUP mDNSResponder 2>/dev/null || true

echo "==> Waiting for network to settle..."
sleep 2

echo "==> Testing GitHub connectivity..."
if curl -s --connect-timeout 10 -o /dev/null -w "%{http_code}" https://github.com | grep -q "200\|301"; then
  echo "    GitHub is reachable!"
else
  echo "    WARNING: GitHub may still be unreachable, attempting push anyway..."
fi

echo "==> Pushing to remote..."
git push

echo "==> Done! Re-enable WireGuard tunnels from the WireGuard app if needed."
