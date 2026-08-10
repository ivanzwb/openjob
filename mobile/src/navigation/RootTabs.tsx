import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Text } from 'react-native';
import { TodayScreen } from '../screens/TodayScreen';
import { OverviewScreen } from '../screens/OverviewScreen';
import { ScriptsScreen } from '../screens/ScriptsScreen';
import { CampaignsScreen } from '../screens/CampaignsScreen';
import { DesignScreen } from '../screens/DesignScreen';
import { ChatScreen } from '../screens/ChatScreen';
import { ReposScreen } from '../screens/ReposScreen';
import { SyncScreen } from '../screens/SyncScreen';
import { useRemoteTask } from '../context/RemoteTaskContext';
import { theme } from '../theme';

const Tab = createBottomTabNavigator();

function TaskHeaderTitle({ title }: { title: string }): React.JSX.Element {
  const { active } = useRemoteTask();
  return (
    <Text style={{ color: theme.text, fontSize: 17, fontWeight: '600' }}>
      {title}
      {active ? ` · ${active.label}` : ''}
    </Text>
  );
}

export function RootTabs(): React.JSX.Element {
  return (
    <Tab.Navigator
      detachInactiveScreens={false}
      screenOptions={{
        headerStyle: { backgroundColor: theme.surface },
        headerTintColor: theme.text,
        tabBarStyle: { backgroundColor: theme.surface, borderTopColor: theme.border },
        tabBarActiveTintColor: theme.accent,
        tabBarInactiveTintColor: theme.muted,
        lazy: false,
        freezeOnBlur: false,
      }}
    >
      <Tab.Screen name="Today" component={TodayScreen} options={{ title: '今日', tabBarLabel: '今日' }} />
      <Tab.Screen name="Overview" component={OverviewScreen} options={{ title: '总览', tabBarLabel: '总览' }} />
      <Tab.Screen name="Scripts" component={ScriptsScreen} options={{ title: '话术', tabBarLabel: '话术' }} />
      <Tab.Screen
        name="Campaigns"
        component={CampaignsScreen}
        options={{ title: '备考', tabBarLabel: '备考', headerTitle: () => <TaskHeaderTitle title="备考" /> }}
      />
      <Tab.Screen
        name="Design"
        component={DesignScreen}
        options={{ title: '设计', tabBarLabel: '设计', headerTitle: () => <TaskHeaderTitle title="设计" /> }}
      />
      <Tab.Screen
        name="Chat"
        component={ChatScreen}
        options={{ title: '对话', tabBarLabel: '对话', headerTitle: () => <TaskHeaderTitle title="对话" /> }}
      />
      <Tab.Screen
        name="Repos"
        component={ReposScreen}
        options={{ title: '源码', tabBarLabel: '源码', headerTitle: () => <TaskHeaderTitle title="源码" /> }}
      />
      <Tab.Screen name="Sync" component={SyncScreen} options={{ title: '同步', tabBarLabel: '同步' }} />
    </Tab.Navigator>
  );
}
