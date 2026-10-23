# prembly-react-native-kyc

One React Native library for two Prembly products, both reading the phone's real device ID:

- **Identity KYC widget** (`PremblyIdentityWidget`): opens the verification flow in your app.
- **Transaction Monitoring** (`PremblyTM`): creates a short-lived device session you pass to your backend when you screen a transaction.

It replaces `prembly-tm-native`. See [Moving from earlier versions](#moving-from-earlier-versions).

## Requirements

| | |
|---|---|
| React Native | 0.76 or later, with the **New Architecture** (the default from 0.76) |
| iOS | 15.1 or later |
| Android | 7.0 or later (API 24) |
| Expo | Development build or prebuild. **Not Expo Go**: the library contains native code. |
| Peer dependencies | `react`, `react-native`, `react-native-webview` (13 or later) |

Tested on React Native 0.86 with an iPhone 17 Pro simulator and an Android 17 emulator. Not yet tested on physical devices.

## Install

```sh
npm install prembly-react-native-kyc react-native-webview
cd ios && pod install
```

With Expo, install the packages and run `npx expo run:ios` or `npx expo run:android` (or an EAS development build). There is no config plugin to add.

## Identity KYC widget

```tsx
import { useState } from 'react';
import { View, Button } from 'react-native';
import { PremblyIdentityWidget } from 'prembly-react-native-kyc';

export default function App() {
  const [isVisible, setIsVisible] = useState(false);

  return (
    <View style={{ flex: 1, justifyContent: 'center' }}>
      <Button title="Verify identity" onPress={() => setIsVisible(true)} />

      <PremblyIdentityWidget
        isVisible={isVisible}
        widgetKey="your_widget_key"
        widgetId="your_widget_id"
        email="john@example.com"
        phone="+2348012345678"
        firstName="John"
        lastName="Doe"
        metadata={{ user_id: '123456' }}
        callback={(response) => {
          console.log('Widget response:', response);
          if (['closed', 'error_display_closed', 'success'].includes(response.status)) {
            setIsVisible(false);
          }
        }}
      />
    </View>
  );
}
```

| Prop | Type | Required | Description |
|---|---|---|---|
| `isVisible` | `boolean` | Yes | Shows or hides the widget modal |
| `widgetKey` | `string` | Yes | Your Prembly widget public key |
| `widgetId` | `string` | Yes | Your widget ID from the dashboard |
| `email`, `phone`, `firstName`, `lastName` | `string` | No | The person being verified |
| `metadata` | `object` | No | Extra data stored with the session |
| `collectDeviceData` | `boolean` | No | Read the phone's own device ID and details and give them to the widget. **On by default.** Turn it off to use only what the web page can see. |
| `callback` | `function` | Yes | Called with `{ status }`: `closed`, `error`, `success`, `api_error`, `network_error`, `error_display_closed`, or another event the widget sends |

### What the widget does with the device

While the verification session is created, the library reads the phone and, before the widget page loads, gives it the result. The widget then reports the phone's real device ID instead of a guess made from the browser, which two identical phones would share.

- It never shows a permission prompt, and never reads location.
- The data goes only to the Prembly widget page, never in a URL.
- If the phone cannot be read (for example in Expo Go), the widget carries on with what the web page can see.
- While the widget is open the library keeps checking whether the screen is being recorded or shared and tells the widget, including a recording that started and stopped.

## Transaction Monitoring

```ts
import { PremblyTM } from 'prembly-react-native-kyc';

// 1. Once, early (for example when the app starts). Use test_pk_... while developing.
PremblyTM.init({ publishableKey: 'test_pk_xxxxxxxx' });

// 2. When the customer signs in (and null when they sign out).
PremblyTM.identify('CUST-123');

// 3. Before a sensitive action: sign-in, payment, adding a beneficiary.
const session = await PremblyTM.getDeviceSession();

// 4. Send it with your normal request. deviceSessionId is null if no session could be created:
//    send the request anyway and your backend screens without it.
await fetch('https://your-backend.example.com/payments', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ amount, to, deviceSessionId: session.deviceSessionId }),
});
```

Your backend then screens the transaction with your **secret** key and passes `device_session_id`. Never put a secret key (`live_sk_…` / `test_sk_…`) in an app: `init` throws if you try.

| Call | What it does |
|---|---|
| `PremblyTM.init({ publishableKey, baseUrl?, location?, timeoutMs?, debug? })` | Set up once. Throws if the key is not a public key. |
| `PremblyTM.identify(customerId \| null)` | Tell the SDK who is using the app. |
| `PremblyTM.getDeviceSession({ forceRefresh? })` | Returns `{ deviceSessionId, deviceId, isKnownDevice, expiresAt, error }`. Never throws. |
| `PremblyTM.setLocationEnabled(boolean)` | Turn location on or off, for example when consent changes. |
| `PremblyTM.getSignalsPreview()` | The signals that would be sent, without sending anything. |
| `PremblyTM.getDeviceId()` | The app-scoped device ID, or `null`. |
| `PremblyTM.reset()` | Forget the customer and the cached session (on sign-out). |

A session is reused until shortly before it expires (about 15 minutes). If it cannot be created, `deviceSessionId` is `null` and `error` is one of `not_initialised`, `timeout`, `network_error`, `unauthorised`, `rate_limited`, `rejected`, `server_error` or `native_error`. **It fails open**: send the payment anyway.

## What is collected

| Section | Signals |
|---|---|
| `device` | Type, model, manufacturer, OS and version, app version and build, language, timezone, memory, CPU cores, screen size and density. Android also: brand, SDK level, security patch. |
| `integrity` | Rooted or jailbroken, emulator or simulator, debugger attached, screen lock set. Android also: developer options, USB debugging. |
| `network` | Connection type, VPN active, proxy configured |
| `scam_signals` | Screen shared or recorded; on Android, a known remote-access app's accessibility service enabled, and whether one is installed |
| `location` | Latitude, longitude, accuracy and whether it is mocked. **Only for Transaction Monitoring, and only when you turn it on**, and the app already holds the permission. |

### The device ID

- `deviceId` is a random ID the library creates once. **iOS:** kept in the Keychain, marked "this device only", so it survives a reinstall and is not copied to another device by a backup. **Android:** kept in a file the OS excludes from backup, so a reinstall gets a new one.
- `platformDeviceId` is the ID the OS keeps for the app: `identifierForVendor` on iOS (changes once every app from your vendor is deleted) and `ANDROID_ID` on Android (survives a reinstall, changes on a factory reset).

Not collected: advertising ID, IMEI, MAC address, serial number, contacts, messages, clipboard, or a list of installed apps (only a short fixed list of remote-access and root-manager packages is checked).

## Privacy and permissions

- The library **never shows a permission prompt**.
- **Android** adds two normal permissions, neither of which prompts: `ACCESS_NETWORK_STATE` (to see a VPN or proxy) and `DETECT_SCREEN_RECORDING` (Android 15 and later, to see whether the screen is being recorded).
- **Android package visibility:** the manifest lists a short, fixed set of packages with `<queries>` (remote-access apps and root managers). It does not use `QUERY_ALL_PACKAGES`. Google Play asks you to justify package visibility; the reason is fraud prevention.
- **iOS:** add your location usage text only if you turn location on.
- Declare the data in your App Store privacy details and Google Play data-safety form: device identifiers, device and security information, and optionally location, used for fraud prevention.

## Limits to know about

- Signals the app reports can be faked by a modified app. Treat them as evidence for scoring and review. Platform attestation (Play Integrity, App Attest) is not in this version.
- Root, jailbreak and emulator detection is best effort. Android emulators that imitate a real phone's model can be missed, and iOS detects the Apple Simulator only.
- iOS cannot see which other apps are running, so `remote_access_app_running` is always `false` there.
- Screen recording: iOS reports recording, mirroring and AirPlay. Android 15 and later reports recording through the system. Older Android only sees a cast or mirrored display.
- A simulator or emulator reports its host machine's memory and CPU cores.

## Moving from earlier versions

**From `prembly-tm-native`:** replace the package and the import. The API and the wire format are the same, and a phone that already has a device ID keeps it.

```diff
- import { PremblyTM } from 'prembly-tm-native';
+ import { PremblyTM } from 'prembly-react-native-kyc';
```

**From `prembly-react-native-kyc` 1.x:** the widget props are unchanged. What changes is that the library now contains native code, so you need `pod install` and a native rebuild, and the New Architecture (React Native 0.76 or later). Expo Go no longer works.

## Changelog

- **2.0.0:** the library now serves both the Identity KYC widget and Transaction Monitoring. The widget reads the phone's real device ID and details and hands them to the verification page. Screen recording is detected on iOS and on Android 15 and later, and watched while the widget is open. Requires a native build with the New Architecture.
- **1.0.2:** widget callback fix.

## Development

```sh
npm install --ignore-scripts   # install
npm test                       # unit tests
npm run typecheck
npm run build                  # builds lib/ with react-native-builder-bob
```

The example app lets you read the device and check the hand-off on a simulator or emulator. See `example/`.

## License

MIT
