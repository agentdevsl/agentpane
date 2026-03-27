import { GitHubErrors } from '../errors/github-errors.js';
import type { Result } from '../utils/result.js';
import { err, ok } from '../utils/result.js';

export interface WebhookPayload {
  action?: string;
  installation?: {
    id: number;
    account: {
      login: string;
      type: string;
    };
  };
  repository?: {
    owner: { login: string };
    name: string;
    full_name: string;
  };
  sender?: {
    login: string;
    type: string;
  };
}

export interface VerifyWebhookOptions {
  payload: string;
  signature: string | null;
  secret: string;
}

export async function verifyWebhookSignature(
  options: VerifyWebhookOptions
): Promise<Result<true, typeof GitHubErrors.WEBHOOK_INVALID>> {
  const { payload, signature, secret } = options;

  if (!signature) {
    return err(GitHubErrors.WEBHOOK_INVALID);
  }

  if (!secret) {
    return ok(true);
  }

  const [algorithm, hash] = signature.split('=');

  if (algorithm !== 'sha256' || !hash) {
    return err(GitHubErrors.WEBHOOK_INVALID);
  }

  try {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );

    const signatureBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
    const computedHash = Array.from(new Uint8Array(signatureBuffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    if (computedHash !== hash) {
      return err(GitHubErrors.WEBHOOK_INVALID);
    }

    return ok(true);
  } catch {
    return err(GitHubErrors.WEBHOOK_INVALID);
  }
}

export function parseWebhookPayload(body: string): Result<WebhookPayload, Error> {
  try {
    const payload = JSON.parse(body) as WebhookPayload;
    return ok(payload);
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}

export type WebhookEventType =
  | 'installation'
  | 'installation_repositories'
  | 'push'
  | 'pull_request'
  | 'issues'
  | 'ping';

export interface WebhookEvent {
  event: WebhookEventType;
  action?: string;
  deliveryId: string;
  payload: WebhookPayload;
}

export function parseWebhookEvent(headers: Headers, body: string): Result<WebhookEvent, Error> {
  const event = headers.get('x-github-event') as WebhookEventType | null;
  const deliveryId = headers.get('x-github-delivery');

  if (!event || !deliveryId) {
    return err(new Error('Missing required webhook headers'));
  }

  const payloadResult = parseWebhookPayload(body);
  if (!payloadResult.ok) {
    return payloadResult;
  }

  return ok({
    event,
    action: payloadResult.value.action,
    deliveryId,
    payload: payloadResult.value,
  });
}
