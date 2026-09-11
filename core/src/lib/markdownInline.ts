/**
 * 行内 markdown 切分。桌面渲染 React 节点、手机端渲染 RN 文本与 WebView HTML，
 * 三处对「哪段是加粗、哪段是代码」的判断必须一致，所以只留这一份词法。
 *
 * 每个 token 都带上 text 在源串里的起始下标：桌面的划词标注把 DOM 偏移加上
 * data-md-start 还原成 contentMd 偏移，手机 WebView 也要 visibleToMd 映射。
 * token.text 与源串对应片段逐字相同（只有 ** ` [] () 这些标记被吃掉），
 * 有了 start 就能把可见字符一一映射回原文，标注不会因为渲染而错位。
 */

export type InlineTokenKind = 'text' | 'bold' | 'italic' | 'code' | 'link';

export interface InlineToken {
  kind: InlineTokenKind;
  /** 可见文本，与源串中对应片段逐字相同 */
  text: string;
  /** text 在源串中的起始下标（已加上 baseOffset） */
  start: number;
  /** kind 为 link 时的目标地址 */
  href?: string;
}

/**
 * 斜体只认 *text*，不认 _text_。
 *
 * snake_case 标识符在这个项目的正文里遍地都是，认 _ 会把 foo_bar_baz
 * 中间那截变成斜体；单星号至少要求两侧紧贴非空白字符，误伤面小得多。
 */
const ITALIC_OPEN = /^\*(?!\s)/;

function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i--) backslashes += 1;
  return backslashes % 2 === 1;
}

function findClosing(text: string, marker: string, from: number): number {
  let at = text.indexOf(marker, from);
  while (at !== -1 && isEscaped(text, at)) {
    at = text.indexOf(marker, at + 1);
  }
  return at;
}

export function parseInlineMarkdown(text: string, baseOffset = 0): InlineToken[] {
  const tokens: InlineToken[] = [];
  let plain = '';
  let plainStart = 0;
  let index = 0;

  const flushPlain = (): void => {
    if (!plain) return;
    tokens.push({ kind: 'text', text: plain, start: baseOffset + plainStart });
    plain = '';
  };

  const pushSpan = (kind: InlineTokenKind, inner: string, innerStart: number): void => {
    flushPlain();
    tokens.push({ kind, text: inner, start: baseOffset + innerStart });
  };

  while (index < text.length) {
    if (!plain) plainStart = index;

    if (text.startsWith('**', index) && !isEscaped(text, index)) {
      const close = findClosing(text, '**', index + 2);
      if (close > index + 2) {
        pushSpan('bold', text.slice(index + 2, close), index + 2);
        index = close + 2;
        continue;
      }
    }

    if (text.startsWith('`', index) && !isEscaped(text, index)) {
      const close = findClosing(text, '`', index + 1);
      if (close > index + 1) {
        pushSpan('code', text.slice(index + 1, close), index + 1);
        index = close + 1;
        continue;
      }
    }

    if (ITALIC_OPEN.test(text.slice(index)) && !isEscaped(text, index)) {
      const close = findClosing(text, '*', index + 1);
      // 收尾星号前必须是非空白，否则 "a * b * c" 这种算式会被吃成斜体
      if (close > index + 1 && !/\s/.test(text[close - 1]!)) {
        pushSpan('italic', text.slice(index + 1, close), index + 1);
        index = close + 1;
        continue;
      }
    }

    if (text.startsWith('[', index) && !isEscaped(text, index)) {
      const link = /^\[([^\]]*)\]\(([^)\s]*)\)/.exec(text.slice(index));
      if (link && link[1]) {
        flushPlain();
        tokens.push({
          kind: 'link',
          text: link[1],
          start: baseOffset + index + 1,
          href: link[2] ?? '',
        });
        index += link[0].length;
        continue;
      }
    }

    plain += text[index]!;
    index += 1;
  }

  flushPlain();
  return tokens.length ? tokens : [{ kind: 'text', text: '', start: baseOffset }];
}

/** 丢掉行内标记只留可见文本，供纯文本场景（列表摘要、语音稿）复用 */
export function stripInlineMarkdown(text: string): string {
  return parseInlineMarkdown(text)
    .map((token) => token.text)
    .join('');
}
