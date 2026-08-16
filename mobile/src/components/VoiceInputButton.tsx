import { Pressable, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect, useRef } from 'react';
import { useSpeechRecognition, type SpeechState } from '../hooks/useSpeechRecognition';
import { useTheme } from '../theme';
import { useToast } from './Toast';

/** 语音口述按钮：按下录音，松开转写；放在 TextInput 旁。 */
export function VoiceInputButton({
  onTranscript,
  disabled,
}: {
  onTranscript: (text: string) => void;
  disabled?: boolean;
}): React.JSX.Element {
  const theme = useTheme();
  const toast = useToast();
  const { state, start, stop } = useSpeechRecognition(onTranscript);
  const pressedRef = useRef(false);

  const busy = state.state === 'recording' || state.state === 'transcribing';
  const downloading = state.state === 'downloading';

  // 状态落到 error 时弹 toast（error 短暂保持，不打断录音流程）
  useEffect(() => {
    if (state.state === 'error') {
      toast(state.error, { variant: 'error' });
    }
  }, [state, toast]);

  const handlePressIn = (): void => {
    pressedRef.current = true;
    void start();
  };

  const handlePressOut = (): void => {
    if (!pressedRef.current) return;
    pressedRef.current = false;
    void stop();
  };

  const icon: React.ComponentProps<typeof Ionicons>['name'] =
    state.state === 'recording'
      ? 'mic'
      : state.state === 'transcribing'
        ? 'hourglass'
        : downloading
          ? 'download'
          : 'mic-outline';
  const color =
    state.state === 'recording'
      ? theme.danger
      : state.state === 'transcribing' || downloading
        ? theme.muted
        : theme.accent;

  return (
    <Pressable
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      disabled={disabled || downloading || state.state === 'transcribing'}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel="语音口述"
      style={{ padding: 7, opacity: disabled || busy ? 0.6 : 1 }}
    >
      <View style={{ alignItems: 'center', gap: 2 }}>
        <Ionicons name={icon} size={20} color={color} />
        {downloading && (
          <Text style={{ color: theme.muted, fontSize: 9 }}>{state.percent}%</Text>
        )}
      </View>
    </Pressable>
  );
}

export type { SpeechState };