import { useRef, useState } from 'react';
import {
  ScrollView,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollViewProps,
} from 'react-native';
import { useTheme } from '../theme';

type Props = Omit<ScrollViewProps, 'horizontal' | 'showsHorizontalScrollIndicator'>;

export function OverflowHintScrollView({
  children,
  contentContainerStyle,
  scrollEventThrottle = 16,
  ...props
}: Props): React.JSX.Element {
  const theme = useTheme();
  const [overflow, setOverflow] = useState(false);
  const [atEnd, setAtEnd] = useState(false);
  const viewportWidthRef = useRef(0);
  const contentWidthRef = useRef(0);

  const refreshOverflow = (): void => {
    const nextOverflow = contentWidthRef.current - viewportWidthRef.current > 12;
    setOverflow(nextOverflow);
    if (!nextOverflow) setAtEnd(true);
  };

  const handleScroll = (event: NativeSyntheticEvent<NativeScrollEvent>): void => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    setAtEnd(contentOffset.x + layoutMeasurement.width >= contentSize.width - 16);
    props.onScroll?.(event);
  };

  return (
    <View
      onLayout={(event) => {
        viewportWidthRef.current = event.nativeEvent.layout.width;
        refreshOverflow();
      }}
      style={{ position: 'relative' }}
    >
      <ScrollView
        {...props}
        horizontal
        showsHorizontalScrollIndicator={false}
        scrollEventThrottle={scrollEventThrottle}
        onScroll={handleScroll}
        onContentSizeChange={(width, height) => {
          contentWidthRef.current = width;
          refreshOverflow();
          props.onContentSizeChange?.(width, height);
        }}
        contentContainerStyle={[{ paddingRight: overflow ? 48 : 0 }, contentContainerStyle]}
      >
        {children}
      </ScrollView>
      {overflow && !atEnd && (
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            right: 0,
            top: 0,
            bottom: 0,
            width: 44,
            alignItems: 'flex-end',
            justifyContent: 'center',
            backgroundColor: `${theme.bg}F2`,
          }}
        >
          <View
            style={{
              width: 28,
              height: 28,
              borderRadius: 14,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: theme.surface,
              borderWidth: 1,
              borderColor: theme.border,
            }}
          >
            <Text style={{ color: theme.accent, fontSize: 22, lineHeight: 24 }}>›</Text>
          </View>
        </View>
      )}
    </View>
  );
}
