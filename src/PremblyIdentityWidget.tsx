import React, { useState, useEffect } from 'react';
import { View, Text, ActivityIndicator, StyleSheet, Modal, TouchableOpacity, SafeAreaView } from 'react-native';
import { WebView, WebViewMessageEvent } from 'react-native-webview';

export interface PremblyIdentityWidgetProps {
  isVisible: boolean;
  widgetKey: string;
  widgetId: string;
  email?: string;
  phone?: string;
  firstName?: string;
  lastName?: string;
  metadata?: Record<string, any>;
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
  callback,
}: PremblyIdentityWidgetProps) => {
  const [webViewUrl, setWebViewUrl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (isVisible) {
      initializePremblyWidget();
    } else {
      setWebViewUrl(null);
      setIsLoading(true);
      setErrorMessage(null);
    }
  }, [isVisible]);

  const initializePremblyWidget = async () => {
    setIsLoading(true);
    setErrorMessage(null);

    const apiUrl = 'https://api.prembly.com/api/v1/checker-widget/sdk/sessions/initiate/';

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
          setWebViewUrl(`https://sdk-live.prembly.com/?session=${sessionId}`);
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
      if (data.event) {
        switch (data.event) {
          case 'closed':
            callback({ status: 'closed' });
            break;
          case 'error':
            callback({ status: 'error', message: data.message });
            break;
          case 'verified':
            callback({ status: 'success', data: data });
            break;
          default:
            console.warn('Received unknown event from WebView:', data.event);
            break;
        }
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
          <WebView
            source={{ uri: webViewUrl! }}
            onMessage={handleMessage}
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
