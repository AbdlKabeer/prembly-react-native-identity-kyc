import {
  buildNativeDeviceScript,
  collectNativeDevice,
  WIDGET_ORIGIN,
} from '../nativeDevice';

const mockNative = {
  getAppInfo: jest.fn(),
  getDeviceId: jest.fn(),
  collectSignals: jest.fn(),
};
// A getter, so the mock is read when a test calls it, after `mockNative` exists.
jest.mock('../NativePremblyDevice', () => ({
  __esModule: true,
  get default() {
    return mockNative;
  },
}));

const ANDROID_SIGNALS = {
  device: {
    model: 'Pixel 8',
    os_name: 'android',
    platform_device_id: '9774d56d682e549c',
    total_memory_mb: 7800,
  },
  integrity: { is_rooted: false, is_emulator: false },
  network: { type: 'wifi', is_vpn_active: false },
  scam_signals: { is_screen_shared_or_recorded: false },
};

function givenAPhone(overrides: { signals?: object; deviceId?: string } = {}) {
  mockNative.getDeviceId.mockResolvedValue(overrides.deviceId ?? 'dev-1');
  mockNative.collectSignals.mockResolvedValue(
    JSON.stringify(overrides.signals ?? ANDROID_SIGNALS)
  );
  mockNative.getAppInfo.mockResolvedValue(
    JSON.stringify({ appId: 'com.bank.app', appVersion: '3.4.1', appBuild: '341' })
  );
}

describe('collectNativeDevice', () => {
  afterEach(() => jest.clearAllMocks());

  it('returns the device ID, the OS-kept ID and the signals', async () => {
    givenAPhone();
    const data = await collectNativeDevice();
    expect(data).toMatchObject({
      version: 1,
      source: 'native',
      deviceId: 'dev-1',
      platformDeviceId: '9774d56d682e549c',
      app: { appId: 'com.bank.app', appVersion: '3.4.1', appBuild: '341' },
      signals: ANDROID_SIGNALS,
    });
    expect(['ios_keychain', 'android_file']).toContain(data?.deviceIdSource);
  });

  it('never asks the native side for location', async () => {
    givenAPhone();
    await collectNativeDevice();
    expect(mockNative.collectSignals).toHaveBeenCalledWith(false);
  });

  it('leaves the OS-kept ID empty when the phone gave none', async () => {
    givenAPhone({ signals: { ...ANDROID_SIGNALS, device: { model: 'Pixel 8' } } });
    expect((await collectNativeDevice())?.platformDeviceId).toBeNull();
  });

  it('gives null, not an error, when the native side fails', async () => {
    mockNative.getDeviceId.mockRejectedValue(new Error('boom'));
    mockNative.collectSignals.mockResolvedValue('{}');
    mockNative.getAppInfo.mockResolvedValue('{}');
    await expect(collectNativeDevice()).resolves.toBeNull();
  });

  it('gives null when the native side returns something that is not JSON', async () => {
    givenAPhone();
    mockNative.collectSignals.mockResolvedValue('not json');
    await expect(collectNativeDevice()).resolves.toBeNull();
  });

  it('gives null when there is no device ID', async () => {
    givenAPhone({ deviceId: '' });
    await expect(collectNativeDevice()).resolves.toBeNull();
  });

  it('gives null instead of waiting past the time limit', async () => {
    givenAPhone();
    mockNative.getDeviceId.mockReturnValue(new Promise(() => {}));
    await expect(collectNativeDevice(20)).resolves.toBeNull();
  });
});

describe('buildNativeDeviceScript', () => {
  const data = {
    version: 1 as const,
    source: 'native' as const,
    platform: 'android' as const,
    sdkVersion: '2.0.0',
    deviceId: 'dev-1',
    deviceIdSource: 'android_file' as const,
    platformDeviceId: 'abc',
    app: { appId: 'a', appVersion: '1', appBuild: '1' },
    signals: { device: { model: '</script><script>alert(1)</script>' } },
  };

  it('sets the global only on the Prembly widget origin', () => {
    const script = buildNativeDeviceScript(data);
    expect(script).toContain(`window.location.origin === "${WIDGET_ORIGIN}"`);
    expect(script).toContain('window.__PREMBLY_NATIVE_DEVICE__ =');
  });

  it('cannot be broken out of by text in a device field', () => {
    const script = buildNativeDeviceScript(data);
    expect(script).not.toContain('</script>');
    expect(script).toContain('\\u003c/script>');
  });

  it('ends with true so the WebView does not report a silent failure', () => {
    expect(buildNativeDeviceScript(data).trim().endsWith('true;')).toBe(true);
  });

  it('runs as code that yields the data on the right origin and nothing on another', () => {
    const script = buildNativeDeviceScript(data);
    const run = (origin: string) => {
      const win: any = { location: { origin } };
      // eslint-disable-next-line no-new-func
      new Function('window', script)(win);
      return win.__PREMBLY_NATIVE_DEVICE__;
    };
    expect(run(WIDGET_ORIGIN).deviceId).toBe('dev-1');
    expect(run('https://evil.example.com')).toBeUndefined();
  });
});

describe('buildNativeDeviceScript origin', () => {
  it('guards on the origin it is given', () => {
    const script = buildNativeDeviceScript(
      { version: 1, source: 'native', platform: 'ios', sdkVersion: '2', deviceId: 'd', deviceIdSource: 'ios_keychain', platformDeviceId: null, app: { appId: 'a', appVersion: '1', appBuild: '1' }, signals: {} } as never,
      'https://hosted.example.com'
    );
    expect(script).toContain('window.location.origin === "https://hosted.example.com"');
    expect(script).not.toContain(WIDGET_ORIGIN);
  });
});
