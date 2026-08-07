import type { CompanyIntel } from '@shared/entities';

export function CompanyIntelCard({ intel }: { intel: CompanyIntel }): React.JSX.Element {
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
      {sections.map((s) => (
        <div key={s.title}>
          <h4 className="mb-1 text-xs font-medium text-[var(--color-muted)]">{s.title}</h4>
          <div className="whitespace-pre-wrap text-sm leading-relaxed">{s.content}</div>
        </div>
      ))}
    </div>
  );
}
