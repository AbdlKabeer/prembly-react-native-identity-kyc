import { useEffect, useRef, useState } from 'react';
import {
  Platform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { WebView } from 'react-native-webview';
import { PremblyTM } from 'prembly-react-native-kyc';
// Internals, imported by path because the example exercises exactly what the widget calls.
import {
  buildNativeDeviceScript,
  collectNativeDevice,
  WIDGET_ORIGIN,
  type NativeDeviceData,
} from '../../src/nativeDevice';
import {
  buildScreenUpdateScript,
  startScreenWatch,
} from '../../src/screenWatch';

// A page served as if it came from the Prembly widget origin, so the origin check in the injected
// script passes without a real verification session. It prints what the page receives.
const TEST_PAGE = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font:12px Menlo,monospace;padding:8px;word-break:break-all}b{color:#0f766e}</style></head><body>
<div><b>origin:</b> <span id="o"></span></div>
<div><b>global present:</b> <span id="p">checking…</span></div>
<div><b>screen now / seen:</b> <span id="s">-</span></div>
<div><b>updates received:</b> <span id="u">0</span></div>
<pre id="d" style="white-space:pre-wrap"></pre>
<script>
var n = 0;
function render() {
  var d = window.__PREMBLY_NATIVE_DEVICE__;
  document.getElementById('o').textContent = location.origin;
  document.getElementById('p').textContent = d ? 'YES' : 'NO';
  if (d) {
    var sc = (d.signals && d.signals.scam_signals) || {};
    document.getElementById('s').textContent = sc.is_screen_shared_or_recorded + ' / ' + sc.screen_capture_seen;
    document.getElementById('d').textContent = JSON.stringify({ deviceId: d.deviceId, deviceIdSource: d.deviceIdSource, platformDeviceId: d.platformDeviceId, platform: d.platform }, null, 1);
  }
}
window.addEventListener('prembly:native-device-update', function () { n++; document.getElementById('u').textContent = n; render(); });
setTimeout(render, 300);
</script></body></html>`;

export default function App() {
  const [device, setDevice] = useState<NativeDeviceData | null | 'loading'>(null);
  const [showPage, setShowPage] = useState(false);
  const [deviceIdAgain, setDeviceIdAgain] = useState<string>('');
  const webRef = useRef<{ injectJavaScript: (s: string) => void } | null>(null);

  const read = async () => {
    setDevice('loading');
    setDevice(await collectNativeDevice());
    setDeviceIdAgain((await PremblyTM.getDeviceId()) ?? 'null');
  };

  // The widget's own watcher, while the test page is open.
  useEffect(() => {
    if (!showPage || !device || device === 'loading') return;
    return startScreenWatch(
      (state) => webRef.current?.injectJavaScript(buildScreenUpdateScript(state)),
      {
        intervalMs: 1000,
        alreadySeen: device.signals.scam_signals?.is_screen_shared_or_recorded === true,
      }
    );
  }, [showPage, device]);

  const injected =
    device && device !== 'loading' ? buildNativeDeviceScript(device) : undefined;

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>Device hand-off test</Text>

        <TouchableOpacity testID="read" style={styles.button} onPress={read}>
          <Text style={styles.buttonText}>1. Read the device</Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID="open"
          style={[styles.button, !device && styles.disabled]}
          disabled={!device || device === 'loading'}
          onPress={() => setShowPage(true)}
        >
          <Text style={styles.buttonText}>2. Open the test page (widget origin)</Text>
        </TouchableOpacity>

        {showPage ? (
          <View style={styles.web}>
            <WebView
              ref={webRef as never}
              originWhitelist={['*']}
              source={{ html: TEST_PAGE, baseUrl: WIDGET_ORIGIN }}
              injectedJavaScriptBeforeContentLoaded={injected}
            />
          </View>
        ) : null}

        <Text selectable style={styles.output}>
          {device === 'loading'
            ? 'reading…'
            : device === null
              ? 'Tap 1.'
              : `deviceId (via PremblyTM.getDeviceId): ${deviceIdAgain}\n\n` +
                JSON.stringify(device, null, 2)}
        </Text>
        <Text style={styles.footer}>{Platform.OS}</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  content: { padding: 16 },
  title: { fontSize: 20, fontWeight: '700', marginBottom: 8 },
  button: {
    backgroundColor: '#0f766e',
    padding: 12,
    borderRadius: 8,
    marginTop: 10,
    alignItems: 'center',
  },
  disabled: { opacity: 0.4 },
  buttonText: { color: '#fff', fontWeight: '600' },
  web: {
    height: 230,
    marginTop: 12,
    borderWidth: 1,
    borderColor: '#0f766e',
  },
  output: {
    marginTop: 12,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 10,
    color: '#111',
  },
  footer: { marginTop: 8, color: '#888', fontSize: 11 },
});
