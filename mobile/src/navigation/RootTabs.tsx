import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Ionicons } from '@expo/vector-icons';
import type { ComponentProps } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { OverviewScreen } from '../screens/OverviewScreen';
import { ScriptsScreen } from '../screens/ScriptsScreen';
import { CampaignsScreen } from '../screens/CampaignsScreen';
import { DesignScreen } from '../screens/DesignScreen';
import { ReposScreen } from '../screens/ReposScreen';
import { ResumesScreen } from '../screens/ResumesScreen';
import { SyncScreen } from '../screens/SyncScreen';
import { MoreScreen } from '../screens/MoreScreen';
import { AppHeaderTitle } from '../components/AppHeaderTitle';
import { useRemoteTask } from '../context/RemoteTaskContext';
import { useTheme } from '../theme';

export type RootTabParamList = {
  Overview: undefined;
  Campaigns: { campaignId?: string; nodeId?: string; focusKey?: number } | undefined;
  Resumes: undefined;
  Design: undefined;
  More: undefined;
  Repos: undefined;
  Scripts: undefined;
  Sync: undefined;
};

const Tab = createBottomTabNavigator<RootTabParamList>();

type IoniconName = ComponentProps<typeof Ionicons>['name'];

const TAB_ICONS: Record<string, { active: IoniconName; inactive: IoniconName }> = {
  Overview: { active: 'analytics', inactive: 'analytics-outline' },
  Campaigns: { active: 'school', inactive: 'school-outline' },
  Resumes: { active: 'document-text', inactive: 'document-text-outline' },
  Design: { active: 'mic-circle', inactive: 'mic-circle-outline' },
  More: { active: 'ellipsis-horizontal-circle', inactive: 'ellipsis-horizontal-circle-outline' },
  Repos: { active: 'code-slash', inactive: 'code-slash-outline' },
  Scripts: { active: 'chatbubble-ellipses', inactive: 'chatbubble-ellipses-outline' },
  Sync: { active: 'sync', inactive: 'sync-outline' },
};

function TabIcon({
  routeName,
  focused,
  color,
  size,
}: {
  routeName: string;
  focused: boolean;
  color: string;
  size: number;
}): React.JSX.Element {
  const icons = TAB_ICONS[routeName];
  return <Ionicons name={focused ? icons.active : icons.inactive} size={size} color={color} />;
}

function TaskHeaderRight(): React.JSX.Element {
  const theme = useTheme();
  const { active } = useRemoteTask();
  if (!active) return <View style={{ width: 8 }} />;
  return (
    <View
      style={{
        maxWidth: 168,
        marginRight: 12,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: theme.border,
        backgroundColor: theme.bg,
        paddingHorizontal: 8,
        paddingVertical: 4,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
      }}
    >
      <ActivityIndicator size="small" color={theme.accent} />
      <Text style={{ color: theme.accent, fontSize: 11 }} numberOfLines={1}>
        正在 {active.label}
        {active.count > 1 ? ` +${active.count - 1}` : ''}
      </Text>
    </View>
  );
}

export function RootTabs(): React.JSX.Element {
  const theme = useTheme();
  return (
    <Tab.Navigator
      detachInactiveScreens={false}
      screenOptions={({ route }) => ({
        headerStyle: { backgroundColor: theme.surface },
        headerTintColor: theme.text,
        headerRight: () => <TaskHeaderRight />,
        tabBarStyle: {
          backgroundColor: theme.surface,
          borderTopColor: theme.border,
          height: 62,
          paddingTop: 6,
          paddingBottom: 8,
        },
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
        tabBarActiveTintColor: theme.accent,
        tabBarInactiveTintColor: theme.muted,
        tabBarHideOnKeyboard: true,
        tabBarIcon: (props) => <TabIcon routeName={route.name} {...props} />,
        lazy: false,
        freezeOnBlur: false,
      })}
    >
      <Tab.Screen
        name="Overview"
        component={OverviewScreen}
        options={{
          title: '总览',
          tabBarLabel: '总览',
          headerTitle: () => <AppHeaderTitle title="总览" icon={TAB_ICONS.Overview.active} />,
        }}
      />
      <Tab.Screen
        name="Campaigns"
        component={CampaignsScreen}
        options={{
          title: '备考',
          tabBarLabel: '备考',
          headerTitle: () => <AppHeaderTitle title="备考" icon={TAB_ICONS.Campaigns.active} />,
        }}
      />
      <Tab.Screen
        name="Resumes"
        component={ResumesScreen}
        options={{
          title: '简历',
          tabBarLabel: '简历',
          headerTitle: () => <AppHeaderTitle title="简历" icon={TAB_ICONS.Resumes.active} />,
        }}
      />
      <Tab.Screen
        name="Design"
        component={DesignScreen}
        options={{
          title: '模拟面试',
          tabBarLabel: '面试',
          headerTitle: () => <AppHeaderTitle title="模拟面试" icon={TAB_ICONS.Design.active} />,
        }}
      />
      <Tab.Screen
        name="More"
        component={MoreScreen}
        options={{
          title: '更多',
          tabBarLabel: '更多',
          headerTitle: () => <AppHeaderTitle title="更多" icon={TAB_ICONS.More.active} />,
        }}
      />
      <Tab.Screen
        name="Repos"
        component={ReposScreen}
        options={{
          title: '源码',
          tabBarButton: () => null,
          tabBarItemStyle: { display: 'none' },
          headerTitle: () => <AppHeaderTitle title="源码" icon={TAB_ICONS.Repos.active} />,
        }}
      />
      <Tab.Screen
        name="Scripts"
        component={ScriptsScreen}
        options={{
          title: '话术',
          tabBarButton: () => null,
          tabBarItemStyle: { display: 'none' },
          headerTitle: () => <AppHeaderTitle title="话术" icon={TAB_ICONS.Scripts.active} />,
        }}
      />
      <Tab.Screen
        name="Sync"
        component={SyncScreen}
        options={{
          title: '同步',
          tabBarButton: () => null,
          tabBarItemStyle: { display: 'none' },
          headerTitle: () => <AppHeaderTitle title="同步" icon={TAB_ICONS.Sync.active} />,
        }}
      />
    </Tab.Navigator>
  );
}
