import { Platform } from 'react-native';
import type {
  WorkflowCustomer,
  WorkflowErrorCode,
  WorkflowSessionInfo,
} from './types';
import { SDK_VERSION } from './version';

export const DEFAULT_BASE_URL = 'https://backend.prembly.com';
export const WORKFLOW_SESSIONS_PATH = '/api/v1/compliance-workflow/sdk/v1/sessions/';
// Creating a workflow session can take a while on a cold start; matches the web SDK's floor.
export const WORKFLOW_TIMEOUT_MS = 15_000;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class PremblyWorkflowError extends Error {
  code: WorkflowErrorCode;
  constructor(code: WorkflowErrorCode, message: string) {
    super(message);
    this.name = 'PremblyWorkflowError';
    this.code = code;
  }
}

export interface CreateWorkflowSessionOptions {
  publishableKey: string;
  workflowId: string;
  customer: WorkflowCustomer;
  metadata?: Record<string, unknown>;
  redirectUrl?: string;
  baseUrl?: string;
  timeoutMs?: number;
}

const nonEmpty = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '';

function validate(options: CreateWorkflowSessionOptions): void {
  const key = (options.publishableKey ?? '').trim();
  if (!key.startsWith('live_pk_') && !key.startsWith('test_pk_')) {
    throw new PremblyWorkflowError(
      'invalid_key',
      'publishableKey must be your public key (live_pk_... or test_pk_...). ' +
        'Never put a secret key (live_sk_ / test_sk_) in an app.'
    );
  }
  const invalid = (message: string) => new PremblyWorkflowError('invalid_request', message);
  if (!nonEmpty(options.workflowId)) throw invalid('workflowId is required.');
  const c = options.customer;
  if (!c || !nonEmpty(c.firstName) || !nonEmpty(c.lastName)) {
    throw invalid('customer.firstName and customer.lastName are required.');
  }
  if (!nonEmpty(c.email) || !EMAIL_RE.test(c.email)) {
    throw invalid('customer.email must be a valid email.');
  }
}

function errorForStatus(status: number): WorkflowErrorCode {
  if (status === 401 || status === 403) return 'unauthorised';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status >= 400 && status < 500) return 'invalid_request';
  return 'server_error';
}

/**
 * Create a workflow session with the publishable key, the same call the web SDK makes. Throws a
 * PremblyWorkflowError; the caller turns it into a callback.
 */
export async function createWorkflowSession(
  options: CreateWorkflowSessionOptions
): Promise<WorkflowSessionInfo> {
  validate(options);
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const c = options.customer;
  const body = {
    workflow_id: options.workflowId,
    customer: {
      first_name: c.firstName,
      last_name: c.lastName,
      email: c.email,
      ...(c.phone !== undefined ? { phone: c.phone } : {}),
      ...(c.reference !== undefined ? { reference: c.reference } : {}),
    },
    metadata: options.metadata ?? {},
    ...(options.redirectUrl !== undefined ? { redirect_url: options.redirectUrl } : {}),
  };

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(options.timeoutMs ?? 0, WORKFLOW_TIMEOUT_MS)
  );
  try {
    const response = await fetch(`${baseUrl}${WORKFLOW_SESSIONS_PATH}`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-Publishable-Key': options.publishableKey.trim(),
        'X-SDK-Platform': Platform.OS,
        'X-SDK-Version': SDK_VERSION,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      let message = `The workflow session could not be created (HTTP ${response.status}).`;
      try {
        const payload = await response.json();
        if (nonEmpty(payload?.message)) message = payload.message;
      } catch {
        // keep the generic message
      }
      throw new PremblyWorkflowError(errorForStatus(response.status), message);
    }
    const data = (await response.json())?.data;
    if (!data || !nonEmpty(data.session_id) || !nonEmpty(data.link)) {
      throw new PremblyWorkflowError(
        'server_error',
        'The workflow session response was incomplete.'
      );
    }
    return {
      sessionId: data.session_id,
      link: data.link,
      expiresAt: data.expires_at,
      isSandbox: data.is_sandbox,
    };
  } catch (error) {
    if (error instanceof PremblyWorkflowError) throw error;
    const aborted = (error as { name?: string })?.name === 'AbortError';
    throw new PremblyWorkflowError(
      aborted ? 'timeout' : 'network_error',
      aborted ? 'The workflow session request timed out.' : String((error as Error)?.message ?? error)
    );
  } finally {
    clearTimeout(timer);
  }
}
