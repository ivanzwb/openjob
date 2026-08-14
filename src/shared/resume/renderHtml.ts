import type { EntryHead } from './entryHead';
import { looksLikeDate, looksLikeEntryHead, parseEntryHead, stripBullet } from './entryHead';
import type { ResumeDocument, ResumeSection } from './document';
import type { ResumePreviewStyle } from './previewStyle';
import type { ResumeTemplateId } from './templates';

const TEMPLATE_ACCENT: Record<ResumeTemplateId, string> = {
  standard: '#1f4e79',
  banner: '#0f766e',
  navy: '#1b3a5c',
  grid: '#1c5c9c',
  numbered: '#d2603a',
};

/**
 * 抬头形态：
 * - centered 居中大标题
 * - band     整幅色块，联系方式并入抬头
 * - aligned  左对齐标题，联系方式仍作为「基本信息」章节
 */
const HEADER_KIND: Record<ResumeTemplateId, 'centered' | 'band' | 'aligned'> = {
  standard: 'centered',
  banner: 'band',
  navy: 'band',
  grid: 'aligned',
  numbered: 'aligned',
};

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inline(text: string): string {
  return escapeHtml(text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

function renderEntryHead(head: EntryHead): string {
  const main = [
    head.org ? `<span class="entry-org">${inline(head.org)}</span>` : '',
    head.role ? `<span class="entry-role">${inline(head.role)}</span>` : '',
  ]
    .filter(Boolean)
    .join('');
  const date = head.date ? `<span class="entry-date">${inline(head.date)}</span>` : '';
  return `<div class="entry-head"><span class="entry-main">${main}</span>${date}</div>`;
}

interface InfoField {
  label: string;
  value: string;
}

/** 两字标签排成「姓 名」，对齐参考模板的信息表观感 */
function spacedLabel(label: string): string {
  const compact = label.replace(/\s+/g, '');
  return compact.length === 2 ? `${compact[0]}\u2002${compact[1]}` : compact;
}

function parseInfoFields(md: string): InfoField[] {
  return md
    .split('\n')
    .map((line) => stripBullet(line))
    .filter(Boolean)
    .map((line) => {
      const kv = line.match(/^(.{1,14}?)\s*[：:]\s*(.+)$/);
      return kv
        ? { label: kv[1].trim(), value: kv[2].trim() }
        : { label: '', value: line };
    });
}

interface BasicInfo {
  name: string;
  tagline: string;
  taglineLabel: string;
  fields: InfoField[];
}

function extractBasicInfo(section: ResumeSection | undefined): BasicInfo | null {
  if (!section?.contentMd.trim()) return null;
  const fields = parseInfoFields(section.contentMd);
  const nameField = fields.find((f) => /姓名|名字/.test(f.label.replace(/\s+/g, '')));
  const roleField = fields.find((f) =>
    /岗位|职位|意向|应聘/.test(f.label.replace(/\s+/g, '')),
  );
  return {
    name: nameField?.value ?? '',
    tagline: roleField?.value ?? '',
    taglineLabel: roleField?.label ?? '',
    fields: fields.filter((f) => f !== nameField),
  };
}

function renderInfoItems(fields: InfoField[]): string {
  return fields
    .map((f) =>
      f.label
        ? `<div class="info-item"><span class="info-label">${inline(spacedLabel(f.label))}</span><span class="info-value">${inline(f.value)}</span></div>`
        : `<div class="info-item"><span class="info-value">${inline(f.value)}</span></div>`,
    )
    .join('');
}

function renderInfoGrid(fields: InfoField[]): string {
  if (fields.length === 0) return '';
  return `<div class="info-grid">${renderInfoItems(fields)}</div>`;
}

/** 只认内嵌图片：别的协议一律当没照片，渲染出去的 HTML 会进 PDF 和预览 iframe */
function photoSrc(photo: string | null | undefined): string | null {
  const src = photo?.trim();
  return src && /^data:image\//i.test(src) ? escapeHtml(src) : null;
}

function renderRichBody(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let listItems: string[] = [];
  let entryOpen = false;

  const flushList = (): void => {
    if (listItems.length === 0) return;
    out.push(`<ul>${listItems.join('')}</ul>`);
    listItems = [];
  };
  const closeEntry = (): void => {
    flushList();
    if (entryOpen) {
      out.push('</div>');
      entryOpen = false;
    }
  };

  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i].trim();
    if (!text) {
      flushList();
      continue;
    }

    const headText = /^#{3,}\s+/.test(text)
      ? text.replace(/^#+\s*/, '')
      : looksLikeEntryHead(text)
        ? text
        : null;

    if (headText !== null) {
      closeEntry();
      const head = parseEntryHead(headText);
      if (!head.date) {
        const next = lines[i + 1] ? stripBullet(lines[i + 1]) : '';
        if (next && looksLikeDate(next)) {
          head.date = next;
          i += 1;
        }
      }
      out.push('<div class="entry">');
      entryOpen = true;
      out.push(renderEntryHead(head));
      continue;
    }

    if (/^[-*]\s+/.test(text)) {
      listItems.push(`<li>${inline(stripBullet(text))}</li>`);
      continue;
    }

    flushList();
    const kv = text.match(/^(.{1,14}?)\s*[：:]\s*(.+)$/);
    if (kv) {
      out.push(
        `<p class="kv"><span class="kv-label">${inline(kv[1].trim())}</span>${inline(kv[2].trim())}</p>`,
      );
      continue;
    }
    out.push(`<p>${inline(text)}</p>`);
  }

  closeEntry();
  return out.join('\n');
}

function baseCss(): string {
  return `
  @page { size: A4; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #fff; }
  body {
    font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
    color: #1f2937;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  h1, h2, p, ul { margin: 0; }
  .resume-page { width: 100%; max-width: 794px; margin: 0 auto; background: #fff; }
  .resume-body { padding: 22px 48px 44px; }
  .resume-section { margin-top: 20px; page-break-inside: auto; }
  .resume-section:first-child { margin-top: 0; }
  .resume-section h2 { font-size: 14px; font-weight: 700; letter-spacing: 0.06em; }
  .entry { margin-top: 11px; page-break-inside: avoid; }
  .entry:first-of-type { margin-top: 8px; }
  .entry-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
  .entry-org { font-size: 13.5px; font-weight: 600; color: #111827; }
  .entry-role { font-size: 12.5px; color: #4b5563; margin-left: 8px; }
  .entry-date { font-size: 12px; color: #6b7280; white-space: nowrap; font-variant-numeric: tabular-nums; }
  p { font-size: 12.5px; line-height: 1.75; margin: 5px 0; color: #374151; }
  .kv-label { color: #6b7280; margin-right: 8px; }
  ul { list-style: none; padding: 0; margin: 5px 0 0; }
  li { position: relative; padding-left: 13px; margin: 3px 0; font-size: 12.5px; line-height: 1.75; color: #374151; }
  li::before {
    content: ''; position: absolute; left: 0; top: 0.68em;
    width: 4px; height: 4px; border-radius: 50%; background: var(--accent); opacity: 0.65;
  }
  .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 5px 28px; margin-top: 9px; }
  .info-item { display: flex; gap: 10px; font-size: 12.5px; line-height: 1.7; }
  .info-label { color: #6b7280; flex: 0 0 66px; }
  .info-value { color: #374151; }
  /* 寸照 35×49mm 的比例，抬头右侧固定一栏 */
  .doc-head-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; }
  .doc-head-main { flex: 1; min-width: 0; }
  .doc-photo { flex: 0 0 auto; width: 84px; height: 118px; object-fit: cover; border-radius: 2px; }
  /* 居中版式配一个等宽占位，标题才不会被照片挤偏 */
  .doc-photo-spacer { flex: 0 0 84px; }
  .banner-photo {
    flex: 0 0 auto; width: 76px; height: 106px; object-fit: cover;
    border-radius: 2px; border: 1px solid rgba(255, 255, 255, 0.55);
  }
`;
}

const TEMPLATE_CSS: Record<ResumeTemplateId, string> = {
  standard: `
  .tpl-standard .doc-head { padding: 40px 48px 0; text-align: center; }
  .tpl-standard .doc-head h1 { font-size: 27px; font-weight: 700; letter-spacing: 0.16em; color: #111827; }
  .tpl-standard .doc-sub { margin-top: 8px; font-size: 12px; letter-spacing: 0.1em; color: #6b7280; }
  .tpl-standard .doc-rule { margin-top: 16px; height: 2px; background: var(--accent); }
  .tpl-standard .resume-section h2 {
    display: flex; align-items: center; gap: 8px;
    color: var(--accent); padding-bottom: 6px; border-bottom: 1.5px solid var(--accent);
  }
  .tpl-standard .resume-section h2::before {
    content: ''; width: 10px; height: 10px; border-radius: 2px; background: var(--accent);
  }
`,
  banner: `
  .tpl-banner .banner {
    display: flex; align-items: center; justify-content: space-between; gap: 28px;
    padding: 26px 48px; background: var(--accent); color: #fff;
  }
  .tpl-banner .banner h1 { font-size: 24px; font-weight: 700; letter-spacing: 0.08em; }
  .tpl-banner .banner-role { margin-top: 7px; font-size: 12.5px; color: rgba(255, 255, 255, 0.85); }
  .tpl-banner .banner-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 22px; }
  .tpl-banner .banner-fields .info-item { font-size: 11.5px; gap: 7px; }
  .tpl-banner .banner-fields .info-label { flex: 0 0 auto; color: rgba(255, 255, 255, 0.7); }
  .tpl-banner .banner-fields .info-value { color: rgba(255, 255, 255, 0.95); }
  .tpl-banner .resume-body { padding-top: 26px; }
  .tpl-banner .resume-section h2 {
    color: #111827; font-size: 13.5px; padding: 6px 11px;
    background: #f1f5f9; border-left: 4px solid var(--accent); border-radius: 0 3px 3px 0;
  }
`,
  navy: `
  .tpl-navy .banner {
    display: flex; align-items: center; justify-content: space-between; gap: 28px;
    padding: 30px 48px; background: var(--accent); color: #fff;
  }
  .tpl-navy .banner h1 { font-size: 25px; font-weight: 700; letter-spacing: 0.12em; }
  .tpl-navy .banner-role { margin-top: 9px; font-size: 12.5px; color: rgba(255, 255, 255, 0.85); }
  .tpl-navy .banner-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 26px; }
  .tpl-navy .banner-fields .info-item { font-size: 11.5px; gap: 7px; }
  .tpl-navy .banner-fields .info-label { flex: 0 0 auto; color: rgba(255, 255, 255, 0.72); }
  .tpl-navy .banner-fields .info-value { color: #fff; }
  .tpl-navy .band-rule {
    height: 6px; background: linear-gradient(to right, #d8dde4 0 46%, var(--accent) 46% 100%);
  }
  .tpl-navy .resume-body { padding-top: 24px; }
  .tpl-navy .resume-section h2 { background: #eef1f4; }
  .tpl-navy .resume-section h2 span {
    display: inline-block; padding: 5px 18px; background: var(--accent); color: #fff; font-size: 13px;
  }
`,
  grid: `
  .tpl-grid .doc-head { padding: 34px 48px 0; }
  .tpl-grid .doc-head h1 { font-size: 23px; font-weight: 700; letter-spacing: 0.1em; color: #111827; }
  .tpl-grid .doc-sub { margin-top: 7px; font-size: 12px; color: #6b7280; }
  .tpl-grid .doc-rule { margin-top: 14px; height: 3px; background: var(--accent); }
  .tpl-grid .resume-section h2 {
    display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--accent);
    padding: 5px 12px; background: #eaf1f8; border-bottom: 2px solid var(--accent);
  }
  .tpl-grid .resume-section h2::before {
    content: ''; width: 8px; height: 8px; border-radius: 1px; background: var(--accent);
  }
  .tpl-grid .info-grid { grid-template-columns: repeat(3, 1fr); gap: 5px 18px; }
  .tpl-grid .info-label { flex: 0 0 50px; }
  .tpl-grid .resume-section { margin-top: 16px; }
`,
  numbered: `
  .tpl-numbered .doc-head { padding: 36px 48px 0; }
  .tpl-numbered .doc-head h1 { font-size: 25px; font-weight: 700; letter-spacing: 0.1em; color: var(--accent); }
  .tpl-numbered .doc-sub { margin-top: 7px; font-size: 12px; color: #6b7280; letter-spacing: 0.06em; }
  .tpl-numbered .doc-rule { display: none; }
  .tpl-numbered .resume-body { counter-reset: resume-section; padding-top: 26px; }
  .tpl-numbered .resume-section { counter-increment: resume-section; }
  .tpl-numbered .resume-section h2 { display: flex; align-items: center; gap: 10px; color: #111827; font-size: 13.5px; }
  .tpl-numbered .resume-section h2::before {
    content: counter(resume-section);
    display: flex; align-items: center; justify-content: center;
    flex: 0 0 18px; height: 18px; border-radius: 50%;
    background: var(--accent); color: #fff; font-size: 11px; font-weight: 600;
  }
  .tpl-numbered .resume-section h2::after { content: ''; flex: 1; height: 1px; background: #e5e7eb; }
`,
};

/** 时间 / 机构 / 岗位 三列对齐的经历行 */
const THREE_COLUMN_ENTRY_TEMPLATES: ResumeTemplateId[] = ['navy', 'grid', 'numbered'];

function threeColumnEntryCss(template: ResumeTemplateId): string {
  if (!THREE_COLUMN_ENTRY_TEMPLATES.includes(template)) return '';
  return `
  .entry-head { display: grid; grid-template-columns: 124px 1fr; gap: 0 12px; }
  .entry-main { display: grid; grid-template-columns: 1fr 1fr; gap: 0 12px; align-items: baseline; }
  .entry-date { order: -1; }
  .entry-role { margin-left: 0; }
`;
}

function renderSections(
  sections: ResumeSection[],
  options: { skipBasic: boolean; basicFields: InfoField[] },
): string {
  return sections
    .map((section) => {
      if (options.skipBasic && section.key === 'basic') return '';
      const body =
        section.key === 'basic'
          ? renderInfoGrid(options.basicFields)
          : renderRichBody(section.contentMd);
      if (!body.trim()) return '';
      return `<section class="resume-section"><h2><span>${inline(section.title)}</span></h2>${body}</section>`;
    })
    .filter(Boolean)
    .join('\n');
}

export function buildResumeDocumentHtml(
  doc: ResumeDocument,
  style: ResumePreviewStyle,
  meta?: {
    headline?: string;
    subtitle?: string;
    /** 寸照 data URL，只在抬头出现 */
    photo?: string | null;
    /** 手机 WebView 预览用：按纸张宽度布局再整体缩放到屏幕宽 */
    viewportWidth?: number;
  },
): string {
  const template = style.template;
  const basic = extractBasicInfo(doc.sections.find((s) => s.key === 'basic'));
  const name = basic?.name || meta?.headline?.trim() || '个人简历';
  const tagline = basic?.tagline || meta?.subtitle?.trim() || '';

  // 姓名与求职岗位已进入头部，信息表里不再重复
  const infoFields = (basic?.fields ?? []).filter(
    (f) => !basic?.taglineLabel || f.label !== basic.taglineLabel,
  );

  const headerKind = HEADER_KIND[template];
  const photo = photoSrc(meta?.photo);
  const header =
    headerKind === 'band'
      ? `
    <header class="banner">
      <div class="banner-id">
        <h1>${inline(name)}</h1>
        ${tagline ? `<p class="banner-role">${inline(tagline)}</p>` : ''}
      </div>
      <div class="banner-fields">${renderInfoItems(infoFields)}</div>
      ${photo ? `<img class="banner-photo" src="${photo}" alt="" />` : ''}
    </header>
    ${template === 'navy' ? '<div class="band-rule"></div>' : ''}`
      : `
    <header class="doc-head">
      <div class="doc-head-row">
        ${photo && headerKind === 'centered' ? '<span class="doc-photo-spacer"></span>' : ''}
        <div class="doc-head-main">
          <h1>${inline(name)}</h1>
          ${tagline ? `<p class="doc-sub">${inline(tagline)}</p>` : ''}
        </div>
        ${photo ? `<img class="doc-photo" src="${photo}" alt="" />` : ''}
      </div>
      <div class="doc-rule"></div>
    </header>`;

  const sectionsHtml = renderSections(doc.sections, {
    skipBasic: headerKind === 'band',
    basicFields: infoFields,
  });

  const viewport = meta?.viewportWidth
    ? `\n  <meta name="viewport" content="width=${meta.viewportWidth}" />`
    : '';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />${viewport}
  <style>
    :root { --accent: ${TEMPLATE_ACCENT[template]}; }
    ${baseCss()}
    ${TEMPLATE_CSS[template]}
    ${threeColumnEntryCss(template)}
  </style>
</head>
<body>
  <div class="resume-page tpl-${template}">${header}
    <div class="resume-body">${sectionsHtml}</div>
  </div>
</body>
</html>`;
}
