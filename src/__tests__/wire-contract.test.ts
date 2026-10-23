/**
 * Pins what the SDK puts on the wire, so the centralised SDK can reuse this client without the
 * metrics changing. Two things are locked:
 *
 * 1. The request: URL path, header names and the top-level body keys.
 * 2. The signal keys each native collector sends (read from the native source, checked against
 *    contract/signals.contract.json).
 *
 * If one of these tests fails, the backend (fraud/services/tm_sdk_service.py) reads something that
 * is about to change. Change the contract file and the backend together.
 */
import { SDK_VERSION } from '../version';

// The repo has no Node typings, so the two Node modules this test needs are required untyped.
declare const __dirname: string;
const { readFileSync } = require('fs');
const { join } = require('path');

const mockNative = {
  getAppInfo: jest.fn(),
  getDeviceId: jest.fn(),
  collectSignals: jest.fn(),
};
jest.mock('../NativePremblyDevice', () => ({
  __esModule: true,
  default: mockNative,
}));

const ROOT = join(__dirname, '..', '..');
const contract = JSON.parse(
  readFileSync(join(ROOT, 'contract', 'signals.contract.json'), 'utf8')
) as {
  sections: string[];
  android: Record<string, string[]>;
  ios: Record<string, string[]>;
};

// A full bundle as the Android collector sends it.
const ANDROID_BUNDLE = Object.fromEntries(
  Object.entries(contract.android)
    .filter(([section]) => section !== 'location')
    .map(([section, keys]) => [
      section,
      Object.fromEntries(keys.map((key) => [key, false])),
    ])
);

function loadClient() {
  let client: typeof import('../PremblyTM').PremblyTM;
  jest.isolateModules(() => {
    client = require('../PremblyTM').PremblyTM;
  });
  return client!;
}

describe('request contract', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    mockNative.getAppInfo.mockResolvedValue(
      JSON.stringify({
        appId: 'com.merchant.app',
        appVersion: '1',
        appBuild: '1',
      })
    );
    mockNative.getDeviceId.mockResolvedValue('dev-1');
    mockNative.collectSignals.mockResolvedValue(JSON.stringify(ANDROID_BUNDLE));
    fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({
        status: true,
        data: {
          device_session_id: 'dsess_abc',
          device_id: 'dev-1',
          is_known_device: false,
          expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
        },
      }),
    });
    (globalThis as any).fetch = fetchMock;
  });

  afterEach(() => jest.clearAllMocks());

  async function send(options: { customer?: string; location?: boolean } = {}) {
    const client = loadClient();
    client.init({
      publishableKey: 'live_pk_abc',
      location: options.location ?? false,
    });
    if (options.customer) client.identify(options.customer);
    await client.getDeviceSession();
    const [url, init] = fetchMock.mock.calls[0];
    return { url, init, body: JSON.parse(init.body) };
  }

  it('posts to the transaction monitoring sessions path on the default host', async () => {
    const { url, init } = await send();
    expect(url).toBe(
      'https://backend.prembly.com/api/v1/fraud/transaction-monitoring/sdk/v1/sessions'
    );
    expect(init.method).toBe('POST');
  });

  it('sends exactly these headers', async () => {
    const { init } = await send();
    expect(Object.keys(init.headers).sort()).toEqual(
      [
        'Content-Type',
        'X-App-Id',
        'X-Publishable-Key',
        'X-SDK-Platform',
        'X-SDK-Version',
      ].sort()
    );
    expect(init.headers['X-SDK-Version']).toBe(SDK_VERSION);
    expect(init.headers['X-Publishable-Key']).toBe('live_pk_abc');
    expect(init.headers['X-App-Id']).toBe('com.merchant.app');
  });

  it('sends exactly these body keys without a customer', async () => {
    const { body } = await send();
    expect(Object.keys(body).sort()).toEqual(
      [
        'collected_at',
        'consent',
        'device',
        'device_id',
        'integrity',
        'network',
        'scam_signals',
      ].sort()
    );
  });

  it('adds only customer_id once a customer is identified', async () => {
    const { body } = await send({ customer: 'CUST-1' });
    expect(Object.keys(body)).toContain('customer_id');
    expect(body.customer_id).toBe('CUST-1');
    expect(Object.keys(body)).toHaveLength(8);
  });

  it('passes every collected signal through untouched', async () => {
    const { body } = await send();
    for (const [section, signals] of Object.entries(ANDROID_BUNDLE)) {
      expect(body[section]).toEqual(signals);
    }
  });

  it('records the location consent flag as sent', async () => {
    expect((await send()).body.consent).toEqual({ location: false });
    jest.clearAllMocks();
    expect((await send({ location: true })).body.consent).toEqual({
      location: true,
    });
  });
});

describe('native signal keys', () => {
  const kotlin = readFileSync(
    join(
      ROOT,
      'android/src/main/java/com/prembly/device/SignalCollector.kt'
    ),
    'utf8'
  );
  const objc = readFileSync(join(ROOT, 'ios/TMSignalCollector.m'), 'utf8');

  const keysIn = (source: string, pattern: RegExp) =>
    new Set([...source.matchAll(pattern)].map((match) => match[1]));

  const expected = (platform: 'android' | 'ios') =>
    new Set([
      ...contract.sections,
      ...Object.values(contract[platform]).flat(),
    ]);

  it('Android sends exactly the contract keys', () => {
    // .put("key", ...) calls; camelCase keys (appId, appVersion) belong to getAppInfo, not signals.
    const found = keysIn(kotlin, /\.put\("([a-z_]+)"/g);
    expect([...found].sort()).toEqual([...expected('android')].sort());
  });

  it('iOS sends exactly the contract keys', () => {
    // Dictionary keys at the start of a line (@"key" : value) and signals[@"section"] assignments.
    const found = new Set([
      ...keysIn(objc, /^\s*@"([a-z_]+)"\s*:/gm),
      ...keysIn(objc, /signals\[@"([a-z_]+)"\]/g),
    ]);
    expect([...found].sort()).toEqual([...expected('ios')].sort());
  });
});
