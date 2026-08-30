import { Pressable, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect } from 'react';
import { useSpeechRecognition, type SpeechState } from '../hooks/useSpeechRecognition';
import { useTheme } from '../theme';
import { useToast } from './Toast';

/** 语音口述按钮：点一下开始录音，再点一下停止并转写；放在 TextInput 旁。 */
export function VoiceInputButton({
  onTranscript,
  disabled,
}: {
  onTranscript: (text: string) => void;
  disabled?: boolean;
}): React.JSX.Element {
  const theme = useTheme();
  const toast = useToast();
  const { state, isRecording, start, stop } = useSpeechRecognition(onTranscript);

  const busy = state.state === 'recording' || state.state === 'transcribing';
  const downloading = state.state === 'downloading';

  // 状态落到 error 时弹 toast（error 短暂保持，不打断录音流程）
  useEffect(() => {
    if (state.state === 'error') {
      toast(state.error, { variant: 'error' });
    }
  }, [state, toast]);

  // 点按切换：正在录音 → 停止；空闲/出错 → 开始。转写与下载中忽略点击，
  // 下载进度靠状态渲染，点了会跳走；isRecording 是同步判据，React state 慢一帧，
  // 连点第二下必须靠它判断该停还是该开，重复启动由 controller 内部串行化挡着
  const handlePress = (): void => {
    if (isRecording()) {
      void stop();
    } else if (state.state === 'idle' || state.state === 'error') {
      void start();
    }
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
      onPress={handlePress}
      disabled={disabled}
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