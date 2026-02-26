#!/bin/bash
set -e

# Trap signals and forward to both processes
trap 'kill $CADDY_PID $BUN_PID 2>/dev/null; wait' SIGTERM SIGINT

# Start Caddy in background
/usr/local/bin/durable-streams-server run --config /app/Caddyfile &
CADDY_PID=$!

# Wait for Caddy to be ready before starting Bun API
echo "[start.sh] Waiting for Caddy to be ready on port 3000..."
for i in $(seq 1 30); do
  if wget -q --spider http://localhost:3000/healthz 2>/dev/null; then
    echo "[start.sh] Caddy is ready."
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "[start.sh] WARNING: Caddy not ready after 15s, starting Bun anyway."
  fi
  sleep 0.5
done

# Start Bun API in background
bun src/server/api.ts &
BUN_PID=$!

# Wait for either process to exit
wait -n
EXIT_CODE=$?

# Determine which process exited
if ! kill -0 $CADDY_PID 2>/dev/null; then
  echo "[start.sh] Caddy (PID $CADDY_PID) exited with code $EXIT_CODE"
elif ! kill -0 $BUN_PID 2>/dev/null; then
  echo "[start.sh] Bun API (PID $BUN_PID) exited with code $EXIT_CODE"
else
  echo "[start.sh] Unknown process exited with code $EXIT_CODE"
fi

# If one process exits, kill the other
kill $CADDY_PID $BUN_PID 2>/dev/null || true
wait || true
exit $EXIT_CODE
