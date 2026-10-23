import {
  useState,
  useEffect,
  useRef,
  type ComponentProps,
  type ComponentType,
  type Ref,
} from 'react';
import { View, Text, ActivityIndicator, StyleSheet, Modal, TouchableOpacity, SafeAreaView } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import {
  buildNativeDeviceScript,
  collectNativeDevice,
  WIDGET_ORIGIN,
  type NativeDeviceData,
} from './nativeDevice';
import { buildScreenUpdateScript, startScreenWatch } from './screenWatch';

// react-native-webview's types do not expose the WebView's methods or accept a ref, though the
// component does. Describe the one method used here and type the component to accept the ref.
interface WebViewHandle {
  injectJavaScript: (script: string) => void;
}
const WebViewWithRef = WebView as unknown as ComponentType<
  ComponentProps<typeof WebView> & { ref?: Ref<WebViewHandle> }
>;

export interface PremblyIdentityWidgetProps {
  isVisible: boolean;
  widgetKey: string;
  widgetId: string;
  email?: string;
  phone?: string;
  firstName?: string;
  lastName?: string;
  metadata?: Record<string, any>;
  /**
   * Read the phone's own device ID and details and give them to the widget, so the check sees the
   * real device and not a guess from the browser. On by default. If the phone cannot be read the
   * widget carries on with what the web page can see. No permission is asked for.
   */
  collectDeviceData?: boolean;
  callback: (response: any) => void;
}

export const PremblyIdentityWidget = ({
  isVisible,
  widgetKey,
  widgetId,
  email = '',
  phone = '',
  firstName = '',
  lastName = '',
  metadata = {},
  collectDeviceData = true,
  callback,
}: PremblyIdentityWidgetProps) => {
  const [webViewUrl, setWebViewUrl] = useState<string | null>(null);
  const [nativeDevice, setNativeDevice] = useState<NativeDeviceData | null>(null);
  const webViewRef = useRef<WebViewHandle>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (isVisible) {
      initializePremblyWidget();
    } else {
      setWebViewUrl(null);
      setNativeDevice(null);
      setIsLoading(true);
      setErrorMessage(null);
    }
  }, [isVisible]);

  // While the widget is on screen, keep asking the phone whether the screen is being recorded or
  // shared and tell the page. A recording started after the first read, even one that stops again,
  // still reaches the verification. Nothing is asked of the person and nothing is shown.
  useEffect(() => {
    if (!isVisible || !webViewUrl || !nativeDevice) return;
    return startScreenWatch(
      (state) => webViewRef.current?.injectJavaScript(buildScreenUpdateScript(state)),
      {
        alreadySeen:
          nativeDevice.signals.scam_signals?.is_screen_shared_or_recorded === true,
      }
    );
  }, [isVisible, webViewUrl, nativeDevice]);

  const initializePremblyWidget = async () => {
    setIsLoading(true);
    setErrorMessage(null);

    const apiUrl = 'https://api.prembly.com/api/v1/checker-widget/sdk/sessions/initiate/';

    // Read the phone while the session is being created. It never fails and is time-limited.
    const devicePromise: Promise<NativeDeviceData | null> = collectDeviceData
      ? collectNativeDevice()
      : Promise.resolve(null);

    const requestBody = {
      first_name: firstName,
      last_name: lastName,
      email: email,
      phone: phone,
      widget_key: widgetKey,
      widget_id: widgetId,
      metadata: metadata,
    };

    try {
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Accept': '*/*',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      if (response.ok) {
        const responseData = await response.json();
        if (responseData.status === true && responseData.data) {
          const sessionId = responseData.data.session.session_id;
          setNativeDevice(await devicePromise);
          setWebViewUrl(`${WIDGET_ORIGIN}/?session=${sessionId}`);
        } else {
          const errorMsg = responseData.detail || 'Failed to get widget ID from API.';
          setErrorMessage(errorMsg);
          callback({ status: 'api_error', message: errorMsg });
        }
      } else {
        const text = await response.text();
        const errorMsg = `API call failed with status: ${response.status}. Response: ${text}`;
        setErrorMessage(errorMsg);
        callback({ status: 'api_error', message: errorMsg });
      }
    } catch (e: any) {
      const errorMsg = `Network error or data parsing error: ${e.message}`;
      setErrorMessage(errorMsg);
      callback({ status: 'network_error', message: errorMsg });
    } finally {
      setIsLoading(false);
    }
  };

  const handleMessage = (event: WebViewMessageEvent) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);
      
      // The web widget might send the event name in either `event` or `status` property
      const eventName = data.event || data.status;
      
      if (eventName) {
        switch (eventName) {
          case 'closed':
            callback({ status: 'closed' });
            break;
          case 'error':
            callback({ status: 'error', message: data.message });
            break;
          case 'verified':
          case 'success':
            callback({ status: 'success', data: data });
            break;
          default:
            console.warn('Received unknown event from WebView:', eventName);
            // Forward unknown events to the callback so the developer can see them
            callback({ status: eventName, data: data });
            break;
        }
      } else {
        // Fallback: just send the raw data back to the callback
        callback({ status: 'unknown_payload', data: data });
      }
    } catch (e) {
      console.error('Error decoding JSON from WebView:', e);
      callback({ status: 'error', message: `Failed to process message from WebView: ${e}` });
    }
  };

  if (!isVisible) return null;

  return (
    <Modal visible={isVisible} animationType="slide" transparent={false}>
      <SafeAreaView style={styles.container}>
        {isLoading ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color="#0000ff" />
            <Text style={styles.loadingText}>Initializing secure session...</Text>
          </View>
        ) : errorMessage ? (
          <View style={styles.center}>
            <Text style={styles.errorText}>Error: {errorMessage}</Text>
            <TouchableOpacity style={styles.button} onPress={initializePremblyWidget}>
              <Text style={styles.buttonText}>Retry</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.buttonSecondary} onPress={() => callback({ status: 'error_display_closed' })}>
              <Text style={styles.buttonTextSecondary}>Cancel</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <WebViewWithRef
            ref={webViewRef}
            source={{ uri: webViewUrl! }}
            onMessage={handleMessage}
            // Runs before the page does, and only hands the data to the Prembly widget origin.
            injectedJavaScriptBeforeContentLoaded={
              nativeDevice ? buildNativeDeviceScript(nativeDevice) : undefined
            }
            injectedJavaScript={`
              window.addEventListener("message", (event) => {
                window.ReactNativeWebView.postMessage(JSON.stringify(event.data));
              }, false);
              true; // note: this is required, or you'll sometimes get silent failures
            `}
            style={styles.webview}
            allowsInlineMediaPlayback
            mediaPlaybackRequiresUserAction={false}
          />
        )}
      </SafeAreaView>
    </Modal>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  loadingText: {
    marginTop: 16,
    fontSize: 16,
    color: '#333',
  },
  errorText: {
    color: 'red',
    fontSize: 16,
    textAlign: 'center',
    marginBottom: 20,
  },
  webview: {
    flex: 1,
  },
  button: {
    backgroundColor: '#007bff',
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 8,
    marginBottom: 10,
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  buttonSecondary: {
    backgroundColor: 'transparent',
    paddingVertical: 12,
    paddingHorizontal: 24,
  },
  buttonTextSecondary: {
    color: '#007bff',
    fontSize: 16,
  },
});
