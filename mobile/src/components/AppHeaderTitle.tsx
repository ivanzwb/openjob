import { Ionicons } from '@expo/vector-icons';
import type { ComponentProps } from 'react';
import { Text, View } from 'react-native';
import { useTheme } from '../theme';

export type AppHeaderIconName = ComponentProps<typeof Ionicons>['name'];

export function AppHeaderTitle({
  title,
  icon,
}: {
  title: string;
  icon: AppHeaderIconName;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <Ionicons name={icon} size={22} color={theme.accent} />
      <Text style={{ color: theme.text, fontSize: 17, fontWeight: '600' }} numberOfLines={1}>
        {title}
      </Text>
    </View>
  );
}
