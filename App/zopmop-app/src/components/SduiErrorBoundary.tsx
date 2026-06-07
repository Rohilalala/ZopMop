// SduiErrorBoundary — catches JS render errors in the SDUI section tree so a
// single bad/unexpected config doesn't white-screen or crash the whole app
// (which previously forced a re-login). Native crashes can't be caught here;
// this only guards JS-thrown render errors. Resets when `resetKey` changes
// (e.g. a new config_hash arrives) so a fixed config recovers automatically.

import React from 'react';
import { View, Text, type TextStyle } from 'react-native';

const fontBold: TextStyle = { fontFamily: 'PlusJakartaSans_700Bold' };

type Props = { children: React.ReactNode; resetKey?: string };
type State = { hasError: boolean };

export class SduiErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidUpdate(prev: Props) {
    if (prev.resetKey !== this.props.resetKey && this.state.hasError) {
      this.setState({ hasError: false });
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <View style={{ padding: 24, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={[fontBold, { fontSize: 15, color: '#9A9A9A', textAlign: 'center' }]}>
            This screen couldn't load.
          </Text>
          <Text style={{ fontSize: 13, color: '#9A9A9A', textAlign: 'center', marginTop: 6 }}>
            Pull to refresh to try again.
          </Text>
        </View>
      );
    }
    return this.props.children as React.ReactElement;
  }
}
