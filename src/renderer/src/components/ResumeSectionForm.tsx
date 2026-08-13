import { useState } from 'react';
import type { ResumeSection, ResumeSectionKey } from '@shared/resume/document';
import type { EntriesSectionData, SectionEntry, SectionField } from '@shared/resume/sectionModel';
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

const INPUT =
  'w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-sm';
const FIELD_LABEL = 'mb-1 block text-xs text-[var(--color-muted)]';
const GHOST_BTN =
  'shrink-0 whitespace-nowrap rounded border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)] disabled:opacity-40';
const ADD_BTN =
  'whitespace-nowrap rounded-lg border border-dashed border-[var(--color-border)] px-3 py-1.5 text-xs text-[var(--color-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-fg)]';

const FIELD_PLACEHOLDER: Record<string, string> = {
  姓名: '张三',
  性别: '男',
  年龄: '28 岁',
  城市: '上海',
  电话: '13800000000',
  邮箱: 'name@example.com',
  工作年限: '5 年',
  期望岗位: '高级前端工程师',
  期望城市: '上海',
  期望薪资: '25-35K',
  到岗时间: '一个月内',
};

const ENTRY_LABELS: Record<string, { org: string; role: string; title: string }> = {
  experience: { org: '公司名称', role: '岗位', title: '工作经历' },
  project: { org: '项目名称', role: '角色', title: '项目' },
  education: { org: '学校名称', role: '专业与学历', title: '教育经历' },
};

function entryLabels(key: ResumeSectionKey): { org: string; role: string; title: string } {
  return ENTRY_LABELS[key] ?? { org: '名称', role: '角色', title: '条目' };
}

