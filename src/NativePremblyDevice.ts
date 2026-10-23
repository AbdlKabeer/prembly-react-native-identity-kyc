import { TurboModuleRegistry, type TurboModule } from 'react-native';

/**
 * The native side only reads the device. Every method returns JSON text, which keeps the
 * Turbo module contract small and identical on iOS and Android.
 */
export interface Spec extends TurboModule {
  /** `{ appId, appVersion, appBuild }` for the host app (bundle ID or package name). */
  getAppInfo(): Promise<string>;

  /**
   * The app-scoped device ID. It is created on first use and then kept: in the Keychain on iOS
   * (this device only) and in a backup-excluded file on Android.
   */
  getDeviceId(): Promise<string>;

  /**
   * The signal sections: `device`, `integrity`, `network`, `scam_signals` and, only when
   * `includeLocation` is true and the app already holds the location permission, `location`.
   * The SDK never asks for a permission itself.
   */
  collectSignals(includeLocation: boolean): Promise<string>;

  /**
   * `{ is_screen_shared_or_recorded }`, read now. Cheap, so the widget calls it every couple of
   * seconds while a verification is open and catches a recording that starts after the first read.
   */
  checkScreenCapture(): Promise<string>;
}

// `get`, not `getEnforcing`: a missing native build (for example Expo Go) must not stop the whole
// library from loading. Callers go through `nativeDevice()` / `isNativeAvailable()` in ./native.
export default TurboModuleRegistry.get<Spec>('PremblyDevice');
