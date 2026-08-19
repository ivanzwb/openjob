import { useEffect, useRef, useState } from 'react';
import { Image, Modal, Pressable, Text, TextInput, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { ResumeSection } from '@shared/resume/document';
import type { FieldSpec, SectionEntry, SectionField } from '@shared/resume/sectionModel';
import {
  createEmptyEntry,
  fieldSpecFor,
  formatUnitNumber,
  formKindForSection,
  joinEducationRole,
  moveInList,
  parseBulletsSection,
  parseEntriesSection,
  parseFieldsSection,
  parseUnitNumber,
  presetFieldsForSection,
  serializeBulletsSection,
  serializeEntriesSection,
  serializeFieldsSection,
  splitEducationRole,
  toMonthInputValue,
} from '@shared/resume/sectionModel';
import { IconButton, type IconName } from './IconButton';
import { useTaskState, useTaskResult } from '../context/RemoteTaskContext';
import { useTheme, type Palette } from '../theme';

/** 由上层注入：带整份简历上下文去请求模型，返回优化后的这一块正文 */
export type SectionPolish = (req: {
  contentMd: string;
  instruction: string;
  scopeLabel?: string;
  /** 把模型返回的这一小块文本合回整块模块正文，供上层落库 */
  mergeSection: (polished: string) => string;
  /** 这个文本框的稳定任务标识：退出编辑器再进来还能接回同一次优化 */
  taskKey: string;
}) => Promise<string>;

/** 输入框的外框，单独拆出来给「长得像输入框但其实是按钮」的控件复用（如月份选择） */
function makeInputBox(theme: Palette) {
  return {
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 8,
    backgroundColor: theme.bg,
    paddingHorizontal: 10,
    paddingVertical: 8,
  } as const;
}

function makeInput(theme: Palette) {
  return { ...makeInputBox(theme), color: theme.text, fontSize: 13 } as const;
}

const ENTRY_LABELS: Record<
  string,
  { org: string; role: string; title: string; splitRole?: boolean }
> = {
  experience: { org: '公司名称', role: '岗位', title: '工作经历' },
  project: { org: '项目名称', role: '角色', title: '项目' },
  education: { org: '学校名称', role: '专业与学历', title: '教育经历', splitRole: true },
};

function FieldLabel({ children }: { children: string }): React.JSX.Element {
  const theme = useTheme();
  return <Text style={{ color: theme.muted, fontSize: 11, marginBottom: 4 }}>{children}</Text>;
}

/** 寸照在手机上只看不改：换照片要裁剪要预览，留在桌面端做 */
function PhotoRow({ photo }: { photo: string }): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      <Image
        source={{ uri: photo }}
        style={{
          width: 60,
          height: 84,
          borderRadius: 4,
          borderWidth: 1,
          borderColor: theme.border,
          backgroundColor: '#fff',
        }}
        resizeMode="cover"
      />
      <Text style={{ flex: 1, color: theme.muted, fontSize: 11, lineHeight: 16 }}>
        寸照会排在简历抬头右侧，预览与导出都带着它；上传或更换请在桌面端操作。
      </Text>
    </View>
  );
}

/** 语义不够直白的动作仍然要文字，图标只作前缀帮着扫视 */
function GhostButton({
  label,
  onPress,
  disabled,
  danger,
  icon,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  danger?: boolean;
  icon?: IconName;
}): React.JSX.Element {
  const theme = useTheme();
  const color = danger ? theme.danger : theme.muted;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        borderWidth: 1,
        borderColor: theme.border,
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 5,
        opacity: disabled ? 0.4 : 1,
      }}
    >
      {icon ? <Ionicons name={icon} size={13} color={color} /> : null}
      <Text style={{ color, fontSize: 11 }}>{label}</Text>
    </Pressable>
  );
}

function OptionChip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      style={{
        borderWidth: 1,
        borderColor: selected ? theme.accent : theme.border,
        backgroundColor: selected ? theme.accent : 'transparent',
        borderRadius: 999,
        paddingHorizontal: 12,
        paddingVertical: 5,
      }}
    >
      <Text style={{ color: selected ? '#fff' : theme.muted, fontSize: 12 }}>{label}</Text>
    </Pressable>
  );
}

