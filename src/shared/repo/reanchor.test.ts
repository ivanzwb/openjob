import { describe, expect, it } from 'vitest';
import { reanchorSnippet } from './reanchor';

/** 库里存的片段长这样：readFileRange 给每行加了 `行号|` */
const stored = (startLine: number, lines: string[]): string =>
  lines.map((l, i) => `${startLine + i}|${l}`).join('\n');

const FILE = [
  'import { a } from "a";', // 1
  '', // 2
  'function untouched(): void {', // 3
  '  return;', // 4
  '}', // 5
  '', // 6
  'export function target(x: number): number {', // 7
  '  const y = x * 2;', // 8
  '  return y;', // 9
  '}', // 10
].join('\n');

describe('reanchorSnippet', () => {
  /**
   * 这条是整件事的前提：snippet 带着 `41|` 前缀，
   * 不剥掉就一处都匹配不上，重新定位会静默地全部失效。
   */
  it('剥掉行号前缀后能在新位置找到代码', () => {
    const ref = {
      snippet: stored(41, ['export function target(x: number): number {', '  const y = x * 2;']),
      startLine: 41,
      endLine: 42,
    };
    expect(reanchorSnippet(FILE, ref)).toEqual({ startLine: 7, endLine: 8 });
  });

  it('代码没动就返回原位置', () => {
    const ref = {
      snippet: stored(7, ['export function target(x: number): number {']),
      startLine: 7,
      endLine: 7,
    };
    expect(reanchorSnippet(FILE, ref)).toEqual({ startLine: 7, endLine: 7 });
  });

  it('代码已被删除时返回 null，不硬凑一个位置', () => {
    const ref = { snippet: stored(3, ['function deletedLongAgo(): void {']), startLine: 3, endLine: 3 };
    expect(reanchorSnippet(FILE, ref)).toBeNull();
  });

  it('片段被 4000 字截断、尾行只有半行也能定位', () => {
    const ref = {
      snippet: stored(41, ['export function target(x: number): number {', '  const y = x *']),
      startLine: 41,
      endLine: 42,
    };
    expect(reanchorSnippet(FILE, ref)).toEqual({ startLine: 7, endLine: 8 });
  });

  it('只是重新缩进过，也能靠忽略空白找回来', () => {
    const reindented = 'function wrap() {\n    const y = 1;\n    return y;\n}';
    const ref = { snippet: stored(2, ['  const y = 1;', '  return y;']), startLine: 2, endLine: 3 };
    expect(reanchorSnippet(reindented, ref)).toEqual({ startLine: 2, endLine: 3 });
  });

  /** 严格匹配有结果时不该被宽松匹配的结果顶掉 */
  it('优先严格匹配', () => {
    const file = '  const y = 1;\nconst y = 1;';
    const ref = { snippet: stored(9, ['const y = 1;']), startLine: 9, endLine: 9 };
    expect(reanchorSnippet(file, ref)).toEqual({ startLine: 2, endLine: 2 });
  });

  it('同段代码出现多次时挑离原位置最近的那处', () => {
    const file = Array.from({ length: 30 }, (_, i) =>
      i === 4 || i === 24 ? '  return handle(req);' : `  line${i}`,
    ).join('\n');
    const near = { snippet: stored(23, ['  return handle(req);']), startLine: 23, endLine: 23 };
    expect(reanchorSnippet(file, near)?.startLine).toBe(25);
    const far = { snippet: stored(3, ['  return handle(req);']), startLine: 3, endLine: 3 };
    expect(reanchorSnippet(file, far)?.startLine).toBe(5);
  });

  /** `}` 这种到处都是，猜出来的位置比明确失效更有害 */
  it('单行且太短时拒绝定位', () => {
    expect(reanchorSnippet(FILE, { snippet: '10|}', startLine: 10, endLine: 10 })).toBeNull();
    expect(reanchorSnippet(FILE, { snippet: '2|', startLine: 2, endLine: 2 })).toBeNull();
  });

  it('跨度沿用旧的，不因片段被截断而缩短引用', () => {
    const ref = {
      snippet: stored(41, ['export function target(x: number): number {']),
      startLine: 41,
      endLine: 44,
    };
    expect(reanchorSnippet(FILE, ref)).toEqual({ startLine: 7, endLine: 10 });
  });

  it('跨度超出文件末尾时夹到最后一行', () => {
    const ref = { snippet: stored(1, ['  return y;']), startLine: 1, endLine: 80 };
    expect(reanchorSnippet(FILE, ref)).toEqual({ startLine: 9, endLine: 10 });
  });

  it('CRLF 文件与 LF 片段之间不该因换行符对不上而失配', () => {
    const crlf = 'const a = 1;\r\nconst b = 2;\r\n';
    const ref = { snippet: '5|const b = 2;', startLine: 5, endLine: 5 };
    expect(reanchorSnippet(crlf, ref)).toEqual({ startLine: 2, endLine: 2 });
  });

  it('没有片段可比时返回 null', () => {
    expect(reanchorSnippet(FILE, { snippet: '', startLine: 1, endLine: 1 })).toBeNull();
    expect(reanchorSnippet(FILE, { snippet: '\n\n', startLine: 1, endLine: 1 })).toBeNull();
  });

  it('不含行号前缀的片段同样能用', () => {
    const ref = { snippet: '  const y = x * 2;\n  return y;', startLine: 40, endLine: 41 };
    expect(reanchorSnippet(FILE, ref)).toEqual({ startLine: 8, endLine: 9 });
  });
});
