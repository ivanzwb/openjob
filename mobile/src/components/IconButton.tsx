import { Pressable } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useTheme } from '../theme';

export type IconName = React.ComponentProps<typeof Ionicons>['name'];

/**
 * 纯图标按钮。
 *
 * 手机上没有 hover tooltip，图标错了用户只能猜，所以只在语义足够普及的动作上用
 * （删除、上移、下移）；不够直白的动作仍然带文字。label 必填，供读屏播报。
 * 图标本身画得小，靠 padding 和 hitSlop 把点击区撑到手指够得着的尺寸。
 */
export function IconButton({
  icon,
  label,
  onPress,
  tone = 'muted',
  disabled,
  size = 18,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  tone?: 'muted' | 'danger';
  disabled?: boolean;
  size?: number;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={{ padding: 7, opacity: disabled ? 0.3 : 1 }}
    >
      <Ionicons name={icon} size={size} color={tone === 'danger' ? theme.danger : theme.muted} />
    </Pressable>
  );
}