/**
 * 有候选项的字段点着选，再点一下取消（留空的字段不进 PDF）。
 * 导入来的非候选值（如「男性」）原样留成一个选项，不在换控件时丢掉。
 */
function SelectField({
  spec,
  value,
  onChange,
}: {
  spec: FieldSpec;
  value: string;
  onChange: (value: string) => void;
}): React.JSX.Element {
  const theme = useTheme();
  const options = spec.options ?? [];
  const known = value === '' || options.includes(value);
  const [custom, setCustom] = useState(false);

  if (spec.allowCustom && (custom || !known)) {
    return (
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <TextInput
          value={value}
          onChangeText={onChange}
          placeholder={spec.placeholder ?? '填写内容'}
          placeholderTextColor={theme.muted}
          style={{ ...makeInput(theme), flex: 1 }}
        />
        <GhostButton
          label="选项"
          onPress={() => {
            setCustom(false);
            onChange('');
          }}
        />
      </View>
    );
  }

  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
      {options.map((option) => (
        <OptionChip
          key={option}
          label={option}
          selected={value === option}
          onPress={() => onChange(value === option ? '' : option)}
        />
      ))}
      {!known && <OptionChip label={value} selected onPress={() => onChange('')} />}
      {spec.allowCustom && (
        <OptionChip
          label="其他…"
          selected={false}
          onPress={() => {
            setCustom(true);
            onChange('');
          }}
        />
      )}
    </View>
  );
}

/** 只填数字，单位贴在框内右侧，落库时拼回值上 */
function NumberField({
  spec,
  value,
  onChange,
}: {
  spec: FieldSpec;
  value: string;
  onChange: (value: string) => void;
}): React.JSX.Element {
  const theme = useTheme();
  const unit = spec.unit ?? '';
  const num = parseUnitNumber(value, unit);

  if (num === null) {
    return (
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholderTextColor={theme.muted}
        style={makeInput(theme)}
      />
    );
  }

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        borderWidth: 1,
        borderColor: theme.border,
        borderRadius: 8,
        backgroundColor: theme.bg,
        paddingHorizontal: 10,
      }}
    >
      <TextInput
        value={num}
        onChangeText={(next) => onChange(formatUnitNumber(next.replace(/[^\d.]/g, ''), unit))}
        keyboardType="number-pad"
        placeholder={spec.placeholder}
        placeholderTextColor={theme.muted}
        style={{ flex: 1, color: theme.text, fontSize: 13, paddingVertical: 8 }}
      />
      <Text style={{ color: theme.muted, fontSize: 12 }}>{unit}</Text>
    </View>
  );
}

const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);

