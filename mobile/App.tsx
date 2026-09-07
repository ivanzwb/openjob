import { ActivityIndicator, KeyboardAvoidingView, Platform, View, Text } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Ionicons } from '@expo/vector-icons';
import { useFonts } from 'expo-font';
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
  // @expo/vector-icons 的图标在字体加载完成前渲染为空节点（createIconSet 内部行为），
  // 若等首个图标挂载时才触发 Font.loadAsync，会出现 tab 栏先显示、图标后蹦出的空窗。
  // 这里在启动时与数据库初始化并行预加载 Ionicons，二者就绪前不渲染主界面。
  const [fontsLoaded, fontError] = useFonts(Ionicons.font);

  if (!ready || (!fontsLoaded && !fontError)) {
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
