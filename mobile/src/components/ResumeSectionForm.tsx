import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import type { ResumeSection } from '@shared/resume/document';
import type { SectionEntry, SectionField } from '@shared/resume/sectionModel';
import {
  createEmptyEntry,
  formKindForSection,
  parseBulletsSection,
  parseEntriesSection,
  parseFieldsSection,
  presetFieldsForSection,
  serializeBulletsSection,
  serializeEntriesSection,
  serializeFieldsSection,
} from '@shared/resume/sectionModel';
import { theme } from '../theme';

/** 由上层注入：带整份简历上下文去请求模型，返回优化后的这一块正文 */
export type SectionPolish = (req: {
  contentMd: string;
  instruction: string;
  scopeLabel?: string;
}) => Promise<string>;

const INPUT = {
  color: theme.text,
  borderWidth: 1,
  borderColor: theme.border,
  borderRadius: 8,
  backgroundColor: theme.bg,
  paddingHorizontal: 10,
  paddingVertical: 8,
  fontSize: 13,
} as const;

const ENTRY_LABELS: Record<string, { org: string; role: string; title: string }> = {
  experience: { org: '公司名称', role: '岗位', title: '工作经历' },
  project: { org: '项目名称', role: '角色', title: '项目' },
  education: { org: '学校名称', role: '专业与学历', title: '教育经历' },
};

function FieldLabel({ children }: { children: string }): React.JSX.Element {
  return <Text style={{ color: theme.muted, fontSize: 11, marginBottom: 4 }}>{children}</Text>;
}

function GhostButton({
  label,
  onPress,
  disabled,
  danger,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  danger?: boolean;
}): React.JSX.Element {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={{
        borderWidth: 1,
        borderColor: theme.border,
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 5,
        opacity: disabled ? 0.4 : 1,
      }}
    >
      <Text style={{ color: danger ? theme.danger : theme.muted, fontSize: 11 }}>{label}</Text>
    </Pressable>
  );
}

/**
 * 大文本框 + AI 优化：优化以整份简历为上下文，可附加用户要求，
 * 结果直接替换内容，替换前的版本留一次撤销机会。
 */
