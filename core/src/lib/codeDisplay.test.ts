import { describe, expect, it } from 'vitest';
import { compactArtificialBlankLines } from './codeDisplay';

describe('compactArtificialBlankLines', () => {
  it('压掉模型在几乎每行代码之间插入的空行', () => {
    const noisy = ['function run() {', '', '  try {', '', '    step();', '', '  }', '', '}'].join(
      '\n',
    );
    expect(compactArtificialBlankLines(noisy)).toBe(
      ['function run() {', '  try {', '    step();', '  }', '}'].join('\n'),
    );
  });

  it('保留源码正常的逻辑分段', () => {
    const source = [
      'function run() {',
      '  prepare();',
      '',
      '  execute();',
      '  finish();',
      '}',
    ].join('\n');
    expect(compactArtificialBlankLines(source)).toBe(source);
  });

  it('短片段证据不足时不自作主张', () => {
    const short = 'const a = 1;\n\nconst b = 2;';
    expect(compactArtificialBlankLines(short)).toBe(short);
  });

  it('真正的连续空行不会被误删', () => {
    const source = ['a();', '', '', 'b();', '', '', 'c();', '', '', 'd();'].join('\n');
    expect(compactArtificialBlankLines(source)).toBe(source);
  });
});
