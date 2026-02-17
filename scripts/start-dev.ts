#!/usr/bin/env bun
/**
 * Development startup script with health checks
 *
 * Starts the API server and waits for it to be healthy before starting Vite.
 * Provides clear feedback on startup status.
 */

const API_PORT = 3001;
const VITE_PORT = 3000;
const API_URL = `http://localhost:${API_PORT}`;
const HEALTH_URL = `${API_URL}/api/health`;
const MAX_RETRIES = 30;
const RETRY_DELAY_MS = 500;

// ANSI color codes
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

function log(emoji: string, message: string, color = colors.reset) {
  console.log(`${color}${emoji} ${message}${colors.reset}`);
}

function logStep(emoji: string, message: string) {
  console.log(`\n${colors.cyan}${emoji} ${message}${colors.reset}`);
}

async function checkHealth(): Promise<{ ok: boolean; details?: unknown }> {
  try {
    const response = await fetch(HEALTH_URL);
    if (!response.ok) return { ok: false };
    const data = await response.json();
    return { ok: data.ok === true, details: data.data };
  } catch {
    return { ok: false };
  }
}

async function waitForHealthy(): Promise<boolean> {
  logStep('⏳', 'Waiting for API server to be healthy...');

  const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let spinnerIdx = 0;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const result = await checkHealth();
    if (result.ok) {
      process.stdout.write(`\r${' '.repeat(60)}\r`); // Clear spinner line
      log('✅', `API server healthy!`, colors.green);
      if (result.details) {
        const details = result.details as { status: string; responseTimeMs: number };
        console.log(
          `   ${colors.dim}Status: ${details.status}, Response: ${details.responseTimeMs}ms${colors.reset}`
        );
      }
      return true;
    }

    // Show spinner
    process.stdout.write(
      `\r   ${spinner[spinnerIdx]} Checking health... (${attempt}/${MAX_RETRIES})`
    );
    spinnerIdx = (spinnerIdx + 1) % spinner.length;

    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
  }

  process.stdout.write(`\r${' '.repeat(60)}\r`); // Clear spinner line
  log('❌', `API server failed to become healthy after ${MAX_RETRIES} attempts`, colors.yellow);
  return false;
}