function PolishTextarea({
  value,
  onChange,
  label,
  placeholder,
  minHeight,
  polish,
  scopeLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  placeholder: string;
  minHeight: number;
  polish?: SectionPolish;
  scopeLabel?: string;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [undoValue, setUndoValue] = useState<string | null>(null);

  const run = async (): Promise<void> => {
    if (!polish || busy) return;
    setBusy(true);
    setError('');
    try {
      const next = await polish({ contentMd: value, instruction: instruction.trim(), scopeLabel });
      setUndoValue(value);
      onChange(next);
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <Text style={{ color: theme.muted, fontSize: 11 }}>{label ?? ''}</Text>
        {polish && (
          <View style={{ flexDirection: 'row', gap: 6 }}>
            {undoValue !== null && (
              <GhostButton
                label="撤销优化"
                onPress={() => {
                  onChange(undoValue);
                  setUndoValue(null);
                }}
              />
            )}
            <GhostButton label="AI 优化" onPress={() => setOpen((v) => !v)} />
          </View>
        )}
      </View>

      {open && polish && (
        <View
          style={{
            borderWidth: 1,
            borderColor: theme.border,
            borderRadius: 8,
            backgroundColor: theme.surface,
            padding: 10,
            gap: 8,
          }}
        >
          <TextInput
            value={instruction}
            onChangeText={setInstruction}
            placeholder="想怎么改？如：更突出量化成果、精简到 4 条（可留空）"
            placeholderTextColor={theme.muted}
            style={INPUT}
          />
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Pressable
              onPress={() => void run()}
              disabled={busy}
              style={{
                backgroundColor: theme.accent,
                borderRadius: 8,
                paddingHorizontal: 12,
                paddingVertical: 6,
                opacity: busy ? 0.5 : 1,
              }}
            >
              <Text style={{ color: '#fff', fontSize: 12 }}>{busy ? '优化中…' : '开始优化'}</Text>
            </Pressable>
            <GhostButton label="取消" onPress={() => setOpen(false)} disabled={busy} />
            <Text style={{ color: theme.muted, fontSize: 10, flex: 1 }}>只改这一块，事实取自简历原文</Text>
          </View>
          {Boolean(error) && <Text style={{ color: theme.danger, fontSize: 11 }}>{error}</Text>}
        </View>
      )}

      <TextInput
        multiline
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={theme.muted}
        style={{ ...INPUT, minHeight, lineHeight: 20, textAlignVertical: 'top' }}
      />
    </View>
  );
}

function FieldsForm({
  section,
  onContentChange,
}: {
  section: ResumeSection;
  onContentChange: (contentMd: string) => void;
}): React.JSX.Element {
  const presets = presetFieldsForSection(section.key);
  const [rows, setRows] = useState<SectionField[]>(() =>
    parseFieldsSection(section.contentMd, section.key),
  );

  const apply = (next: SectionField[]): void => {
    setRows(next);
    onContentChange(serializeFieldsSection(next));
  };

  return (
    <View style={{ gap: 10 }}>
      {rows.map((row, index) => {
        const isPreset = index < presets.length && row.label === presets[index];
        return (
          <View key={`${row.label}-${index}`} style={{ gap: 4 }}>
            {isPreset ? (
              <FieldLabel>{row.label}</FieldLabel>
            ) : (
              <TextInput
                value={row.label}
                onChangeText={(label) =>
                  apply(rows.map((r, i) => (i === index ? { ...r, label } : r)))
                }
                placeholder="字段名"
                placeholderTextColor={theme.muted}
                style={{ ...INPUT, fontSize: 11, paddingVertical: 5 }}
              />
            )}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <TextInput
                value={row.value}
                onChangeText={(value) =>
                  apply(rows.map((r, i) => (i === index ? { ...r, value } : r)))
                }
                placeholder="填写内容"
                placeholderTextColor={theme.muted}
                style={{ ...INPUT, flex: 1 }}
              />
              {!isPreset && (
                <GhostButton
                  label="删除"
                  danger
                  onPress={() => apply(rows.filter((_, i) => i !== index))}
                />
              )}
            </View>
          </View>
        );
      })}
      <GhostButton label="+ 添加自定义字段" onPress={() => apply([...rows, { label: '', value: '' }])} />
      <Text style={{ color: theme.muted, fontSize: 11 }}>留空的字段不会出现在预览与导出的 PDF 中。</Text>
    </View>
  );
}

function BulletsForm({
  section,
  onContentChange,
}: {
  section: ResumeSection;
  onContentChange: (contentMd: string) => void;
}): React.JSX.Element {
  const [items, setItems] = useState<string[]>(() => {
    const parsed = parseBulletsSection(section.contentMd);
    return parsed.length > 0 ? parsed : [''];
  });

  const apply = (next: string[]): void => {
    setItems(next);
    onContentChange(serializeBulletsSection(next));
  };

  return (
    <View style={{ gap: 8 }}>
      {items.map((item, index) => (
        <View key={index} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 6 }}>
          <TextInput
            multiline
            value={item}
            onChangeText={(text) => apply(items.map((v, i) => (i === index ? text : v)))}
            placeholder="一条一句，突出成果与量化数据"
            placeholderTextColor={theme.muted}
            style={{ ...INPUT, flex: 1, minHeight: 52, lineHeight: 20, textAlignVertical: 'top' }}
          />
          <GhostButton label="删除" danger onPress={() => apply(items.filter((_, i) => i !== index))} />
        </View>
      ))}
      <GhostButton label="+ 添加一条" onPress={() => apply([...items, ''])} />
    </View>
  );
}

