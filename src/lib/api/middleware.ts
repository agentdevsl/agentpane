import type { AppError } from '../errors/base.js';
import { failure } from './response.js';

export type ApiContext = {
  requestId: string;
  startedAt: number;
  params?: Record<string, string | undefined>;
};

export type ApiHandler = (input: { request: Request; context: ApiContext }) => Promise<Response>;

export const withErrorHandling =
  (handler: ApiHandler) =>
  async ({
    request,
    params,
  }: {
    request: Request;
    params: Record<string, string | undefined>;
  }): Promise<Response> => {
    const apiContext: ApiContext = {
      requestId: crypto.randomUUID(),
      startedAt: Date.now(),
      params,
    };

    try {
      return await handler({ request, context: apiContext });
    } catch (error) {
      const appError: AppError = {
        code: 'API_UNHANDLED_ERROR',
        message: 'Unhandled API error',
        status: 500,
        details: { error: String(error) },
      };

      return Response.json(failure(appError), { status: appError.status });
    }
  };

export const logRequest = async (_request: Request, context: ApiContext): Promise<void> => {
  const _duration = Date.now() - context.startedAt;
};
