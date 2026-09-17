/**
 * 符号引擎：常驻 Parser 的复用边界。
 *
 * 引擎改成进程级常驻之后，风险不再是「慢」而是「串味」——同一个 Parser 连续换 grammar 时，
 * 上一门语言的语法不能影响下一次解析；万一脏了也得能自己恢复，而不是一路错到进程重启。
 * 这里把这几条钉住。
 */
import { describe, expect, it } from 'vitest';
import { extractSymbolsAst, grammarForExt } from './treeSitter';

describe('常驻 Parser 的复用边界', () => {
  it('同一实例连续解析不同语言，结果互不串味', async () => {
    const ts = await extractSymbolsAst('class A {}\nfunction b() {}\n', '.ts');
    const py = await extractSymbolsAst('class C:\n    def d(self):\n        pass\n', '.py');
    const tsAgain = await extractSymbolsAst('function e() {}\n', '.ts');

    expect(ts?.symbols.map((symbol) => [symbol.name, symbol.kind])).toEqual([
      ['A', 'class'],
      ['b', 'fn'],
    ]);
    expect(py?.symbols.map((symbol) => symbol.name)).toEqual(expect.arrayContaining(['C']));
    expect(tsAgain?.symbols.map((symbol) => symbol.name)).toEqual(['e']);
  });

  it('触到条数上限时标记 truncated，不假装取全了', async () => {
    const source = Array.from({ length: 5 }, (_, index) => `function f${index}() {}`).join('\n');

    const capped = await extractSymbolsAst(source, '.ts', 1);
    expect(capped?.symbols).toHaveLength(1);
    expect(capped?.truncated).toBe(true);

    const whole = await extractSymbolsAst(source, '.ts');
    expect(whole?.symbols).toHaveLength(5);
    expect(whole?.truncated).toBe(false);
  });

  it('不认识的扩展名返回 null（交给调用方降级），不抛错', async () => {
    expect(await extractSymbolsAst('hello', '.txt')).toBeNull();
    expect(grammarForExt('.txt')).toBeNull();
    expect(grammarForExt('.ts')).toBe('typescript');
  });
});