/** 年份左右翻，月份点一下就选中并收起。留空是合法的：空字段不进 PDF */
function MonthPicker({
  value,
  onPick,
  onClose,
}: {
  value: string;
  onPick: (month: string) => void;
  onClose: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  const selectedYear = value ? Number(value.slice(0, 4)) : 0;
  const selectedMonth = value ? Number(value.slice(5, 7)) : 0;
  const [year, setYear] = useState(selectedYear || new Date().getFullYear());

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        onPress={onClose}
        style={{
          flex: 1,
          backgroundColor: theme.scrim,
          justifyContent: 'flex-end',
          padding: 16,
        }}
      >
        <Pressable onPress={(e) => e.stopPropagation()} style={{ width: '100%' }}>
          <View style={{ backgroundColor: theme.surface, borderRadius: 16, padding: 16, gap: 12 }}>
            <View
              style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}
            >
              <IconButton icon="chevron-back" label="上一年" onPress={() => setYear((y) => y - 1)} />
              <Text style={{ color: theme.text, fontSize: 16, fontWeight: '600' }}>{year} 年</Text>
              <IconButton
                icon="chevron-forward"
                label="下一年"
                onPress={() => setYear((y) => y + 1)}
              />
            </View>

            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {MONTHS.map((month) => {
                const selected = year === selectedYear && month === selectedMonth;
                return (
                  <Pressable
                    key={month}
                    onPress={() => onPick(`${year}-${String(month).padStart(2, '0')}`)}
                    style={{
                      flexBasis: '22%',
                      alignItems: 'center',
                      paddingVertical: 10,
                      borderRadius: 8,
                      borderWidth: 1,
                      borderColor: selected ? theme.accent : theme.border,
                      backgroundColor: selected ? theme.accent : 'transparent',
                    }}
                  >
                    <Text style={{ color: selected ? '#fff' : theme.text, fontSize: 13 }}>
                      {month} 月
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            <View style={{ flexDirection: 'row', gap: 8 }}>
              <GhostButton label="清空" onPress={() => onPick('')} />
              <GhostButton label="取消" onPress={onClose} />
            </View>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/**
 * 月份选择器。认不出格式的既有值（`2021`、`2016/09-2018/08` 这类导入残留）
 * 退回纯文本框，宁可少一个选择器也不能把用户已有的内容显示成空白。
 */
function MonthField({
  value,
  disabled,
  placeholder,
  onChange,
}: {
  value: string;
  disabled?: boolean;
  placeholder: string;
  onChange: (value: string) => void;
}): React.JSX.Element {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const month = value.trim() === '' ? '' : toMonthInputValue(value);

  if (month === null) {
    return (
      <TextInput
        value={value}
        editable={!disabled}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={theme.muted}
        style={{ ...makeInput(theme), opacity: disabled ? 0.5 : 1 }}
      />
    );
  }

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={month ? `选择月份，当前 ${month}` : '选择月份'}
        style={{
          ...makeInputBox(theme),
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          opacity: disabled ? 0.5 : 1,
        }}
      >
        <Text style={{ flex: 1, color: month ? theme.text : theme.muted, fontSize: 13 }}>
          {month || placeholder}
        </Text>
        <Ionicons name="calendar-outline" size={14} color={theme.muted} />
      </Pressable>
      {open && (
        <MonthPicker
          value={month}
          onClose={() => setOpen(false)}
          onPick={(next) => {
            onChange(next);
            setOpen(false);
          }}
        />
      )}
    </>
  );
}

function FieldValue({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}): React.JSX.Element {
  const theme = useTheme();
  const spec = fieldSpecFor(label);

  if (spec.control === 'select' && spec.options) {
    return <SelectField spec={spec} value={value} onChange={onChange} />;
  }
  if (spec.control === 'number' && spec.unit) {
    return <NumberField spec={spec} value={value} onChange={onChange} />;
  }
  return (
    <TextInput
      value={value}
      onChangeText={onChange}
      placeholder={spec.placeholder ?? '填写内容'}
      placeholderTextColor={theme.muted}
      keyboardType={
        spec.control === 'tel' ? 'phone-pad' : spec.control === 'email' ? 'email-address' : 'default'
      }
      autoCapitalize={spec.control === 'email' ? 'none' : 'sentences'}
      style={makeInput(theme)}
    />
  );
}

/**
 * 大文本框 + AI 优化：优化以整份简历为上下文，可附加用户要求，
 * 结果直接替换内容，替换前的版本留一次撤销机会。
 * 优化过程记在全局任务仓库里，切页、退出编辑器再回来仍看得到「优化中…」与结果。
 */
function PolishTextarea({
  value,
  onChange,
  label,
  placeholder,
  minHeight,
  polish,
  scopeLabel,
  taskKey,
  mergeSection,
}: {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  placeholder: string;
  minHeight: number;
  polish?: SectionPolish;
  scopeLabel?: string;
  taskKey: string;
  /** 由各表单给出：把优化后的文本合回整块模块正文 */
  mergeSection: (polished: string) => string;
}): React.JSX.Element {
  const theme = useTheme();
  const INPUT = makeInput(theme);
  const [open, setOpen] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [undoValue, setUndoValue] = useState<string | null>(null);
  const { running: busy, error } = useTaskState(taskKey);

  const valueRef = useRef(value);
  const mergeRef = useRef(mergeSection);
  useEffect(() => {
    valueRef.current = value;
    mergeRef.current = mergeSection;
  });

  // 跑完时表单可能已经重建过，这里补上结果；内容已一致就只收起面板
  useTaskResult<string>(taskKey, (next) => {
    if (next !== valueRef.current) {
      setUndoValue(valueRef.current);
      onChange(next);
    }
    setOpen(false);
  });

  const run = (): void => {
    if (!polish || busy) return;
    void polish({
      contentMd: valueRef.current,
      instruction: instruction.trim(),
      scopeLabel,
      taskKey,
      mergeSection: (polished) => mergeRef.current(polished),
    }).catch(() => undefined);
  };

  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <Text style={{ color: theme.muted, fontSize: 11 }}>{label ?? ''}</Text>
        {polish && (
          <View style={{ flexDirection: 'row', gap: 6 }}>
            {undoValue !== null && (
              <GhostButton
                icon="arrow-undo-outline"
                label="撤销优化"
                onPress={() => {
                  onChange(undoValue);
                  setUndoValue(null);
                }}
              />
            )}
            <GhostButton
              icon="sparkles-outline"
              label={busy ? '优化中…' : 'AI 优化'}
              onPress={() => setOpen((v) => !v)}
            />
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
              onPress={run}
              disabled={busy}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 4,
                backgroundColor: theme.accent,
                borderRadius: 8,
                paddingHorizontal: 12,
                paddingVertical: 6,
                opacity: busy ? 0.5 : 1,
              }}
            >
              <Ionicons name="sparkles-outline" size={13} color="#fff" />
              <Text style={{ color: '#fff', fontSize: 12 }}>{busy ? '优化中…' : '开始优化'}</Text>
            </Pressable>
            <GhostButton label="取消" onPress={() => setOpen(false)} disabled={busy} />
            <Text style={{ color: theme.muted, fontSize: 10, flex: 1 }}>只改这一块，事实取自简历原文</Text>
          </View>
          {error !== null && <Text style={{ color: theme.danger, fontSize: 11 }}>{error}</Text>}
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
  const theme = useTheme();
  const INPUT = makeInput(theme);
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
          // 按位置作 key：带上 label 的话，改字段名每敲一个字都会重建这一行、输入框跟着丢焦点
          <View key={index} style={{ gap: 4 }}>
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
              <View style={{ flex: 1 }}>
                <FieldValue
                  label={row.label}
                  value={row.value}
                  onChange={(value) =>
                    apply(rows.map((r, i) => (i === index ? { ...r, value } : r)))
                  }
                />
              </View>
              {!isPreset && (
                <IconButton
                  icon="trash-outline"
                  label={`删除${row.label || '这个字段'}`}
                  tone="danger"
                  onPress={() => apply(rows.filter((_, i) => i !== index))}
                />
              )}
            </View>
          </View>
        );
      })}
      <GhostButton
        icon="add"
        label="添加自定义字段"
        onPress={() => apply([...rows, { label: '', value: '' }])}
      />
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
  const theme = useTheme();
  const INPUT = makeInput(theme);
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
        // 手机屏窄，操作按钮压到输入框下面一行，右对齐
        <View key={index} style={{ gap: 2 }}>
          <TextInput
            multiline
            value={item}
            onChangeText={(text) => apply(items.map((v, i) => (i === index ? text : v)))}
            placeholder="一条一句，突出成果与量化数据"
            placeholderTextColor={theme.muted}
            style={{ ...INPUT, minHeight: 52, lineHeight: 20, textAlignVertical: 'top' }}
          />
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Text style={{ flex: 1, color: theme.muted, fontSize: 11 }}>第 {index + 1} 条</Text>
            <IconButton
              icon="chevron-up"
              label={`上移第 ${index + 1} 条`}
              disabled={index === 0}
              onPress={() => apply(moveInList(items, index, -1))}
            />
            <IconButton
              icon="chevron-down"
              label={`下移第 ${index + 1} 条`}
              disabled={index === items.length - 1}
              onPress={() => apply(moveInList(items, index, 1))}
            />
            <IconButton
              icon="trash-outline"
              label={`删除第 ${index + 1} 条`}
              tone="danger"
              onPress={() => apply(items.filter((_, i) => i !== index))}
            />
          </View>
        </View>
      ))}
      <GhostButton icon="add" label="添加一条" onPress={() => apply([...items, ''])} />
    </View>
  );
}

