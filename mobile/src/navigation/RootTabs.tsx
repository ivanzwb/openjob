import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Ionicons } from '@expo/vector-icons';
import type { ComponentProps } from 'react';
import { OverviewScreen } from '../screens/OverviewScreen';
import { ScriptsScreen } from '../screens/ScriptsScreen';
import { CampaignsScreen } from '../screens/CampaignsScreen';
import { DesignScreen } from '../screens/DesignScreen';
import { ReposScreen } from '../screens/ReposScreen';
import { ResumesScreen } from '../screens/ResumesScreen';
import { SyncScreen } from '../screens/SyncScreen';
import { AppHeaderTitle } from '../components/AppHeaderTitle';
import { theme } from '../theme';

const Tab = createBottomTabNavigator();

type IoniconName = ComponentProps<typeof Ionicons>['name'];

const TAB_ICONS: Record<string, { active: IoniconName; inactive: IoniconName }> = {
  Overview: { active: 'home', inactive: 'home-outline' },
  Campaigns: { active: 'book', inactive: 'book-outline' },
  Resumes: { active: 'document-text', inactive: 'document-text-outline' },
  Design: { active: 'mic', inactive: 'mic-outline' },
  Repos: { active: 'code-slash', inactive: 'code-slash-outline' },
  Scripts: { active: 'chatbubble-ellipses', inactive: 'chatbubble-ellipses-outline' },
  Sync: { active: 'sync', inactive: 'sync-outline' },
};

function tabIcon(routeName: string) {
  return ({ focused, color, size }: { focused: boolean; color: string; size: number }) => {
    const icons = TAB_ICONS[routeName];
    return <Ionicons name={focused ? icons.active : icons.inactive} size={size} color={color} />;
  };
}

export function RootTabs(): React.JSX.Element {
  return (
    <Tab.Navigator
      detachInactiveScreens={false}
      screenOptions={({ route }) => ({
        headerStyle: { backgroundColor: theme.surface },
        headerTintColor: theme.text,
        tabBarStyle: { backgroundColor: theme.surface, borderTopColor: theme.border },
        tabBarActiveTintColor: theme.accent,
        tabBarInactiveTintColor: theme.muted,
        tabBarIcon: tabIcon(route.name),
        lazy: false,
        freezeOnBlur: false,
      })}
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
        name="Resumes"
        component={ResumesScreen}
        options={{ title: '简历', tabBarLabel: '简历', headerTitle: () => <AppHeaderTitle title="简历" /> }}
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
