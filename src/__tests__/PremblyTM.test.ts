import { SDK_VERSION } from '../version';

const mockNative = {
  getAppInfo: jest.fn(),
  getDeviceId: jest.fn(),
  collectSignals: jest.fn(),
};
jest.mock('../NativePremblyDevice', () => ({
  __esModule: true,
  default: mockNative,
}));

const SESSION_RESPONSE = (overrides: Record<string, unknown> = {}) => ({
  ok: true,
  status: 201,
  json: async () => ({
    status: true,
    data: {
      device_session_id: 'dsess_abc',
      device_id: 'dev-1',
      is_known_device: false,
      expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
      ...overrides,
    },
  }),
});

function loadClient() {
  let client: typeof import('../PremblyTM').PremblyTM;
  jest.isolateModules(() => {
    client = require('../PremblyTM').PremblyTM;
  });
  return client!;
}

describe('PremblyTM', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    mockNative.getAppInfo.mockResolvedValue(
      JSON.stringify({
        appId: 'com.merchant.app',
        appVersion: '3.4.1',
        appBuild: '341',
      })
    );
    mockNative.getDeviceId.mockResolvedValue('dev-1');
    mockNative.collectSignals.mockResolvedValue(
      JSON.stringify({
        device: { model: 'Pixel 8', os_name: 'android' },
        integrity: { is_rooted: false },
        network: { type: 'wifi' },
        scam_signals: { is_screen_shared_or_recorded: false },
      })
    );
    fetchMock = jest.fn().mockResolvedValue(SESSION_RESPONSE());
    (globalThis as any).fetch = fetchMock;
  });

  afterEach(() => jest.clearAllMocks());

  it('matches the version in package.json', () => {
    expect(SDK_VERSION).toBe(require('../../package.json').version);
  });

  describe('init', () => {
    it('accepts live and sandbox public keys', () => {
      expect(() =>
        loadClient().init({ publishableKey: 'live_pk_abc' })
      ).not.toThrow();
      expect(() =>
        loadClient().init({ publishableKey: 'test_pk_abc' })
      ).not.toThrow();
    });

    it('refuses a secret key or anything else', () => {
      for (const key of ['live_sk_abc', 'test_sk_abc', '', 'nonsense']) {
        expect(() => loadClient().init({ publishableKey: key })).toThrow(
          /public key/
        );
      }
    });
  });

  describe('getDeviceSession', () => {
    it('fails open before init, without calling the network', async () => {
      const result = await loadClient().getDeviceSession();
      expect(result).toEqual({
        deviceSessionId: null,
        deviceId: null,
        error: 'not_initialised',
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('sends the signals with the public key and app headers', async () => {
      const client = loadClient();
      client.init({
        publishableKey: 'test_pk_abc',
        baseUrl: 'https://api.example.com/',
      });
      client.identify('CUST-1');

      const result = await client.getDeviceSession();

      expect(result.deviceSessionId).toBe('dsess_abc');
      expect(result.isKnownDevice).toBe(false);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(
        'https://api.example.com/api/v1/fraud/transaction-monitoring/sdk/v1/sessions'
      );
      expect(init.headers['X-Publishable-Key']).toBe('test_pk_abc');
      expect(init.headers['X-App-Id']).toBe('com.merchant.app');
      expect(init.headers['X-SDK-Version']).toBe(SDK_VERSION);
      expect(init.headers['X-SDK-Platform']).toBeDefined();
      const body = JSON.parse(init.body);
      expect(body.device_id).toBe('dev-1');
      expect(body.customer_id).toBe('CUST-1');
      expect(body.device.model).toBe('Pixel 8');
      expect(body.consent).toEqual({ location: false });
      expect(typeof body.collected_at).toBe('string');
    });

    it('leaves out the customer until one is identified', async () => {
      const client = loadClient();
      client.init({ publishableKey: 'test_pk_abc' });
      await client.getDeviceSession();
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).not.toHaveProperty(
        'customer_id'
      );
    });

    it('collects location only when it was switched on', async () => {
      const client = loadClient();
      client.init({ publishableKey: 'test_pk_abc' });
      await client.getDeviceSession();
      expect(mockNative.collectSignals).toHaveBeenLastCalledWith(false);

      client.setLocationEnabled(true);
      await client.getDeviceSession();
      expect(mockNative.collectSignals).toHaveBeenLastCalledWith(true);
      expect(JSON.parse(fetchMock.mock.calls[1][1].body).consent).toEqual({
        location: true,
      });
    });

    it('reuses a valid session instead of asking again', async () => {
      const client = loadClient();
      client.init({ publishableKey: 'test_pk_abc' });
      const first = await client.getDeviceSession();
      const second = await client.getDeviceSession();
      expect(second).toBe(first);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await client.getDeviceSession({ forceRefresh: true });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('asks again when the customer changes or the session is nearly expired', async () => {
      const client = loadClient();
      client.init({ publishableKey: 'test_pk_abc' });
      await client.getDeviceSession();
      client.identify('CUST-2');
      await client.getDeviceSession();
      expect(fetchMock).toHaveBeenCalledTimes(2);

      fetchMock.mockResolvedValue(
        SESSION_RESPONSE({
          expires_at: new Date(Date.now() + 10_000).toISOString(),
        })
      );
      await client.getDeviceSession({ forceRefresh: true });
      await client.getDeviceSession(); // inside the 30 second margin: not reused
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it('shares one request between callers that ask together', async () => {
      const client = loadClient();
      client.init({ publishableKey: 'test_pk_abc' });
      const [a, b] = await Promise.all([
        client.getDeviceSession(),
        client.getDeviceSession(),
      ]);
      expect(a).toBe(b);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('reset forgets the customer and the cached session', async () => {
      const client = loadClient();
      client.init({ publishableKey: 'test_pk_abc' });
      client.identify('CUST-1');
      await client.getDeviceSession();
      client.reset();
      await client.getDeviceSession();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(JSON.parse(fetchMock.mock.calls[1][1].body)).not.toHaveProperty(
        'customer_id'
      );
    });
  });

  describe('failing open', () => {
    const run = async () => {
      const client = loadClient();
      client.init({ publishableKey: 'test_pk_abc' });
      return client.getDeviceSession();
    };

    it.each([
      [401, 'unauthorised'],
      [403, 'unauthorised'],
      [429, 'rate_limited'],
      [400, 'rejected'],
      [500, 'server_error'],
      [503, 'server_error'],
    ])('turns HTTP %i into %s', async (status, error) => {
      fetchMock.mockResolvedValue({
        ok: false,
        status,
        json: async () => ({}),
      });
      expect(await run()).toMatchObject({
        deviceSessionId: null,
        deviceId: 'dev-1',
        error,
      });
    });

    it('reports a network error without throwing', async () => {
      fetchMock.mockRejectedValue(new TypeError('Network request failed'));
      expect(await run()).toMatchObject({
        deviceSessionId: null,
        error: 'network_error',
      });
    });

    it('reports a timeout when the request is aborted', async () => {
      fetchMock.mockImplementation(
        (_url: string, init: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => {
              const error = new Error('aborted');
              error.name = 'AbortError';
              reject(error);
            });
          })
      );
      jest.useFakeTimers();
      const client = loadClient();
      client.init({ publishableKey: 'test_pk_abc', timeoutMs: 1000 });
      const pending = client.getDeviceSession();
      await jest.advanceTimersByTimeAsync(1500);
      expect(await pending).toMatchObject({
        deviceSessionId: null,
        error: 'timeout',
      });
      jest.useRealTimers();
    });

    it('reports a native error when the signals cannot be read', async () => {
      mockNative.collectSignals.mockRejectedValue(new Error('boom'));
      expect(await run()).toMatchObject({
        deviceSessionId: null,
        error: 'native_error',
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('treats a reply without a session id as a server error', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        status: 201,
        json: async () => ({ data: {} }),
      });
      expect(await run()).toMatchObject({
        deviceSessionId: null,
        error: 'server_error',
      });
    });
  });

  describe('getSignalsPreview', () => {
    it('returns the signals without sending anything', async () => {
      const client = loadClient();
      client.init({ publishableKey: 'test_pk_abc' });
      const preview = await client.getSignalsPreview();
      expect(preview?.device).toMatchObject({ model: 'Pixel 8' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns null instead of throwing', async () => {
      mockNative.collectSignals.mockRejectedValue(new Error('boom'));
      expect(await loadClient().getSignalsPreview()).toBeNull();
    });
  });

  describe('getDeviceId', () => {
    it('returns null instead of throwing', async () => {
      mockNative.getDeviceId.mockRejectedValue(new Error('no keychain'));
      expect(await loadClient().getDeviceId()).toBeNull();
    });
  });
});