async function killExistingProcesses() {
  logStep('🧹', 'Cleaning up existing processes...');

  const killPort = async (port: number): Promise<number> => {
    try {
      const proc = Bun.spawn(['lsof', '-ti', `:${port}`], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const output = await new Response(proc.stdout).text();
      const pids = output.trim().split('\n').filter(Boolean);

      let killed = 0;
      for (const pid of pids) {
        try {
          process.kill(parseInt(pid, 10), 'SIGKILL');
          killed++;
        } catch {
          // Process may already be gone
        }
      }
      return killed;
    } catch {
      return 0;
    }
  };

  const killed3000 = await killPort(3000);
  const killed3001 = await killPort(3001);

  if (killed3000 > 0 || killed3001 > 0) {
    console.log(`   ${colors.dim}Killed ${killed3000 + killed3001} process(es)${colors.reset}`);
  } else {
    console.log(`   ${colors.dim}No existing processes found${colors.reset}`);
  }

  // Brief pause to let ports be released
  await new Promise((resolve) => setTimeout(resolve, 500));
}

async function checkSandboxImage() {
  logStep('🐳', 'Checking agent-sandbox Docker image...');

  try {
    const proc = Bun.spawn(['bash', 'scripts/check-sandbox-image.sh'], {
      cwd: process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    // Parse output for status
    if (output.includes('up to date')) {
      const imageId = output.match(/Image ID: (sha256:\w{12})/)?.[1] || 'unknown';
      console.log(`   ${colors.dim}Image is up to date (${imageId.slice(7, 19)})${colors.reset}`);
    } else if (output.includes('Updated')) {
      log('📥', 'Downloaded newer image from Docker Hub', colors.green);
    } else if (output.includes('not found')) {
      log('📥', 'Pulling agent-sandbox image...', colors.yellow);
    }

    return exitCode === 0;
  } catch {
    console.log(`   ${colors.dim}Skipping image check (Docker not available)${colors.reset}`);
    return true; // Don't fail startup if Docker isn't available
  }
}

async function main() {
  console.clear();
  console.log(
    `\n${colors.bright}${colors.magenta}🚀 AgentPane Development Server${colors.reset}\n`
  );
  const dbMode = process.env.DB_MODE ?? 'sqlite';
  console.log(
    `   ${colors.dim}Database: ${dbMode}${dbMode === 'postgres' ? ` (${process.env.DATABASE_URL?.replace(/:[^@]+@/, ':***@') ?? 'no URL'})` : ' (local)'}${colors.reset}`
  );
  console.log(`${colors.dim}${'─'.repeat(50)}${colors.reset}`);

  // Kill any existing processes
  await killExistingProcesses();

  // Check sandbox Docker image
  await checkSandboxImage();

  // Start API server
  logStep('📡', `Starting API server on port ${API_PORT}...`);
  const apiProcess = Bun.spawn(['bun', 'src/server/api.ts'], {
    cwd: process.cwd(),
    stdout: 'pipe',
    stderr: 'pipe',
  });

  // Capture and display API startup output (stdout + stderr)
  const readStream = (stream: ReadableStream<Uint8Array>, prefix: string) => {
    const reader = stream.getReader();
    const read = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = new TextDecoder().decode(value);
        for (const line of text.split('\n').filter(Boolean)) {
          console.log(`   ${colors.dim}[API] ${prefix}${line}${colors.reset}`);
        }
      }
    };
    read();
  };
  readStream(apiProcess.stdout, '');
  readStream(apiProcess.stderr, '');

  // Wait for API to be healthy
  const isHealthy = await waitForHealthy();
  if (!isHealthy) {
    log('❌', 'Failed to start: API server is not healthy', colors.yellow);
    apiProcess.kill();
    process.exit(1);
  }

  // Start Vite dev server
  logStep('🎨', `Starting Vite dev server on port ${VITE_PORT}...`);
  const viteProcess = Bun.spawn(['bunx', 'vite'], {
    cwd: process.cwd(),
    stdout: 'inherit',
    stderr: 'inherit',
  });

  // Brief delay to let Vite start
  await new Promise((resolve) => setTimeout(resolve, 2500));

  // Print final status
  console.log(`\n${colors.dim}${'─'.repeat(50)}${colors.reset}`);
  console.log(`\n${colors.bright}${colors.green}✨ Development servers started!${colors.reset}\n`);
  console.log(
    `   ${colors.cyan}🌐 Frontend${colors.reset}  →  ${colors.bright}http://localhost:${VITE_PORT}${colors.reset}`
  );
  console.log(
    `   ${colors.cyan}📡 API${colors.reset}       →  ${colors.bright}${API_URL}${colors.reset}`
  );
  console.log(
    `   ${colors.cyan}💓 Health${colors.reset}    →  ${colors.dim}${HEALTH_URL}${colors.reset}`
  );
  console.log(`\n${colors.dim}${'─'.repeat(50)}${colors.reset}`);
  console.log(`\n${colors.dim}Press Ctrl+C to stop all servers${colors.reset}\n`);

  // Handle shutdown
  const shutdown = () => {
    console.log(`\n\n${colors.yellow}🛑 Shutting down...${colors.reset}`);
    apiProcess.kill();
    viteProcess.kill();
    console.log(`${colors.green}👋 Goodbye!${colors.reset}\n`);
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Wait for processes
  await Promise.race([apiProcess.exited, viteProcess.exited]);
}

main().catch((error) => {
  console.error(`${colors.yellow}💥 Fatal error:${colors.reset}`, error);
  process.exit(1);
});
