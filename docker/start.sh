#!/bin/sh
set -e

# Start Caddy in background
/usr/local/bin/durable-streams-server run --config /app/Caddyfile &
CADDY_PID=$!

# Start Bun API in background
bun src/server/api.ts &
BUN_PID=$!

# Trap signals and forward to both processes
trap 'kill $CADDY_PID $BUN_PID 2>/dev/null; wait' SIGTERM SIGINT

# Wait for either process to exit
wait -n
EXIT_CODE=$?

# If one process exits, kill the other
kill $CADDY_PID $BUN_PID 2>/dev/null || true
wait
exit $EXIT_CODE
