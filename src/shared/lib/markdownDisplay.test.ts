import { describe, expect, it } from 'vitest';
import { normalizeDisplayText } from './markdownDisplay';

describe('normalizeDisplayText', () => {
  it('把整段用字面量 \\n 当换行的文本还原成换行', () => {
    expect(normalizeDisplayText('第一行\\n第二行\\n第三行')).toBe('第一行\n第二行\n第三行');
  });

  it('统一 CRLF', () => {
    expect(normalizeDisplayText('a\r\nb')).toBe('a\nb');
  });

  it('保留代码围栏里的字面量 \\n', () => {
    const input = ['正文\\n还有一行', '```java', 'System.out.println("a\\nb");', '```'].join('\n');
    const output = normalizeDisplayText(input);
    expect(output).toContain('正文\n还有一行');
    expect(output).toContain('System.out.println("a\\nb");');
  });

  it('围栏结束后继续还原', () => {
    const input = ['```', 'keep\\nthis', '```', 'fix\\nthis'].join('\n');
    const output = normalizeDisplayText(input);
    expect(output).toContain('keep\\nthis');
    expect(output).toContain('fix\nthis');
  });

  it('没有字面量 \\n 时原样返回', () => {
    expect(normalizeDisplayText('| a | b |\n| --- | --- |')).toBe('| a | b |\n| --- | --- |');
  });
});
