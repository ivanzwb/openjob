/**
 * 讲解 prompt 的档位骨架与规则完整性。
 *
 * 讲解 prompt 经历过一次模板事故的前车之鉴（结构文本散在各处、档位只有一句话
 * 差异），这里把每一档的骨架锚点、必带规则钉死，谁把段落删了这里会红。
 */
import { describe, expect, it } from 'vitest';
import { quizAnchorBlock } from '../explain/prompt';
import { buildExplainFallbackSystem, buildExplainGenerateSystem } from './explain';

describe('explain 档位骨架', () => {
  it('oneliner 只有两节，不给长文骨架', () => {
    const s = buildExplainGenerateSystem('oneliner');
    expect(s).toContain('一句话本质');
    expect(s).toContain('一句口语稿');
    expect(s).not.toContain('口语化答案框架');
  });

  it('spoken 保留核心段落，给篇幅锚点与口语示范', () => {
    const s = buildExplainGenerateSystem('spoken');
    expect(s).toContain('## 面试真实问法');
    expect(s).toContain('## 口语化答案框架');
    expect(s).toContain('## 实例 / 类比 / 代码');
    expect(s).toContain('口语示范');
    expect(s).toContain('约 500 字');
  });

  it('deep 加深到原理/取舍/再挖一层', () => {
    const s = buildExplainGenerateSystem('deep');
    expect(s).toContain('原理与实现');
    expect(s).toContain('取舍与边界');
    expect(s).toContain('再深挖一层');
    expect(s).toContain('常见错误与陷阱');
  });

  it('三档都带简历对齐与写作要求（追问衔接 + 自检）', () => {
    for (const tier of ['oneliner', 'spoken', 'deep'] as const) {
      const s = buildExplainGenerateSystem(tier);
      expect(s).toContain('简历对齐要求');
      expect(s).toContain('要能接住一次追问');
      expect(s).toContain('写完自查');
    }
  });

  it('fallback 自带对齐要求（原靠用户侧重复携带，去重后补回）', () => {
    expect(buildExplainFallbackSystem()).toContain('简历对齐要求');
  });

  it('用户临时要求放在结构与规则之后', () => {
    const s = buildExplainGenerateSystem('spoken', '多举例子');
    expect(s.indexOf('多举例子')).toBeGreaterThan(s.indexOf('档位要求'));
    expect(s.indexOf('多举例子')).toBeGreaterThan(s.indexOf('写作要求'));
  });
});

describe('quizAnchorBlock', () => {
  it('没有考我题时不输出锚点', () => {
    expect(quizAnchorBlock(null)).toBe('');
    expect(quizAnchorBlock(undefined)).toBe('');
    expect(quizAnchorBlock('   ')).toBe('');
  });

  it('有考我题时给出对齐提示', () => {
    const b = quizAnchorBlock('请讲讲 RAG 的检索流程');
    expect(b).toContain('已有考法：请讲讲 RAG 的检索流程');
    expect(b).toContain('面试真实问法');
  });
});
