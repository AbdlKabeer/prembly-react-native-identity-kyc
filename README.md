# react-native-identity-kyc

React Native version of the Prembly Identity KYC Verification SDK.

## Installation

```bash
npm install react-native-identity-kyc
# Also install peer dependencies if not already present
npm install react-native-webview
```

## Usage

```tsx
import React, { useState } from 'react';
import { View, Button } from 'react-native';
import { PremblyIdentityWidget } from 'react-native-identity-kyc';

const App = () => {
  const [isVisible, setIsVisible] = useState(false);

  return (
    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
      <Button title="Verify Identity" onPress={() => setIsVisible(true)} />
      
      <PremblyIdentityWidget
        isVisible={isVisible}
        widgetKey="your_widget_key_here"
        widgetId="your_widget_id_here"
        email="john@example.com"
        phone="+2348012345678"
        firstName="John"
        lastName="Doe"
        callback={(response) => {
          console.log('Widget Response:', response);
          if (response.status === 'closed' || response.status === 'error_display_closed' || response.status === 'success') {
            setIsVisible(false);
          }
        }}
      />
    </View>
  );
};

export default App;
```

## Properties

| Prop | Type | Required | Description |
|---|---|---|---|
| `isVisible` | `boolean` | Yes | Controls the visibility of the widget modal |
| `widgetKey` | `string` | Yes | Your Prembly widget public key |
| `widgetId` | `string` | Yes | Your configuration/widget ID from the dashboard |
| `email` | `string` | No | User's email address |
| `phone` | `string` | No | User's phone number |
| `firstName` | `string` | No | User's first name |
| `lastName` | `string` | No | User's last name |
| `metadata` | `object` | No | Additional metadata to pass to the session |
| `callback` | `function` | Yes | Called with payload indicating `closed`, `error`, or `success` |

## License
MIT
