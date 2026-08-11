import { Text, View } from 'react-native';
import type { EvidenceKind } from '@shared/enums';

const STYLES: Record<EvidenceKind, { label: string; color: string; border: string; bg: string }> = {
  model: { label: '模型知识', color: '#fcd34d', border: '#92400e', bg: '#451a03' },
  web: { label: '网络检索', color: '#7dd3fc', border: '#0369a1', bg: '#082f49' },
  code: { label: '代码实证', color: '#6ee7b7', border: '#047857', bg: '#052e16' },
};

export function SourceBadge({ kind }: { kind: EvidenceKind }): React.JSX.Element {
  const style = STYLES[kind];
  return (
    <View
      style={{
        alignSelf: 'flex-start',
        borderWidth: 1,
        borderColor: style.border,
        backgroundColor: style.bg,
        borderRadius: 6,
        paddingHorizontal: 8,
        paddingVertical: 3,
      }}
    >
      <Text style={{ color: style.color, fontSize: 11 }}>{style.label}</Text>
    </View>
  );
}
