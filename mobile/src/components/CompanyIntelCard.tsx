import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { CompanyIntel } from '@shared/entities';
import { MarkdownPreview } from './MarkdownPreview';
import { useTheme } from '../theme';

/** 与桌面端 CompanyIntelCard 同一组分节，顺序也一致，两端看到的东西对得上 */
const SECTIONS: { title: string; pick: (intel: CompanyIntel) => string }[] = [
  { title: '技术栈', pick: (i) => i.techStackMd },
  { title: '面试流程', pick: (i) => i.interviewProcessMd },
  { title: '高频考点', pick: (i) => i.hotTopicsMd },
  { title: '反问素材', pick: (i) => i.talkingPointsMd },
];

export function CompanyIntelCard({ intel }: { intel: CompanyIntel }): React.JSX.Element {
  const theme = useTheme();
  // 情报四节加起来很长，手机上默认收起来，别把考点清单挤到屏幕外面去
  const [expanded, setExpanded] = useState(false);

  const sections = SECTIONS.map((s) => ({ title: s.title, content: s.pick(intel) })).filter((s) =>
    s.content.trim(),
  );

  if (sections.length === 0) {
    return (
      <Text style={{ color: theme.muted, fontSize: 12 }}>
        情报卡是空的，点「重新检索」再生成一次
      </Text>
    );
  }

  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: theme.border,
        borderRadius: 10,
        backgroundColor: theme.surface,
        padding: 12,
        gap: 8,
      }}
    >
      <Pressable
        onPress={() => setExpanded((open) => !open)}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}
      >
        <Text style={{ color: theme.text, fontWeight: '600', flex: 1 }}>公司情报</Text>
        <Text style={{ color: theme.muted, fontSize: 11 }}>
          {new Date(intel.updatedAt).toLocaleDateString()}
        </Text>
        <Text style={{ color: theme.muted, fontSize: 18, lineHeight: 22 }}>
          {expanded ? '▾' : '▸'}
        </Text>
      </Pressable>

      {expanded ? (
        <View style={{ gap: 12 }}>
          {sections.map((s) => (
            <View key={s.title} style={{ gap: 4 }}>
              <Text style={{ color: theme.muted, fontSize: 11, fontWeight: '600' }}>{s.title}</Text>
              <MarkdownPreview text={s.content} />
            </View>
          ))}
        </View>
      ) : (
        <Text style={{ color: theme.muted, fontSize: 12 }}>
          {sections.map((s) => s.title).join(' · ')}（点击展开）
        </Text>
      )}
    </View>
  );
}
