const FENCED_BLOCK = /```(\w[\w+-]*)?\n([\s\S]*?)```/g;

export type MarkdownBlock =
  | { type: 'text'; value: string; mdStart: number; mdEnd: number }
  | { type: 'mermaid'; value: string; mdStart: number; mdEnd: number }
  | { type: 'code'; value: string; lang?: string; mdStart: number; mdEnd: number };

export function parseMarkdownBlocks(text: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  const re = new RegExp(FENCED_BLOCK.source, 'g');

  while ((match = re.exec(text)) !== null) {
    if (match.index > last) {
      const value = text.slice(last, match.index);
      blocks.push({ type: 'text', value, mdStart: last, mdEnd: match.index });
    }
    const lang = match[1];
    const body = match[2] ?? '';
    const mdStart = match.index;
    const mdEnd = match.index + match[0].length;
    if (lang === 'mermaid') {
      blocks.push({ type: 'mermaid', value: body, mdStart, mdEnd });
    } else {
      blocks.push({
        type: 'code',
        value: body,
        mdStart,
        mdEnd,
        ...(lang ? { lang } : {}),
      });
    }
    last = mdEnd;
  }
  if (last < text.length) {
    blocks.push({ type: 'text', value: text.slice(last), mdStart: last, mdEnd: text.length });
  }
  if (blocks.length === 0) {
    blocks.push({ type: 'text', value: text, mdStart: 0, mdEnd: text.length });
  }
  return blocks;
}

/** 去掉开头空白块，避免角标与正文之间出现大段空行 */
export function visibleMarkdownBlocks(text: string): MarkdownBlock[] {
  const normalized = text.replace(/^\s+/, '');
  return parseMarkdownBlocks(normalized).filter((block) => {
    if (block.type === 'text') return block.value.trim().length > 0;
    return block.value.trim().length > 0;
  });
}
