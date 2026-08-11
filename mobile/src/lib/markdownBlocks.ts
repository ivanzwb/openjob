const FENCED_BLOCK = /```(\w[\w+-]*)?\n([\s\S]*?)```/g;

export type MarkdownBlock =
  | { type: 'text'; value: string }
  | { type: 'mermaid'; value: string }
  | { type: 'code'; value: string; lang?: string };

function parseMarkdownBlocks(text: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  const re = new RegExp(FENCED_BLOCK.source, 'g');

  while ((match = re.exec(text)) !== null) {
    if (match.index > last) {
      blocks.push({ type: 'text', value: text.slice(last, match.index) });
    }
    const lang = match[1];
    const body = match[2] ?? '';
    if (lang === 'mermaid') {
      blocks.push({ type: 'mermaid', value: body });
    } else {
      blocks.push({
        type: 'code',
        value: body,
        ...(lang ? { lang } : {}),
      });
    }
    last = match.index + match[0].length;
  }
  if (last < text.length) {
    blocks.push({ type: 'text', value: text.slice(last) });
  }
  if (blocks.length === 0) {
    blocks.push({ type: 'text', value: text });
  }
  return blocks;
}

/** 去掉开头空白块，避免角标与正文之间出现大段空行 */
export function visibleMarkdownBlocks(text: string): MarkdownBlock[] {
  const normalized = text.replace(/^\s+/, '');
  return parseMarkdownBlocks(normalized).filter((block) => block.value.trim().length > 0);
}

export function markdownToPlainText(text: string): string {
  return visibleMarkdownBlocks(text)
    .map((block) => {
      if (block.type === 'text') return block.value;
      if (block.type === 'mermaid') return `[流程图]\n${block.value.trim()}`;
      const lang = block.lang ? `${block.lang}\n` : '';
      return `\`\`\`${lang}${block.value}\`\`\``;
    })
    .join('\n\n')
    .trim();
}
