import {
  buildScreenUpdateScript,
  readScreenCapture,
  startScreenWatch,
} from '../screenWatch';
import { WIDGET_ORIGIN } from '../nativeDevice';

const mockNative = {
  getAppInfo: jest.fn(),
  getDeviceId: jest.fn(),
  collectSignals: jest.fn(),
  checkScreenCapture: jest.fn(),
};
// A getter, so the mock is read when a test calls it, after `mockNative` exists.
jest.mock('../NativePremblyDevice', () => ({
  __esModule: true,
  get default() {
    return mockNative;
  },
}));

const reply = (flag: unknown) =>
  JSON.stringify({ is_screen_shared_or_recorded: flag });

describe('readScreenCapture', () => {
  afterEach(() => jest.clearAllMocks());

  it('reads true and false', async () => {
    mockNative.checkScreenCapture.mockResolvedValueOnce(reply(true));
    expect(await readScreenCapture()).toBe(true);
    mockNative.checkScreenCapture.mockResolvedValueOnce(reply(false));
    expect(await readScreenCapture()).toBe(false);
  });

  it('gives null, never false, when it cannot be read', async () => {
    mockNative.checkScreenCapture.mockRejectedValueOnce(new Error('boom'));
    expect(await readScreenCapture()).toBeNull();
    mockNative.checkScreenCapture.mockResolvedValueOnce('not json');
    expect(await readScreenCapture()).toBeNull();
    mockNative.checkScreenCapture.mockResolvedValueOnce(reply('yes'));
    expect(await readScreenCapture()).toBeNull();
  });
});

describe('startScreenWatch', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  const flush = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };

  it('reports straight away and then on every interval', async () => {
    mockNative.checkScreenCapture.mockResolvedValue(reply(false));
    const onState = jest.fn();
    const stop = startScreenWatch(onState, { intervalMs: 1000 });
    await flush();
    expect(onState).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1000);
    await flush();
    expect(onState).toHaveBeenCalledTimes(2);
    stop();
  });

  it('keeps "seen" true after a recording that has stopped', async () => {
    mockNative.checkScreenCapture
      .mockResolvedValueOnce(reply(false))
      .mockResolvedValueOnce(reply(true))
      .mockResolvedValue(reply(false));
    const onState = jest.fn();
    const stop = startScreenWatch(onState, { intervalMs: 1000 });
    for (let i = 0; i < 3; i++) {
      await flush();
      jest.advanceTimersByTime(1000);
    }
    await flush();
    expect(onState.mock.calls.map(([s]) => s)).toEqual([
      { current: false, seen: false },
      { current: true, seen: true },
      { current: false, seen: true },
      { current: false, seen: true },
    ]);
    stop();
  });

  it('starts with "seen" true when the first snapshot already saw a recording', async () => {
    mockNative.checkScreenCapture.mockResolvedValue(reply(false));
    const onState = jest.fn();
    const stop = startScreenWatch(onState, { alreadySeen: true });
    await flush();
    expect(onState).toHaveBeenCalledWith({ current: false, seen: true });
    stop();
  });

  it('skips a read that failed and carries on', async () => {
    mockNative.checkScreenCapture
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(reply(true));
    const onState = jest.fn();
    const stop = startScreenWatch(onState, { intervalMs: 1000 });
    await flush();
    expect(onState).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1000);
    await flush();
    expect(onState).toHaveBeenCalledWith({ current: true, seen: true });
    stop();
  });

  it('never runs two reads at once', async () => {
    let release: (value: string) => void = () => {};
    mockNative.checkScreenCapture.mockReturnValue(
      new Promise<string>((resolve) => {
        release = resolve;
      })
    );
    const stop = startScreenWatch(jest.fn(), { intervalMs: 1000 });
    jest.advanceTimersByTime(5000);
    await flush();
    expect(mockNative.checkScreenCapture).toHaveBeenCalledTimes(1);
    release(reply(false));
    stop();
  });

  it('stops reading and reporting once stopped', async () => {
    mockNative.checkScreenCapture.mockResolvedValue(reply(false));
    const onState = jest.fn();
    const stop = startScreenWatch(onState, { intervalMs: 1000 });
    await flush();
    stop();
    jest.advanceTimersByTime(5000);
    await flush();
    expect(onState).toHaveBeenCalledTimes(1);
  });
});

describe('buildScreenUpdateScript', () => {
  const run = (
    state: { current: boolean; seen: boolean },
    options: { origin?: string; device?: any; scriptOrigin?: string } = {}
  ) => {
    const events: string[] = [];
    const win: any = {
      location: { origin: options.origin ?? WIDGET_ORIGIN },
      __PREMBLY_NATIVE_DEVICE__:
        'device' in options
          ? options.device
          : { signals: { scam_signals: { is_screen_shared_or_recorded: false } } },
      dispatchEvent: (event: { type: string }) => events.push(event.type),
    };
    (globalThis as any).CustomEvent = class {
      type: string;
      constructor(type: string) {
        this.type = type;
      }
    };
    // eslint-disable-next-line no-new-func
    new Function('window', buildScreenUpdateScript(state, options.scriptOrigin))(win);
    return { win, events };
  };

  it('updates a page on the origin it was told about, such as a local link', () => {
    const local = 'http://localhost:3010';
    const { win, events } = run(
      { current: true, seen: true },
      { origin: local, scriptOrigin: local }
    );
    expect(win.__PREMBLY_NATIVE_DEVICE__.signals.scam_signals.is_screen_shared_or_recorded).toBe(true);
    expect(events).toEqual(['prembly:native-device-update']);
  });

  it('writes the current and the seen flags into the page data', () => {
    const { win } = run({ current: true, seen: true });
    expect(win.__PREMBLY_NATIVE_DEVICE__.signals.scam_signals).toEqual({
      is_screen_shared_or_recorded: true,
      screen_capture_seen: true,
    });
  });

  it('tells the page only when something changed', () => {
    expect(run({ current: true, seen: true }).events).toEqual([
      'prembly:native-device-update',
    ]);
    const unchanged = {
      signals: {
        scam_signals: {
          is_screen_shared_or_recorded: false,
          screen_capture_seen: false,
        },
      },
    };
    expect(run({ current: false, seen: false }, { device: unchanged }).events).toEqual([]);
  });

  it('does nothing on another origin', () => {
    const { win, events } = run(
      { current: true, seen: true },
      { origin: 'https://evil.example.com' }
    );
    expect(win.__PREMBLY_NATIVE_DEVICE__.signals.scam_signals.screen_capture_seen).toBeUndefined();
    expect(events).toEqual([]);
  });

  it('does nothing before the page has the device data', () => {
    const { win, events } = run({ current: true, seen: true }, { device: undefined });
    expect(win.__PREMBLY_NATIVE_DEVICE__).toBeUndefined();
    expect(events).toEqual([]);
  });

  it('ends with true so the WebView does not report a silent failure', () => {
    expect(buildScreenUpdateScript({ current: false, seen: false }).trim().endsWith('true;')).toBe(true);
  });
});
