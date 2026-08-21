import { ActivityIndicator, KeyboardAvoidingView, Platform, View, Text } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { NavigationContainer } from '@react-navigation/native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppProvider, useApp } from './src/context/AppContext';
import { RemoteTaskProvider } from './src/context/RemoteTaskContext';
import { ToastProvider } from './src/components/Toast';
import { RootTabs } from './src/navigation/RootTabs';
import { useTheme } from './src/theme';

function AppShell(): React.JSX.Element {
  const theme = useTheme();
  const { ready } = useApp();

  if (!ready) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.bg }}>
        <ActivityIndicator color={theme.accent} />
        <Text style={{ color: theme.muted, marginTop: 8 }}>正在初始化本地数据库…</Text>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1 }}
    >
      <NavigationContainer>
        <RootTabs />
        <StatusBar style={theme.scheme === 'dark' ? 'light' : 'dark'} />
      </NavigationContainer>
    </KeyboardAvoidingView>
  );
}

export default function App(): React.JSX.Element {
  return (
    <SafeAreaProvider>
      <AppProvider>
        <ToastProvider>
          <RemoteTaskProvider>
            <AppShell />
          </RemoteTaskProvider>
        </ToastProvider>
      </AppProvider>
    </SafeAreaProvider>
  );
}
