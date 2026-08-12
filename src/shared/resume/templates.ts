export const RESUME_PDF_TEMPLATES = ['classic', 'modern', 'compact'] as const;
export type ResumePdfTemplate = (typeof RESUME_PDF_TEMPLATES)[number];

export const RESUME_PDF_TEMPLATE_LABELS: Record<ResumePdfTemplate, string> = {
  classic: '经典单列',
  modern: '现代留白',
  compact: '紧凑一页',
};
