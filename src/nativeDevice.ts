import { Platform } from 'react-native';
import { nativeDevice } from './native';
import type { AppInfo, SignalBundle } from './types';
import { SDK_VERSION } from './version';

/** The only origin the widget hands the device data to. */
export const WIDGET_ORIGIN = 'https://sdk-live.prembly.com';

/** What the phone knows about itself, handed to the widget page as `window.__PREMBLY_NATIVE_DEVICE__`. */
export interface NativeDeviceData {
  version: 1;
  source: 'native';
  platform: 'ios' | 'android';
  sdkVersion: string;
  /** The app-scoped random ID: Keychain on iOS (survives a reinstall), a no-backup file on Android. */
  deviceId: string;
  /** Where `deviceId` is kept, so the backend knows how long it lasts. */
  deviceIdSource: 'ios_keychain' | 'android_file';
  /** The ID the OS keeps for this app: `identifierForVendor` on iOS, `ANDROID_ID` on Android. */
  platformDeviceId: string | null;
  app: AppInfo;
  /** The same sections and keys the Transaction Monitoring SDK sends. Location is never included. */
  signals: SignalBundle;
}

const DEFAULT_TIMEOUT_MS = 2500;

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('device read timed out')), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/**
 * Read the device from the native side. Never throws and never waits longer than `timeoutMs`:
 * `null` means "could not read it", and the widget then falls back to what the web page can see.
 * It reads no location and shows no prompt.
 */
export async function collectNativeDevice(
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<NativeDeviceData | null> {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return null;
  try {
    const native = nativeDevice();
    const [deviceId, signalsText, appText] = await withTimeout(
      Promise.all([
        native.getDeviceId(),
        native.collectSignals(false),
        native.getAppInfo(),
      ]),
      timeoutMs
    );
    if (!deviceId) return null;

    const signals = JSON.parse(signalsText) as SignalBundle;
    const app = JSON.parse(appText) as AppInfo;
    const platformId = signals.device?.platform_device_id;

    return {
      version: 1,
      source: 'native',
      platform: Platform.OS,
      sdkVersion: SDK_VERSION,
      deviceId,
      deviceIdSource: Platform.OS === 'ios' ? 'ios_keychain' : 'android_file',
      platformDeviceId:
        typeof platformId === 'string' && platformId.length > 0 ? platformId : null,
      app,
      signals,
    };
  } catch {
    return null;
  }
}

/** JSON that is safe to place inside a script: no `</script>`, no line separators. */
function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * The script the WebView runs before the page loads. It sets the device data only when the page is
 * the Prembly widget, so a page the widget navigates to never receives it.
 */
export function buildNativeDeviceScript(data: NativeDeviceData): string {
  return `(function () {
  try {
    if (window.location.origin === ${safeJson(WIDGET_ORIGIN)}) {
      window.__PREMBLY_NATIVE_DEVICE__ = ${safeJson(data)};
    }
  } catch (e) {}
})();
true;`;
}
