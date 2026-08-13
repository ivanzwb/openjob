import type { ResumeDocument } from '@shared/resume/document';
import { catalogHintForKey } from '@shared/resume/document';
import { ResumeSectionForm } from './ResumeSectionForm';

/**
 * 母版与优化版共用的简历编辑器：左侧模块导航 + 右侧结构化表单。
 * 模块是固定的一套、顺序固定，没填的模块留空即可，不会出现在预览和导出里。
 * 排版模板只影响预览与导出，在预览弹窗里选，这里专注填内容。
 */
export function ResumeDocumentEditor({
  document,
  activeSectionIndex,
  onDocumentChange,
  onActiveSectionChange,
  documentKey,
}: {
  document: ResumeDocument;
  activeSectionIndex: number;
  onDocumentChange: (doc: ResumeDocument) => void;
  onActiveSectionChange: (index: number) => void;
  /** 切换简历时用它强制重建表单，避免沿用上一份的本地草稿 */
  documentKey?: string;
}): React.JSX.Element {
  const activeSection = document.sections[activeSectionIndex] ?? null;

  const updateContent = (contentMd: string): void => {
    onDocumentChange({
      sections: document.sections.map((s, i) =>
        i === activeSectionIndex ? { ...s, contentMd } : s,
      ),
    });
  };

  return (
    <div className="flex min-h-0 flex-1">
      <nav className="flex w-40 shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface)]/30">
        <div className="border-b border-[var(--color-border)] px-3 py-2 text-xs font-medium text-[var(--color-muted)]">
          简历模块
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2 space-y-1">
          {document.sections.map((section, index) => {
            const active = index === activeSectionIndex;
            const filled = Boolean(section.contentMd.trim());
            return (
              <button
                key={section.key}
                type="button"
                onClick={() => onActiveSectionChange(index)}
                className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                  active
                    ? 'bg-[var(--color-surface)] font-medium text-[var(--color-accent)]'
                    : 'text-[var(--color-muted)] hover:bg-[var(--color-surface)]/80 hover:text-[var(--color-fg)]'
                }`}
              >
                <span
                  aria-hidden
                  title={filled ? '已填写' : '未填写'}
                  className={`size-1.5 shrink-0 rounded-full ${
                    filled ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-border)]'
                  }`}
                />
                <span className="min-w-0 flex-1 truncate">{section.title}</span>
              </button>
            );
          })}
        </div>
      </nav>

      {activeSection && (
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-5 py-4">
          <h4 className="text-sm font-medium">{activeSection.title}</h4>
          <p className="mb-3 mt-1 text-xs text-[var(--color-muted)]">
            {catalogHintForKey(activeSection.key)}（选填，留空则不出现在简历里）
          </p>
          <ResumeSectionForm
            key={`${documentKey ?? ''}-${activeSection.key}`}
            section={activeSection}
            onContentChange={updateContent}
          />
        </div>
      )}
    </div>
  );
}
