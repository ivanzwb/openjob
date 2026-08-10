import { ActivityIndicator, View, Text } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { NavigationContainer } from '@react-navigation/native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppProvider, useApp } from './src/context/AppContext';
import { RootTabs } from './src/navigation/RootTabs';
import { theme } from './src/theme';

function AppShell(): React.JSX.Element {
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
    <NavigationContainer>
      <RootTabs />
      <StatusBar style="light" />
    </NavigationContainer>
  );
}

export default function App(): React.JSX.Element {
  return (
    <SafeAreaProvider>
      <AppProvider>
        <AppShell />
      </AppProvider>
    </SafeAreaProvider>
  );
}
