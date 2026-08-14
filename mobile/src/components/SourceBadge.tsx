import { Text, View } from 'react-native';
import type { EvidenceKind } from '@shared/enums';
import { useTheme } from '../theme';

const LABELS: Record<EvidenceKind, string> = {
  model: '模型知识',
  web: '网络检索',
  code: '代码实证',
};

const TONES: Record<EvidenceKind, 'amber' | 'sky' | 'emerald'> = {
  model: 'amber',
  web: 'sky',
  code: 'emerald',
};

export function SourceBadge({ kind }: { kind: EvidenceKind }): React.JSX.Element {
  const theme = useTheme();
  const tone = theme.tone[TONES[kind]];
  return (
    <View
      style={{
        alignSelf: 'flex-start',
        borderWidth: 1,
        borderColor: tone.border,
        backgroundColor: tone.bg,
        borderRadius: 6,
        paddingHorizontal: 8,
        paddingVertical: 3,
      }}
    >
      <Text style={{ color: tone.text, fontSize: 11 }}>{LABELS[kind]}</Text>
    </View>
  );
}