function EntriesForm({
  section,
  polish,
  taskKeyPrefix,
  onContentChange,
}: {
  section: ResumeSection;
  polish?: SectionPolish;
  taskKeyPrefix: string;
  onContentChange: (contentMd: string) => void;
}): React.JSX.Element {
  const theme = useTheme();
  const INPUT = makeInput(theme);
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
        const edu = labels.splitRole ? splitEducationRole(entry.role) : null;
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
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <IconButton
                  icon="chevron-up"
                  label={`上移${labels.title}`}
                  disabled={index === 0}
                  onPress={() => apply(moveInList(entries, index, -1))}
                />
                <IconButton
                  icon="chevron-down"
                  label={`下移${labels.title}`}
                  disabled={index === entries.length - 1}
                  onPress={() => apply(moveInList(entries, index, 1))}
                />
                <IconButton
                  icon="trash-outline"
                  label={`删除这段${labels.title}`}
                  tone="danger"
                  onPress={() => apply(entries.filter((_, i) => i !== index))}
                />
              </View>
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
            {edu ? (
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <View style={{ flex: 1, gap: 4 }}>
                  <FieldLabel>专业</FieldLabel>
                  <TextInput
                    value={edu.major}
                    onChangeText={(major) =>
                      patch(index, { role: joinEducationRole(major, edu.degree) })
                    }
                    placeholderTextColor={theme.muted}
                    style={INPUT}
                  />
                </View>
                <View style={{ flex: 1, gap: 4 }}>
                  <FieldLabel>学历</FieldLabel>
                  <TextInput
                    value={edu.degree}
                    onChangeText={(degree) =>
                      patch(index, { role: joinEducationRole(edu.major, degree) })
                    }
                    placeholderTextColor={theme.muted}
                    style={INPUT}
                  />
                </View>
              </View>
            ) : (
              <View style={{ gap: 4 }}>
                <FieldLabel>{labels.role}</FieldLabel>
                <TextInput
                  value={entry.role}
                  onChangeText={(role) => patch(index, { role })}
                  placeholderTextColor={theme.muted}
                  style={INPUT}
                />
              </View>
            )}
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <View style={{ flex: 1, gap: 4 }}>
                <FieldLabel>开始时间</FieldLabel>
                <MonthField
                  value={entry.start}
                  placeholder="2021-04"
                  onChange={(start) => patch(index, { start })}
                />
              </View>
              <View style={{ flex: 1, gap: 4 }}>
                <FieldLabel>结束时间</FieldLabel>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <View style={{ flex: 1 }}>
                    <MonthField
                      value={isCurrent ? '' : entry.end}
                      disabled={isCurrent}
                      placeholder="2023-02"
                      onChange={(end) => patch(index, { end })}
                    />
                  </View>
                  <GhostButton
                    icon={isCurrent ? 'checkmark' : undefined}
                    label="至今"
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
              taskKey={`${taskKeyPrefix}:entry:${index}`}
              mergeSection={(polished) =>
                serializeEntriesSection(
                  entries.map((e, i) => (i === index ? { ...e, description: polished } : e)),
                )
              }
            />
          </View>
        );
      })}
      <GhostButton
        icon="add"
        label={`添加${labels.title}`}
        onPress={() => apply([...entries, createEmptyEntry()])}
      />
    </View>
  );
}

