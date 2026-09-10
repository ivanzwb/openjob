export const RESUME_TEMPLATES = ['standard', 'banner', 'navy', 'grid', 'numbered'] as const;
export type ResumeTemplateId = (typeof RESUME_TEMPLATES)[number];

export const RESUME_TEMPLATE_META: Record<
  ResumeTemplateId,
  { label: string; hint: string }
> = {
  standard: {
    label: '标准型',
    hint: '居中姓名标题，基本信息两列对照，章节标题带下划线',
  },
  banner: {
    label: '信息条型',
    hint: '顶部色块内嵌姓名与联系方式，章节标题为色块标签',
  },
  navy: {
    label: '深蓝抬头型',
    hint: '深色抬头 + 反白章节标题，经历三列对齐',
  },
  grid: {
    label: '分区表格型',
    hint: '基本信息三列铺排，浅色分区条，信息密度高',
  },
  numbered: {
    label: '编号章节型',
    hint: '章节带序号圆标与延伸细线，暖色点缀',
  },
};
