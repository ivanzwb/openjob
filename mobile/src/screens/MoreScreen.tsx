import { useCallback, useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import type { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import { useFocusEffect } from '@react-navigation/native';
import type { ComponentProps } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import type { RootTabParamList } from '../navigation/RootTabs';
import { listMobilePluginRuntimes } from '../data/pluginRuntimeLocal';
import { getRawDb } from '../db';
import { useTheme } from '../theme';

type MoreNavigation = BottomTabNavigationProp<RootTabParamList, 'More'>;
type MoreProps = { navigation: MoreNavigation };
type IoniconName = ComponentProps<typeof Ionicons>['name'];

interface MoreItem {
  key: string;
  title: string;
  subtitle: string;
  icon: IoniconName;
  onPress: (navigation: MoreNavigation) => void;
}

/** 固定项：手机端不安装插件，所以这里只有「话术」与「同步」。 */
const FIXED_ITEMS: MoreItem[] = [
  {
    key: 'scripts',
    title: '话术',
    subtitle: '面试时可直接复用的回答片段',
    icon: 'chatbubble-ellipses',
    onPress: (navigation) => navigation.navigate('Scripts'),
  },
  {
    key: 'sync',
    title: '同步',
    subtitle: '和桌面端同步本地备考数据',
    icon: 'sync',
    onPress: (navigation) => navigation.navigate('Sync'),
  },
];

export function MoreScreen({ navigation }: MoreProps): React.JSX.Element {
  const theme = useTheme();
  // 岗位包自带的页面入口：一个包都没同步过来时这里就是空的——源码页这类页面是包的
  // 内容，不是基础包自带的入口，没有包就不该存在
  const [packPages, setPackPages] = useState<{ key: string; title: string; subtitle: string }[]>([]);

  useFocusEffect(
    useCallback(() => {
      setPackPages(
        listMobilePluginRuntimes(getRawDb()).map((runtime) => ({
          key: runtime.pluginId,
          title: runtime.displayName,
          subtitle: `岗位包自带的页面 · v${runtime.version}`,
        })),
      );
    }, []),
  );

  const items: MoreItem[] = [
    ...packPages.map((page) => ({
      key: page.key,
      title: page.title,
      subtitle: page.subtitle,
      icon: 'code-slash' as IoniconName,
      onPress: (nav: MoreNavigation) => nav.navigate('Plugins', { pluginId: page.key }),
    })),
    ...FIXED_ITEMS,
  ];

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.bg }}
      contentContainerStyle={{ padding: 16, gap: 12 }}
    >
      <Text style={{ color: theme.muted, fontSize: 12 }}>
        低频功能集中在这里，底部只保留每天最常用的入口。
      </Text>
      {items.map((item) => (
        <Pressable
          key={item.key}
          onPress={() => item.onPress(navigation)}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
            borderWidth: 1,
            borderColor: theme.border,
            borderRadius: 14,
            padding: 14,
            backgroundColor: theme.surface,
          }}
        >
          <View
            style={{
              width: 38,
              height: 38,
              borderRadius: 12,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: `${theme.accent}18`,
            }}
          >
            <Ionicons name={item.icon} size={20} color={theme.accent} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={{ color: theme.text, fontSize: 14, fontWeight: '600' }}>{item.title}</Text>
            <Text style={{ color: theme.muted, fontSize: 11, marginTop: 3 }} numberOfLines={2}>
              {item.subtitle}
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={theme.muted} />
        </Pressable>
      ))}
    </ScrollView>
  );
}
