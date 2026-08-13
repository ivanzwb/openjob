import { ActivityIndicator, View, Text } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { NavigationContainer } from '@react-navigation/native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppProvider, useApp } from './src/context/AppContext';
import { RemoteTaskProvider, useRemoteTask } from './src/context/RemoteTaskContext';
import { ToastProvider } from './src/components/Toast';
import { RootTabs } from './src/navigation/RootTabs';
import { theme } from './src/theme';

function TaskBanner(): React.JSX.Element | null {
  const { active } = useRemoteTask();
  if (!active) return null;
  return (
    <View style={{ backgroundColor: theme.surface, borderBottomWidth: 1, borderColor: theme.border, paddingHorizontal: 12, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <ActivityIndicator size="small" color={theme.accent} />
      <Text style={{ color: theme.text, fontSize: 12, flex: 1 }} numberOfLines={1}>
        {active.label}
        {active.count > 1 ? ` · 另有 ${active.count - 1} 项在后台进行` : ''}
      </Text>
    </View>
  );
}

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
      <TaskBanner />
      <RootTabs />
      <StatusBar style="light" />
    </NavigationContainer>
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