function EntriesForm({
  section,
  polish,
  onContentChange,
}: {
  section: ResumeSection;
  polish?: SectionPolish;
  onContentChange: (contentMd: string) => void;
}): React.JSX.Element {
  const labels = ENTRY_LABELS[section.key] ?? { org: '名称', role: '角色', title: '条目' };
  const [entries, setEntries] = useState<SectionEntry[]>(() => {
    const parsed = parseEntriesSection(section.contentMd);
    return parsed.length > 0 ? parsed : [createEmptyEntry()];
  });

  const apply = (next: SectionEntry[]): void => {
    setEntries(next);
    onContentChange(serializeEntriesSection(next));
  };
  const patch = (index: number, part: Partial<SectionEntry>): void => {
    apply(entries.map((e, i) => (i === index ? { ...e, ...part } : e)));
  };

  return (
    <View style={{ gap: 12 }}>
      {entries.map((entry, index) => {
        const isCurrent = entry.end.trim() === '至今';
        return (
          <View
            key={index}
            style={{
              borderWidth: 1,
              borderColor: theme.border,
              borderRadius: 10,
              padding: 10,
              gap: 10,
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <Text style={{ color: theme.muted, fontSize: 11 }}>
                {labels.title} {index + 1}
              </Text>
              <GhostButton
                label="删除"
                danger
                onPress={() => apply(entries.filter((_, i) => i !== index))}
              />
            </View>

            <View style={{ gap: 4 }}>
              <FieldLabel>{labels.org}</FieldLabel>
              <TextInput
                value={entry.org}
                onChangeText={(org) => patch(index, { org })}
                placeholderTextColor={theme.muted}
                style={INPUT}
              />
            </View>
            <View style={{ gap: 4 }}>
              <FieldLabel>{labels.role}</FieldLabel>
              <TextInput
                value={entry.role}
                onChangeText={(role) => patch(index, { role })}
                placeholderTextColor={theme.muted}
                style={INPUT}
              />
            </View>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <View style={{ flex: 1, gap: 4 }}>
                <FieldLabel>开始时间</FieldLabel>
                <TextInput
                  value={entry.start}
                  onChangeText={(start) => patch(index, { start })}
                  placeholder="2021-04"
                  placeholderTextColor={theme.muted}
                  style={INPUT}
                />
              </View>
              <View style={{ flex: 1, gap: 4 }}>
                <FieldLabel>结束时间</FieldLabel>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <TextInput
                    value={isCurrent ? '' : entry.end}
                    editable={!isCurrent}
                    onChangeText={(end) => patch(index, { end })}
                    placeholder="2023-02"
                    placeholderTextColor={theme.muted}
                    style={{ ...INPUT, flex: 1, opacity: isCurrent ? 0.5 : 1 }}
                  />
                  <GhostButton
                    label={isCurrent ? '✓ 至今' : '至今'}
                    onPress={() => patch(index, { end: isCurrent ? '' : '至今' })}
                  />
                </View>
              </View>
            </View>

            <PolishTextarea
              label="职责与成果"
              value={entry.description}
              onChange={(description) => patch(index, { description })}
              placeholder={'业务背景、团队规模可直接成段写。\n分条请用 - 开头'}
              minHeight={130}
              polish={polish}
              scopeLabel={[entry.org, entry.role].filter(Boolean).join(' | ') || undefined}
            />
          </View>
        );
      })}
      <GhostButton label={`+ 添加${labels.title}`} onPress={() => apply([...entries, createEmptyEntry()])} />
    </View>
  );
}

export function ResumeSectionForm({
  section,
  polish,
  onContentChange,
}: {
  section: ResumeSection;
  polish?: SectionPolish;
  onContentChange: (contentMd: string) => void;
}): React.JSX.Element {
  switch (formKindForSection(section.key)) {
    case 'fields':
      return <FieldsForm section={section} onContentChange={onContentChange} />;
    case 'bullets':
      return <BulletsForm section={section} onContentChange={onContentChange} />;
    case 'entries':
      return <EntriesForm section={section} polish={polish} onContentChange={onContentChange} />;
    default:
      return (
        <PolishTextarea
          value={section.contentMd}
          onChange={onContentChange}
          placeholder={'整段文字直接写，分条请用 - 开头'}
          minHeight={220}
          polish={polish}
        />
      );
  }
}
