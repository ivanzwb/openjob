export type ResumeSectionKey =
  | 'basic'
  | 'intention'
  | 'summary'
  | 'experience'
  | 'project'
  | 'education'
  | 'skills'
  | 'certificate'
  | 'other';

export interface ResumeSection {
  key: ResumeSectionKey;
  title: string;
  contentMd: string;
}

export interface ResumeDocument {
  sections: ResumeSection[];
}

export const RESUME_SECTION_CATALOG: Array<{
  key: ResumeSectionKey;
  title: string;
  hint: string;
}> = [
  {
    key: 'basic',
    title: '基本信息',
    hint: '姓名会作为简历标题，求职岗位作为副标题，其余信息按两列排版',
  },
  { key: 'intention', title: '求职意向', hint: '期望岗位、城市、薪资范围（选填）' },
  { key: 'summary', title: '个人优势', hint: '3–5 条亮点，一条一句，尽量带上量化结果' },
  { key: 'experience', title: '工作经历', hint: '按公司分条填写，时间会自动右对齐在同一行' },
  { key: 'project', title: '项目经历', hint: '按项目分条填写，写清角色、技术栈与成果' },
  { key: 'education', title: '教育经历', hint: '学校、专业与学历、起止时间' },
  { key: 'skills', title: '专业技能', hint: '按类别分条，如「前端：React、TypeScript」' },
  { key: 'certificate', title: '资格证书', hint: '证书、奖项等，一条一项' },
  { key: 'other', title: '其他', hint: '整段补充说明' },
];

const TITLE_KEY_MAP: Record<string, ResumeSectionKey> = {
  基本信息: 'basic',
  求职意向: 'intention',
  个人优势: 'summary',
  个人总结: 'summary',
  自我评价: 'summary',
  工作经历: 'experience',
  '工作/实习经历': 'experience',
  项目经历: 'project',
  项目经验: 'project',
  教育经历: 'education',
  教育背景: 'education',
  专业技能: 'skills',
  技能: 'skills',
  资格证书: 'certificate',
  证书: 'certificate',
};

export function inferSectionKey(title: string): ResumeSectionKey {
  const t = title.trim();
  if (TITLE_KEY_MAP[t]) return TITLE_KEY_MAP[t];
  if (t.includes('工作')) return 'experience';
  if (t.includes('项目')) return 'project';
  if (t.includes('教育')) return 'education';
  if (t.includes('技能')) return 'skills';
  if (t.includes('证书') || t.includes('资格')) return 'certificate';
  if (t.includes('意向')) return 'intention';
  if (t.includes('基本')) return 'basic';
  if (t.includes('优势') || t.includes('总结')) return 'summary';
  return 'other';
}

export function catalogTitleForKey(key: ResumeSectionKey): string {
  return RESUME_SECTION_CATALOG.find((c) => c.key === key)?.title ?? '其他';
}

export function catalogHintForKey(key: ResumeSectionKey): string {
  return RESUME_SECTION_CATALOG.find((c) => c.key === key)?.hint ?? '';
}

/**
 * 模块是固定的一套：解析结果始终按 RESUME_SECTION_CATALOG 的顺序补齐全部模块，
 * 没写的模块内容为空。同一模块出现多次时内容按出现顺序合并。
 */
export function parseMarkdownToDocument(md: string): ResumeDocument {
  const buckets = new Map<ResumeSectionKey, string[]>();
  const collect = (key: ResumeSectionKey, content: string): void => {
    const body = content.trim();
    if (!body) return;
    const existing = buckets.get(key);
    if (existing) existing.push(body);
    else buckets.set(key, [body]);
  };

  for (const chunk of md.trim().split(/\n(?=## )/)) {
    if (!chunk.startsWith('## ')) {
      // 没有小标题的正文（例如导入的纯文本简历）整体归到「其他」
      collect('other', chunk);
      continue;
    }
    const block = chunk.slice(3);
    const newline = block.indexOf('\n');
    const title = (newline === -1 ? block : block.slice(0, newline)).trim();
    collect(inferSectionKey(title), newline === -1 ? '' : block.slice(newline + 1));
  }

  return {
    sections: RESUME_SECTION_CATALOG.map((c) => ({
      key: c.key,
      title: c.title,
      contentMd: (buckets.get(c.key) ?? []).join('\n\n'),
    })),
  };
}

/** 空模块不落库、不出现在渲染结果里 */
export function documentToMarkdown(doc: ResumeDocument): string {
  return doc.sections
    .filter((s) => s.contentMd.trim())
    .map((s) => `## ${s.title.trim() || catalogTitleForKey(s.key)}\n\n${s.contentMd.trim()}`)
    .join('\n\n');
}

export function filledSections(doc: ResumeDocument): ResumeSection[] {
  return doc.sections.filter((s) => s.contentMd.trim());
}
