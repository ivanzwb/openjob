import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { OverviewScreen } from '../screens/OverviewScreen';
import { ScriptsScreen } from '../screens/ScriptsScreen';
import { CampaignsScreen } from '../screens/CampaignsScreen';
import { DesignScreen } from '../screens/DesignScreen';
import { ReposScreen } from '../screens/ReposScreen';
import { SyncScreen } from '../screens/SyncScreen';
import { AppHeaderTitle } from '../components/AppHeaderTitle';
import { theme } from '../theme';

const Tab = createBottomTabNavigator();

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
      <Tab.Screen
        name="Overview"
        component={OverviewScreen}
        options={{ title: '总览', tabBarLabel: '总览', headerTitle: () => <AppHeaderTitle title="总览" /> }}
      />
      <Tab.Screen
        name="Campaigns"
        component={CampaignsScreen}
        options={{ title: '备考', tabBarLabel: '备考', headerTitle: () => <AppHeaderTitle title="备考" /> }}
      />
      <Tab.Screen
        name="Design"
        component={DesignScreen}
        options={{ title: '模拟面试', tabBarLabel: '模拟面试', headerTitle: () => <AppHeaderTitle title="模拟面试" /> }}
      />
      <Tab.Screen
        name="Repos"
        component={ReposScreen}
        options={{ title: '源码', tabBarLabel: '源码', headerTitle: () => <AppHeaderTitle title="源码" /> }}
      />
      <Tab.Screen
        name="Scripts"
        component={ScriptsScreen}
        options={{ title: '话术', tabBarLabel: '话术', headerTitle: () => <AppHeaderTitle title="话术" /> }}
      />
      <Tab.Screen
        name="Sync"
        component={SyncScreen}
        options={{ title: '同步', tabBarLabel: '同步', headerTitle: () => <AppHeaderTitle title="同步" /> }}
      />
    </Tab.Navigator>
  );
}