function move<T>(list: T[], index: number, delta: number): T[] {
  const target = index + delta;
  if (target < 0 || target >= list.length) return list;
  const next = [...list];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
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
  const update = (index: number, patch: Partial<SectionField>): void => {
    apply(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-3">
        {rows.map((row, index) => {
          const isPreset = index < presets.length && row.label === presets[index];
          return (
            <div key={`${row.label}-${index}`}>
              {isPreset ? (
                <label className={FIELD_LABEL}>{row.label}</label>
              ) : (
                <input
                  value={row.label}
                  onChange={(e) => update(index, { label: e.target.value })}
                  placeholder="字段名"
                  className={`${FIELD_LABEL} w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1`}
                />
              )}
              <div className="flex gap-1">
                <input
                  value={row.value}
                  onChange={(e) => update(index, { value: e.target.value })}
                  placeholder={FIELD_PLACEHOLDER[row.label] ?? '填写内容'}
                  className={INPUT}
                />
                {!isPreset && (
                  <button
                    type="button"
                    className={GHOST_BTN}
                    onClick={() => apply(rows.filter((_, i) => i !== index))}
                  >
                    删除
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <button
        type="button"
        className={ADD_BTN}
        onClick={() => apply([...rows, { label: '', value: '' }])}
      >
        + 添加自定义字段
      </button>
      <p className="text-xs text-[var(--color-muted)]">留空的字段不会出现在预览与导出的 PDF 中。</p>
    </div>
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
    <div className="space-y-2">
      {items.map((item, index) => (
        <div key={index} className="flex items-start gap-2">
          <span className="mt-2 w-4 shrink-0 text-right text-xs text-[var(--color-muted)]">
            {index + 1}
          </span>
          <textarea
            value={item}
            rows={2}
            onChange={(e) => apply(items.map((v, i) => (i === index ? e.target.value : v)))}
            placeholder="一条一句，突出成果与量化数据"
            className={`${INPUT} resize-y leading-relaxed`}
          />
          <div className="flex shrink-0 flex-col gap-1">
            <div className="flex gap-1">
              <button
                type="button"
                className={GHOST_BTN}
                disabled={index === 0}
                onClick={() => apply(move(items, index, -1))}
              >
                ↑
              </button>
              <button
                type="button"
                className={GHOST_BTN}
                disabled={index === items.length - 1}
                onClick={() => apply(move(items, index, 1))}
              >
                ↓
              </button>
            </div>
            <button
              type="button"
              className={GHOST_BTN}
              onClick={() => apply(items.filter((_, i) => i !== index))}
            >
              删除
            </button>
          </div>
        </div>
      ))}
      <button type="button" className={ADD_BTN} onClick={() => apply([...items, ''])}>
        + 添加一条
      </button>
    </div>
  );
}

function EntryCard({
  entry,
  index,
  total,
  labels,
  onChange,
  onMove,
  onRemove,
}: {
  entry: SectionEntry;
  index: number;
  total: number;
  labels: { org: string; role: string; title: string };
  onChange: (patch: Partial<SectionEntry>) => void;
  onMove: (delta: number) => void;
  onRemove: () => void;
}): React.JSX.Element {
  const isCurrent = entry.end.trim() === '至今';

  return (
    <div className="rounded-lg border border-[var(--color-border)] p-3 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-[var(--color-muted)]">
          {labels.title} {index + 1}
        </span>
        <div className="flex gap-1">
          <button
            type="button"
            className={GHOST_BTN}
            disabled={index === 0}
            onClick={() => onMove(-1)}
          >
            ↑
          </button>
          <button
            type="button"
            className={GHOST_BTN}
            disabled={index === total - 1}
            onClick={() => onMove(1)}
          >
            ↓
          </button>
          <button type="button" className={`${GHOST_BTN} text-red-400`} onClick={onRemove}>
            删除
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={FIELD_LABEL}>{labels.org}</label>
          <input
            value={entry.org}
            onChange={(e) => onChange({ org: e.target.value })}
            className={INPUT}
          />
        </div>
        <div>
          <label className={FIELD_LABEL}>{labels.role}</label>
          <input
            value={entry.role}
            onChange={(e) => onChange({ role: e.target.value })}
            className={INPUT}
          />
        </div>
        <div>
          <label className={FIELD_LABEL}>开始时间</label>
          <input
            value={entry.start}
            onChange={(e) => onChange({ start: e.target.value })}
            placeholder="2021-04"
            className={INPUT}
          />
        </div>
        <div>
          <label className={FIELD_LABEL}>结束时间</label>
          <div className="flex items-center gap-2">
            <input
              value={isCurrent ? '' : entry.end}
              disabled={isCurrent}
              onChange={(e) => onChange({ end: e.target.value })}
              placeholder="2023-02"
              className={`${INPUT} disabled:opacity-50`}
            />
            <label className="flex shrink-0 items-center gap-1 text-xs text-[var(--color-muted)]">
              <input
                type="checkbox"
                checked={isCurrent}
                onChange={(e) => onChange({ end: e.target.checked ? '至今' : '' })}
              />
              至今
            </label>
          </div>
        </div>
      </div>

      <div>
        <label className={FIELD_LABEL}>补充说明（选填）</label>
        <textarea
          value={entry.description}
          rows={2}
          onChange={(e) => onChange({ description: e.target.value })}
          placeholder="团队规模、业务背景、技术栈等整段描述"
          className={`${INPUT} resize-y leading-relaxed`}
        />
      </div>

      <div className="space-y-2">
        <label className={FIELD_LABEL}>职责与成果</label>
        {entry.bullets.map((bullet, bulletIndex) => (
          <div key={bulletIndex} className="flex items-start gap-2">
            <span className="mt-2 shrink-0 text-xs text-[var(--color-muted)]">·</span>
            <textarea
              value={bullet}
              rows={2}
              onChange={(e) =>
                onChange({
                  bullets: entry.bullets.map((v, i) => (i === bulletIndex ? e.target.value : v)),
                })
              }
              placeholder="做了什么 + 带来什么结果（尽量有数字）"
              className={`${INPUT} resize-y leading-relaxed`}
            />
            <button
              type="button"
              className={GHOST_BTN}
              onClick={() =>
                onChange({ bullets: entry.bullets.filter((_, i) => i !== bulletIndex) })
              }
            >
              删除
            </button>
          </div>
        ))}
        <button
          type="button"
          className={ADD_BTN}
          onClick={() => onChange({ bullets: [...entry.bullets, ''] })}
        >
          + 添加一条
        </button>
      </div>
    </div>
  );
}

function EntriesForm({
  section,
  onContentChange,
}: {
  section: ResumeSection;
  onContentChange: (contentMd: string) => void;
}): React.JSX.Element {
  const labels = entryLabels(section.key);
  const [data, setData] = useState<EntriesSectionData>(() => {
    const parsed = parseEntriesSection(section.contentMd);
    return parsed.entries.length > 0
      ? parsed
      : { ...parsed, entries: [createEmptyEntry()] };
  });

  const apply = (next: EntriesSectionData): void => {
    setData(next);
    onContentChange(serializeEntriesSection(next));
  };

  return (
    <div className="space-y-3">
      {data.lead.trim() && (
        <div>
          <label className={FIELD_LABEL}>模块开头说明</label>
          <textarea
            value={data.lead}
            rows={2}
            onChange={(e) => apply({ ...data, lead: e.target.value })}
            className={`${INPUT} resize-y leading-relaxed`}
          />
        </div>
      )}

      {data.entries.map((entry, index) => (
        <EntryCard
          key={index}
          entry={entry}
          index={index}
          total={data.entries.length}
          labels={labels}
          onChange={(patch) =>
            apply({
              ...data,
              entries: data.entries.map((e, i) => (i === index ? { ...e, ...patch } : e)),
            })
          }
          onMove={(delta) => apply({ ...data, entries: move(data.entries, index, delta) })}
          onRemove={() =>
            apply({ ...data, entries: data.entries.filter((_, i) => i !== index) })
          }
        />
      ))}

      <button
        type="button"
        className={ADD_BTN}
        onClick={() => apply({ ...data, entries: [...data.entries, createEmptyEntry()] })}
      >
        + 添加{labels.title}
      </button>
    </div>
  );
}

function TextForm({
  section,
  onContentChange,
}: {
  section: ResumeSection;
  onContentChange: (contentMd: string) => void;
}): React.JSX.Element {
  return (
    <textarea
      value={section.contentMd}
      onChange={(e) => onContentChange(e.target.value)}
      placeholder="整段文字；分条请用 - 开头"
      className={`${INPUT} min-h-[240px] resize-y leading-relaxed`}
    />
  );
}

export function ResumeSectionForm({
  section,
  onContentChange,
}: {
  section: ResumeSection;
  onContentChange: (contentMd: string) => void;
}): React.JSX.Element {
  switch (formKindForSection(section.key)) {
    case 'fields':
      return <FieldsForm section={section} onContentChange={onContentChange} />;
    case 'bullets':
      return <BulletsForm section={section} onContentChange={onContentChange} />;
    case 'entries':
      return <EntriesForm section={section} onContentChange={onContentChange} />;
    default:
      return <TextForm section={section} onContentChange={onContentChange} />;
  }
}
