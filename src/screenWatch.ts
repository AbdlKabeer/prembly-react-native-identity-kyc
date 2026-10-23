import { nativeDevice } from './native';
import { WIDGET_ORIGIN } from './nativeDevice';

/** How often the widget asks the phone whether the screen is being recorded or shared. */
export const SCREEN_WATCH_INTERVAL_MS = 2000;

export interface ScreenCaptureState {
  /** Being recorded, cast or mirrored right now. */
  current: boolean;
  /** Was recorded, cast or mirrored at any point since the verification opened. Never goes back to false. */
  seen: boolean;
}

/**
 * Whether the screen is being recorded or shared right now. `null` means it could not be read,
 * which is not the same as "no": the caller must not treat it as safe.
 */
export async function readScreenCapture(): Promise<boolean | null> {
  try {
    const parsed = JSON.parse(await nativeDevice().checkScreenCapture());
    const flag = parsed?.is_screen_shared_or_recorded;
    return typeof flag === 'boolean' ? flag : null;
  } catch {
    return null;
  }
}

/**
 * Keep reading the screen-capture flag until stopped, and report it every time. A recording that
 * starts after the first snapshot, even one that stops again, still shows up: `seen` stays true.
 * Reads never overlap, a failed read is skipped, and nothing here throws.
 */
export function startScreenWatch(
  onState: (state: ScreenCaptureState) => void,
  options: { intervalMs?: number; alreadySeen?: boolean } = {}
): () => void {
  let seen = options.alreadySeen ?? false;
  let stopped = false;
  let reading = false;

  const tick = async () => {
    if (stopped || reading) return;
    reading = true;
    try {
      const current = await readScreenCapture();
      if (stopped || current === null) return;
      if (current) seen = true;
      onState({ current, seen });
    } finally {
      reading = false;
    }
  };

  const timer = setInterval(tick, options.intervalMs ?? SCREEN_WATCH_INTERVAL_MS);
  void tick();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/**
 * The script the WebView runs to update what the page already holds in
 * `window.__PREMBLY_NATIVE_DEVICE__`. It does nothing on any other origin or before the page has
 * the data, and it tells the page (a `prembly:native-device-update` event) only when something
 * changed.
 */
export function buildScreenUpdateScript(state: ScreenCaptureState): string {
  return `(function () {
  try {
    var device = window.__PREMBLY_NATIVE_DEVICE__;
    if (window.location.origin !== ${JSON.stringify(WIDGET_ORIGIN)} || !device) return;
    var signals = (device.signals = device.signals || {});
    var scam = (signals.scam_signals = signals.scam_signals || {});
    var changed =
      scam.is_screen_shared_or_recorded !== ${state.current} ||
      scam.screen_capture_seen !== ${state.seen};
    scam.is_screen_shared_or_recorded = ${state.current};
    scam.screen_capture_seen = ${state.seen};
    if (changed) window.dispatchEvent(new CustomEvent('prembly:native-device-update'));
  } catch (e) {}
})();
true;`;
}
