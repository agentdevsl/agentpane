/**
 * Base error for Nomad API failures
 */
export class NomadApiError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public body?: unknown
  ) {
    super(message);
    this.name = 'NomadApiError';
  }
}

/**
 * Resource not found (404)
 */
export class NotFoundError extends NomadApiError {
  constructor(resource: string, name: string) {
    super(404, `${resource} not found: ${name}`);
    this.name = 'NotFoundError';
  }
}

/**
 * Operation timed out
 */
export class TimeoutError extends NomadApiError {
  constructor(operation: string, timeoutMs: number) {
    super(408, `${operation} timed out after ${timeoutMs}ms`);
    this.name = 'TimeoutError';
  }
}

/**
 * Command execution failed
 */
export class ExecError extends Error {
  constructor(
    public exitCode: number,
    message: string,
    public stderr?: string
  ) {
    super(message);
    this.name = 'ExecError';
  }
}

/**
 * Failed to connect to Nomad agent
 */
export class ConnectionError extends Error {
  constructor(address: string, cause?: Error) {
    super(`Failed to connect to Nomad at ${address}: ${cause?.message ?? 'unknown error'}`, {
      cause,
    });
    this.name = 'ConnectionError';
  }
}
