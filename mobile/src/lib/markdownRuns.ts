import { parseMarkdownLine } from '@shared/lib/markdownSegments';

/**
 * 把一段里的行分成「能合进同一个 Text 的连续块」。
 *
 * RN 的选取手势归单个 Text 节点所有，兄弟 Text 之间拖不过去。所以能选多少字
 * 完全取决于渲染时把多少行放进了同一个 Text——一行一个 Text 时长按只能选中
 * 一行，想复制一整段回答得一行行来。
 *
 * 引用行是唯一的例外：左边那道竖线是 borderLeft，在嵌套 Text 上不生效，只能
 * 自己单独成一个 Text，选取会在它前后断开。
 */
export type ParagraphRun = { kind: 'lines'; lines: string[] } | { kind: 'quote'; line: string };

export function groupParagraphRuns(lines: string[]): ParagraphRun[] {
  const runs: ParagraphRun[] = [];
  for (const line of lines) {
    if (parseMarkdownLine(line).kind === 'quote') {
      runs.push({ kind: 'quote', line });
      continue;
    }
    const last = runs[runs.length - 1];
    if (last?.kind === 'lines') last.lines.push(line);
    else runs.push({ kind: 'lines', lines: [line] });
  }
  return runs;
}
