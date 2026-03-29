export interface AppError {
  readonly code: string;
  readonly message: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;
  toString(): string;
}

export class AppErrorClass extends Error implements AppError {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    status: number,
    details?: Record<string, unknown>,
    cause?: unknown
  ) {
    super(message, cause != null ? { cause } : undefined);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
  }

  toString(): string {
    return this.message;
  }
}

export const createError = (
  code: string,
  message: string,
  status: number,
  details?: Record<string, unknown>,
  cause?: unknown
): AppError => new AppErrorClass(code, message, status, details, cause);
