import { Ionicons } from '@expo/vector-icons';
import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import type { ComponentProps } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import type { RootTabParamList } from '../navigation/RootTabs';
import { useTheme } from '../theme';

type MoreProps = BottomTabScreenProps<RootTabParamList, 'More'>;
type IoniconName = ComponentProps<typeof Ionicons>['name'];

const MORE_ITEMS: {
  title: string;
  subtitle: string;
  icon: IoniconName;
  route: keyof RootTabParamList;
}[] = [
  {
    title: '源码',
    subtitle: '项目源码摘要、文件索引和代码问答',
    icon: 'code-slash',
    route: 'Repos',
  },
  {
    title: '话术',
    subtitle: '面试时可直接复用的回答片段',
    icon: 'chatbubble-ellipses',
    route: 'Scripts',
  },
  {
    title: '同步',
    subtitle: '和桌面端同步本地备考数据',
    icon: 'sync',
    route: 'Sync',
  },
];

export function MoreScreen({ navigation }: MoreProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.bg }}
      contentContainerStyle={{ padding: 16, gap: 12 }}
    >
      <Text style={{ color: theme.muted, fontSize: 12 }}>
        低频功能集中在这里，底部只保留每天最常用的入口。
      </Text>
      {MORE_ITEMS.map((item) => (
        <Pressable
          key={item.route}
          onPress={() => navigation.navigate(item.route)}
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
