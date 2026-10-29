import {
  useState,
  useEffect,
  useRef,
  useCallback,
  type ComponentProps,
  type ComponentType,
  type Ref,
} from 'react';
import {
  View,
  Text,
  ActivityIndicator,
  StyleSheet,
  Modal,
  Platform,
  StatusBar,
  TouchableOpacity,
  SafeAreaView,
} from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import {
  buildNativeDeviceScript,
  collectNativeDevice,
  type NativeDeviceData,
} from './nativeDevice';
import { buildScreenUpdateScript, startScreenWatch } from './screenWatch';
import type {
  WorkflowCustomer,
  WorkflowEvent,
  WorkflowResult,
  WorkflowSessionInfo,
} from './types';
import { isEndState, parseWorkflowMessage } from './workflowEvents';
import { createWorkflowSession, PremblyWorkflowError } from './workflowSession';

/** The origin of a link, or '' when it is not an http(s) URL. */
export function originOf(link: string): string {
  // Not `new URL(link).origin`: React Native's URL does not implement `origin`.
  const match = /^(https?):\/\/([^\/?#]+)/i.exec(link);
  return match && match[1] && match[2]
    ? `${match[1].toLowerCase()}://${match[2].toLowerCase()}`
    : '';
}

/** `<hostedUrl>?session=<id>`, the same shape the web SDK builds. */
export function withSession(hostedUrl: string, sessionId: string): string {
  // Plain string work: React Native's URL.searchParams is not reliable across versions.
  const [beforeHash = '', hash] = hostedUrl.split('#');
  const [path = '', query = ''] = beforeHash.split('?');
  const rest = query.split('&').filter((p) => p && !p.startsWith('session='));
  rest.push(`session=${encodeURIComponent(sessionId)}`);
  return `${path}?${rest.join('&')}${hash !== undefined ? `#${hash}` : ''}`;
}

interface WebViewHandle {
  injectJavaScript: (script: string) => void;
}
const WebViewWithRef = WebView as unknown as ComponentType<
  ComponentProps<typeof WebView> & { ref?: Ref<WebViewHandle> }
>;

export interface PremblyWorkflowProps {
  isVisible: boolean;
  /** Your public key: `live_pk_...` or `test_pk_...`. */
  publishableKey: string;
  workflowId: string;
  customer: WorkflowCustomer;
  metadata?: Record<string, unknown>;
  redirectUrl?: string;
  /** Override the API base URL (for example for a staging server). */
  baseUrl?: string;
  /**
   * Open the workflow at this hosted app instead of the link the backend returns, as
   * `<hostedUrl>?session=<id>`. For testing a local or staging build of the hosted app.
   */
  hostedUrl?: string;
  /**
   * Read the phone's own device ID and details and give them to the workflow, so its device checks
   * see the real device. On by default. No permission is asked for.
   */
  collectDeviceData?: boolean;
  /** Every event the workflow reports. No personal data. */
  onEvent?: (event: WorkflowEvent) => void;
  /** Called once when the flow ends: an end state, `cancelled`, or `failed` if it could not start. */
  callback: (result: WorkflowResult) => void;
}

export const PremblyWorkflow = ({
  isVisible,
  publishableKey,
  workflowId,
  customer,
  metadata,
  redirectUrl,
  baseUrl,
  hostedUrl,
  collectDeviceData = true,
  onEvent,
  callback,
}: PremblyWorkflowProps) => {
  const [session, setSession] = useState<WorkflowSessionInfo | null>(null);
  const [nativeDevice, setNativeDevice] = useState<NativeDeviceData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const webViewRef = useRef<WebViewHandle>(null);
  const lastEvent = useRef<string | undefined>(undefined);
  const ended = useRef(false);
  // Props change on every render; the handlers read the latest without restarting the session.
  const latest = useRef({ callback, onEvent });
  latest.current = { callback, onEvent };

  const finish = useCallback((result: WorkflowResult) => {
    if (ended.current) return;
    ended.current = true;
    latest.current.callback(result);
  }, []);

  const start = useCallback(async () => {
    setIsLoading(true);
    setErrorMessage(null);
    // Read the phone while the session is created. It never fails and is time-limited.
    const devicePromise = collectDeviceData ? collectNativeDevice() : Promise.resolve(null);
    try {
      const created = await createWorkflowSession({
        publishableKey,
        workflowId,
        customer,
        metadata,
        redirectUrl,
        baseUrl,
      });
      setNativeDevice(await devicePromise);
      setSession(hostedUrl ? { ...created, link: withSession(hostedUrl, created.sessionId) } : created);
    } catch (e) {
      const error =
        e instanceof PremblyWorkflowError
          ? { code: e.code, message: e.message }
          : { code: 'network_error' as const, message: String((e as Error)?.message ?? e) };
      setErrorMessage(error.message);
      finish({ status: 'failed', error });
    } finally {
      setIsLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publishableKey, workflowId, collectDeviceData, baseUrl, hostedUrl, redirectUrl, finish]);

  useEffect(() => {
    if (isVisible) {
      ended.current = false;
      lastEvent.current = undefined;
      start();
    } else {
      setSession(null);
      setNativeDevice(null);
      setIsLoading(true);
      setErrorMessage(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVisible]);

  // Keep telling the page whether the screen is being recorded or shared while the flow is open.
  useEffect(() => {
    if (!isVisible || !session || !nativeDevice) return;
    return startScreenWatch(
      (state) => webViewRef.current?.injectJavaScript(buildScreenUpdateScript(state, originOf(session.link))),
      { alreadySeen: nativeDevice.signals.scam_signals?.is_screen_shared_or_recorded === true }
    );
  }, [isVisible, session, nativeDevice]);

  const handleMessage = (event: WebViewMessageEvent) => {
    const parsed = parseWorkflowMessage(event.nativeEvent.data);
    // Only this session's events count; a message about another session is ignored.
    if (!parsed || !session || parsed.sessionId !== session.sessionId) return;
    // The person cancelled from the widget's own Cancel button: close the flow the way the app's
    // Close button does. This is checked first so `lastEvent` is still what came before it.
    if (parsed.type === 'cancelled') {
      latest.current.onEvent?.(parsed);
      close();
      return;
    }
    lastEvent.current = parsed.type;
    latest.current.onEvent?.(parsed);
    if (isEndState(parsed.type)) {
      finish({ status: parsed.type, sessionId: session.sessionId });
    }
  };

  // The person closes the flow. Before an end state that is a cancel, and `lastEvent` says whether
  // the checks were still running (`processing`).
  const close = () => {
    if (session) {
      finish({
        status: 'cancelled',
        sessionId: session.sessionId,
        ...(lastEvent.current ? { lastEvent: lastEvent.current } : {}),
      });
    } else {
      finish({ status: 'failed', error: { code: 'network_error', message: 'Closed.' } });
    }
  };

  if (!isVisible) return null;

  return (
    <Modal visible={isVisible} animationType="slide" transparent={false} onRequestClose={close}>
      <SafeAreaView style={styles.container}>
        {isLoading ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color="#2d9d92" />
            <Text style={styles.loadingText}>Initializing secure session...</Text>
          </View>
        ) : errorMessage || !session ? (
          <View style={styles.center}>
            <Text style={styles.errorText}>Error: {errorMessage}</Text>
            <TouchableOpacity
              style={styles.button}
              onPress={() => {
                ended.current = false;
                start();
              }}
            >
              <Text style={styles.buttonText}>Retry</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.buttonSecondary} onPress={close}>
              <Text style={styles.buttonTextSecondary}>Cancel</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <>
            <TouchableOpacity style={styles.closeBar} onPress={close} accessibilityLabel="Close">
              <Text style={styles.buttonTextSecondary}>Close</Text>
            </TouchableOpacity>
            <WebViewWithRef
              ref={webViewRef}
              source={{ uri: session.link }}
              onMessage={handleMessage}
              // Runs before the page does, and only hands the data to the origin of this session's link,
              // which the Prembly backend returned.
              injectedJavaScriptBeforeContentLoaded={
                nativeDevice ? buildNativeDeviceScript(nativeDevice, originOf(session.link)) : undefined
              }
              injectedJavaScript={`
                window.addEventListener("message", (event) => {
                  window.ReactNativeWebView.postMessage(JSON.stringify(event.data));
                }, false);
                true;
              `}
              style={styles.webview}
              allowsInlineMediaPlayback
              mediaPlaybackRequiresUserAction={false}
            />
          </>
        )}
      </SafeAreaView>
    </Modal>
  );
};

const styles = StyleSheet.create({
  // SafeAreaView does nothing on Android, where the app draws under the status bar.
  container: {
    flex: 1,
    backgroundColor: '#fff',
    paddingTop: Platform.OS === 'android' ? (StatusBar.currentHeight ?? 0) : 0,
  },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 },
  loadingText: { marginTop: 12, color: '#333' },
  errorText: { color: '#b00020', textAlign: 'center', marginBottom: 16 },
  button: {
    backgroundColor: '#2d9d92',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
    marginBottom: 12,
  },
  buttonText: { color: '#fff', fontWeight: '600' },
  buttonSecondary: { paddingHorizontal: 24, paddingVertical: 12 },
  buttonTextSecondary: { color: '#2d9d92', fontWeight: '600' },
  closeBar: { alignSelf: 'flex-end', padding: 12 },
  webview: { flex: 1 },
});
