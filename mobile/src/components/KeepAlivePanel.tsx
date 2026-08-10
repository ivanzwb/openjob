import type { ReactNode } from 'react';
import { View, type ViewStyle } from 'react-native';

/** 切换视图时保持子树挂载，仅用样式隐藏，避免本地状态丢失 */
export function KeepAlivePanel({
  active,
  children,
  style,
}: {
  active: boolean;
  children: ReactNode;
  style?: ViewStyle;
}): React.JSX.Element {
  return (
    <View
      style={[{ flex: active ? 1 : undefined, display: active ? 'flex' : 'none' }, style]}
      accessibilityElementsHidden={!active}
      importantForAccessibility={active ? 'auto' : 'no-hide-descendants'}
    >
      {children}
    </View>
  );
}
