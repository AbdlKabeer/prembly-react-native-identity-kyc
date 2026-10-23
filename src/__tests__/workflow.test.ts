import { createWorkflowSession, PremblyWorkflowError } from '../workflowSession';
import { isEndState, parseWorkflowMessage } from '../workflowEvents';

const customer = { firstName: 'Ada', lastName: 'Obi', email: 'ada@example.com' };
const base = { publishableKey: 'test_pk_abc', workflowId: 'wf_1', customer };

const respond = (status: number, body: unknown) =>
  jest.fn().mockResolvedValue({ ok: status < 400, status, json: async () => body });

afterEach(() => {
  // @ts-expect-error reset the fetch mock between tests
  delete globalThis.fetch;
});

describe('createWorkflowSession', () => {
  it('posts the web SDK request and returns the session', async () => {
    const fetchMock = respond(201, {
      status: true,
      data: { session_id: 'wf_session_1', link: 'https://sdk-live.prembly.com/?session=wf_session_1' },
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const session = await createWorkflowSession({ ...base, metadata: { a: 1 }, redirectUrl: 'x://y' });
    expect(session.sessionId).toBe('wf_session_1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://backend.prembly.com/api/v1/compliance-workflow/sdk/v1/sessions/');
    expect(init.headers['X-Publishable-Key']).toBe('test_pk_abc');
    expect(init.headers['X-App-Id']).toBeUndefined();
    expect(JSON.parse(init.body)).toEqual({
      workflow_id: 'wf_1',
      customer: { first_name: 'Ada', last_name: 'Obi', email: 'ada@example.com' },
      metadata: { a: 1 },
      redirect_url: 'x://y',
    });
  });

  it('refuses a secret key before any request', async () => {
    globalThis.fetch = jest.fn() as unknown as typeof fetch;
    await expect(createWorkflowSession({ ...base, publishableKey: 'live_sk_x' })).rejects.toMatchObject({
      code: 'invalid_key',
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('validates the customer', async () => {
    await expect(
      createWorkflowSession({ ...base, customer: { ...customer, email: 'nope' } })
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it.each([
    [401, 'unauthorised'],
    [404, 'not_found'],
    [429, 'rate_limited'],
    [400, 'invalid_request'],
    [500, 'server_error'],
  ])('maps HTTP %i to %s', async (status, code) => {
    globalThis.fetch = respond(status, { status: false, message: 'm' }) as unknown as typeof fetch;
    await expect(createWorkflowSession(base)).rejects.toMatchObject({ code, message: 'm' });
  });

  it('rejects an incomplete success body', async () => {
    globalThis.fetch = respond(201, { status: true, data: { session_id: 'x' } }) as unknown as typeof fetch;
    await expect(createWorkflowSession(base)).rejects.toBeInstanceOf(PremblyWorkflowError);
  });

  it('reports a network failure', async () => {
    globalThis.fetch = jest.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch;
    await expect(createWorkflowSession(base)).rejects.toMatchObject({ code: 'network_error' });
  });
});

describe('parseWorkflowMessage', () => {
  it('reads the current envelope', () => {
    expect(
      parseWorkflowMessage(
        JSON.stringify({ source: 'prembly-sdk', product: 'workflow', type: 'step_started', session_id: 's', node_id: 'n' })
      )
    ).toEqual({ type: 'step_started', sessionId: 's', nodeId: 'n' });
  });
  it('reads the legacy envelope', () => {
    expect(
      parseWorkflowMessage(JSON.stringify({ source: 'prembly-workflow-sdk', type: 'completed', session_id: 's' }))
    ).toEqual({ type: 'completed', sessionId: 's' });
  });
  it('ignores other sources, products and bad input', () => {
    expect(parseWorkflowMessage('not json')).toBeNull();
    expect(parseWorkflowMessage(JSON.stringify({ source: 'other', type: 'completed', session_id: 's' }))).toBeNull();
    expect(
      parseWorkflowMessage(JSON.stringify({ source: 'prembly-sdk', product: 'tm', type: 'x', session_id: 's' }))
    ).toBeNull();
  });
  it('knows the end states', () => {
    expect(['completed', 'failed', 'manual_review', 'expired'].every(isEndState)).toBe(true);
    expect(isEndState('processing')).toBe(false);
  });
});