export function ResumeSectionForm({
  section,
  polish,
  taskKeyPrefix,
  photo,
  onContentChange,
}: {
  section: ResumeSection;
  polish?: SectionPolish;
  /** 该模块的任务前缀，例如 resume:polish:12:experience */
  taskKeyPrefix: string;
  /** 寸照存在简历行上而不是正文里，所以和模块内容分开传 */
  photo?: string | null;
  onContentChange: (contentMd: string) => void;
}): React.JSX.Element {
  switch (formKindForSection(section.key)) {
    case 'fields':
      return (
        <View style={{ gap: 12 }}>
          {section.key === 'basic' && photo ? <PhotoRow photo={photo} /> : null}
          <FieldsForm section={section} onContentChange={onContentChange} />
        </View>
      );
    case 'bullets':
      return <BulletsForm section={section} onContentChange={onContentChange} />;
    case 'entries':
      return (
        <EntriesForm
          section={section}
          polish={polish}
          taskKeyPrefix={taskKeyPrefix}
          onContentChange={onContentChange}
        />
      );
    default:
      return (
        <PolishTextarea
          value={section.contentMd}
          onChange={onContentChange}
          placeholder={'整段文字直接写，分条请用 - 开头'}
          minHeight={220}
          polish={polish}
          taskKey={`${taskKeyPrefix}:text`}
          mergeSection={(polished) => polished}
        />
      );
  }
}
