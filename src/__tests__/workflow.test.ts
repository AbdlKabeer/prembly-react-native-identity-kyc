import {
  createWorkflowSession,
  PremblyWorkflowError,
  prefillGiven,
  workflowMetadata,
} from '../workflowSession';
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
  it('reads the widget\'s cancel, which is not an end state', () => {
    // The widget's own Cancel button posts this; the component closes the flow on it.
    const message = JSON.stringify({ source: 'prembly-workflow-sdk', type: 'cancelled', session_id: 's' });
    expect(parseWorkflowMessage(message)).toEqual({ type: 'cancelled', sessionId: 's' });
    expect(isEndState('cancelled')).toBe(false);
  });
  it('knows the end states', () => {
    expect(['completed', 'failed', 'manual_review', 'expired'].every(isEndState)).toBe(true);
    expect(isEndState('processing')).toBe(false);
  });
});

describe('prefill', () => {
  const created = {
    status: true,
    data: { session_id: 'wf_session_1', link: 'https://sdk-live.prembly.com/?session=wf_session_1' },
  };
  const sent = async (extra: Record<string, unknown>) => {
    const fetchMock = respond(201, created);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await createWorkflowSession({ ...base, ...extra });
    return JSON.parse(fetchMock.mock.calls[0][1].body);
  };

  it('goes in the metadata the way the backend picks it up, with your own data kept', async () => {
    const body = await sent({ prefill: { bvn: '22212345678' }, metadata: { order: 'A1' } });
    expect(body.metadata).toEqual({
      order: 'A1',
      prefill: true,
      channel_code: 'bvn',
      bvn: '22212345678',
    });
  });

  it('is not sent as a top-level field, which a public key is refused', async () => {
    const body = await sent({ prefill: { nin: '12345678901' } });
    expect(body).not.toHaveProperty('prefill');
  });

  it.each([
    ['nin', { nin: '11111111111' }, '11111111111'],
    ['bvn', { bvn: '11111111111' }, '11111111111'],
    ['passport', { passport: 'A1234567' }, 'A1234567'],
    ['drivers_license', { driversLicense: 'ABC12345' }, 'ABC12345'],
    ['voters_card', { votersCard: '90F5B0' }, '90F5B0'],
  ])('%s is sent under the name the backend knows it by', async (name, prefill, number) => {
    const { metadata } = await sent({ prefill });
    expect(metadata.prefill).toBe(true);
    expect(metadata.channel_code).toBe(name);
    expect(metadata[name]).toBe(number);
  });

  it('trims the number', async () => {
    const { metadata } = await sent({ prefill: { nin: '  12345678901 \n' } });
    expect(metadata.nin).toBe('12345678901');
  });

  it('wins over the same keys in your metadata, and your other keys stay', async () => {
    const { metadata } = await sent({
      prefill: { bvn: '22212345678' },
      metadata: { prefill: false, channel_code: 'nin', bvn: 'old', order: 'A1' },
    });
    expect(metadata).toEqual({
      prefill: true,
      channel_code: 'bvn',
      bvn: '22212345678',
      order: 'A1',
    });
  });

  it('does not change the object you passed in', () => {
    const yours = { order: 'A1' };
    workflowMetadata({ metadata: yours, prefill: { nin: '12345678901' } });
    expect(yours).toEqual({ order: 'A1' });
  });

  it('leaves the metadata exactly as given without it', async () => {
    expect((await sent({ metadata: { a: 1 } })).metadata).toEqual({ a: 1 });
    expect((await sent({})).metadata).toEqual({});
  });

  it.each([
    ['none given', {}],
    ['a blank one', { bvn: '   ' }],
    ['two given', { nin: '12345678901', bvn: '22212345678' }],
  ])('is refused before any request when %s', async (_name, prefill) => {
    globalThis.fetch = jest.fn() as unknown as typeof fetch;
    await expect(createWorkflowSession({ ...base, prefill })).rejects.toMatchObject({
      code: 'invalid_request',
      message: expect.stringContaining('exactly one ID'),
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('never shows the number in an error', async () => {
    globalThis.fetch = respond(400, { status: false, message: 'bad' }) as unknown as typeof fetch;
    const error = await createWorkflowSession({ ...base, prefill: { bvn: '22212345678' } }).catch(
      (e) => e
    );
    expect(error).toBeInstanceOf(PremblyWorkflowError);
    expect(String(error.message)).not.toContain('22212345678');
  });

  it('lists what was given by backend name', () => {
    expect(prefillGiven({ driversLicense: 'X1', votersCard: ' ', nin: '' })).toEqual([
      ['drivers_license', 'X1'],
    ]);
  });
});
