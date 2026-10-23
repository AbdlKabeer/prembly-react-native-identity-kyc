import NativeDevice, { type Spec } from './NativePremblyDevice';

export function isNativeAvailable(): boolean {
  return NativeDevice != null;
}

/** The native module, or an error saying why it is missing. Callers catch it and fail open. */
export function nativeDevice(): Spec {
  if (NativeDevice == null) {
    throw new Error(
      'The PremblyDevice native module is not linked. Rebuild the app (run pod install on iOS). ' +
        'Expo Go is not supported; use a development build.'
    );
  }
  return NativeDevice;
}
