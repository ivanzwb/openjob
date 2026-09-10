import type { ResumeTemplateId } from './templates';
import { RESUME_TEMPLATES } from './templates';

export interface ResumePreviewStyle {
  template: ResumeTemplateId;
}

export const DEFAULT_RESUME_PREVIEW_STYLE: ResumePreviewStyle = {
  template: 'standard',
};

/** 早期版本把「版式 + 主题色」存进 preview_style，这里把旧值折叠到现有模板上。 */
const LEGACY_TEMPLATE_MAP: Record<string, ResumeTemplateId> = {
  classic: 'standard',
  compact: 'standard',
  modern: 'banner',
};

function normalizeTemplate(value: unknown): ResumeTemplateId {
  if (typeof value !== 'string') return DEFAULT_RESUME_PREVIEW_STYLE.template;
  if ((RESUME_TEMPLATES as readonly string[]).includes(value)) {
    return value as ResumeTemplateId;
  }
  return LEGACY_TEMPLATE_MAP[value] ?? DEFAULT_RESUME_PREVIEW_STYLE.template;
}

export function parsePreviewStyle(raw: string | null | undefined): ResumePreviewStyle {
  if (!raw?.trim()) return { ...DEFAULT_RESUME_PREVIEW_STYLE };
  try {
    const parsed = JSON.parse(raw) as { template?: unknown };
    return { template: normalizeTemplate(parsed.template) };
  } catch {
    return { ...DEFAULT_RESUME_PREVIEW_STYLE };
  }
}

export function serializePreviewStyle(style: ResumePreviewStyle): string {
  return JSON.stringify(style);
}
