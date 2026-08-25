import { useRef } from 'react';
import type { CompanyIntel } from '@shared/entities';
import { normalizeDisplayText } from '@shared/lib/markdownDisplay';
import { AnnotationTools } from './AnnotationTools';
import { MarkdownContent } from './MarkdownContent';

export function CompanyIntelCard({
  intel,
  onAnnotationChange,
}: {
  intel: CompanyIntel;
  onAnnotationChange?: () => void;
}): React.JSX.Element {
  const bodyRef = useRef<HTMLDivElement>(null);

  const sections = [
    { title: '技术栈', content: intel.techStackMd },
    { title: '面试流程', content: intel.interviewProcessMd },
    { title: '高频考点', content: intel.hotTopicsMd },
    { title: '反问素材', content: intel.talkingPointsMd },
  ].filter((s) => s.content.trim());

  if (sections.length === 0) {
    return <p className="text-sm text-[var(--color-muted)]">情报卡为空，点击「生成情报」联网检索。</p>;
  }

  return (
    <div className="space-y-4">
      <div ref={bodyRef} className="space-y-4">
        {sections.map((s) => (
          <div key={s.title}>
            <h4 className="mb-1 text-xs font-medium text-[var(--color-muted)]">{s.title}</h4>
            <div className="text-sm leading-relaxed">
              <MarkdownContent text={normalizeDisplayText(s.content)} />
            </div>
          </div>
        ))}
      </div>

      {/* 反问素材这类内容最值得划出来单独存，面试当天直接翻标记就行 */}
      <div className="border-t border-[var(--color-border)] pt-2">
        <AnnotationTools
          targetType="intel"
          targetId={intel.id}
          scopeRef={bodyRef}
          notePlaceholder="记下想追问的点 / 自己的对应经历"
          onChange={onAnnotationChange}
        />
      </div>
    </div>
  );
}
