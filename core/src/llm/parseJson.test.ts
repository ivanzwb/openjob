/**
 * 守 LLM JSON 解析的容错边界。
 *
 * 这层是所有结构化输出的唯一入口，两端共用。它要在「尽量救回来」和「别把坏数据
 * 悄悄当成好数据」之间站住：围栏、脏引号、尾逗号该修，但截断补全只在明确开启时
 * 才做——评分那种单对象长文本丢的是稿子尾巴，看得见；返回数组的响应一旦被悄悄
 * 补全，用户会以为诊断跑完了，实际少了一半考点。
 */
import { describe, expect, it } from 'vitest';
import { SALVAGE_TRUNCATED_PROMPTS, looksTruncated, parseJsonResponse } from './parseJson';

describe('正常解析与既有修补', () => {
  it('干净 JSON 直接过', () => {
    expect(parseJsonResponse('{"score":4}')).toEqual({ score: 4 });
  });

  it('markdown 围栏剥掉再解析', () => {
    expect(parseJsonResponse('```json\n{"score":4}\n```')).toEqual({ score: 4 });
  });

  it('JSON 前后带解释文字时截出对象', () => {
    expect(parseJsonResponse('这是结果：\n{"score":4}\n以上。')).toEqual({ score: 4 });
  });

  it('字符串里的裸换行补成 \\n', () => {
    const parsed = parseJsonResponse<{ feedbackMd: string }>('{"feedbackMd":"第一行\n第二行"}');
    expect(parsed.feedbackMd).toBe('第一行\n第二行');
  });

  it('尾逗号去掉', () => {
    expect(parseJsonResponse('{"score":4,}')).toEqual({ score: 4 });
  });
});

describe('截断识别', () => {
  it('容器没闭合就是被截断', () => {
    expect(looksTruncated('{"score":4,"feedbackMd":"写到一半')).toBe(true);
  });

  it('完整输出不算截断', () => {
    expect(looksTruncated('{"score":4}')).toBe(false);
    expect(looksTruncated('```json\n{"score":4}\n```')).toBe(false);
  });

  it('格式脏但结构完整的不算截断——这两种的处置不一样', () => {
    expect(looksTruncated('{"feedbackMd":"他说"很快"就好了"}')).toBe(false);
  });
});

describe('不开抢救时截断必须报错', () => {
  it('半截 JSON 抛错，且说清是被截断而不是格式问题', () => {
    expect(() => parseJsonResponse('{"score":4,"feedbackMd":"写到一半')).toThrow('模型输出被截断');
  });

  it('截断的数组不会被悄悄补全成短数组', () => {
    // JD 诊断这类响应走的就是这条路：宁可报错重来，也不能少给考点还不吭声
    expect(() => parseJsonResponse('{"nodes":[{"name":"TCP"},{"name":"TL')).toThrow(
      '模型输出被截断',
    );
  });
});

describe('开启抢救后补全截断输出', () => {
  const salvage = { salvageTruncated: true };

  it('截在字符串中间：补收口，已写完的字段全部保留', () => {
    const parsed = parseJsonResponse<{ score: number; feedbackMd: string; improvedScriptMd: string }>(
      '{"score":4,"feedbackMd":"结构清晰","improvedScriptMd":"我会从三个层面讲',
      salvage,
    );
    expect(parsed.score).toBe(4);
    expect(parsed.feedbackMd).toBe('结构清晰');
    expect(parsed.improvedScriptMd).toBe('我会从三个层面讲');
  });

  it('截在冒号后面：丢掉那个只写了一半的字段，前面的留下', () => {
    const parsed = parseJsonResponse<{ score: number; feedbackMd: string }>(
      '{"score":4,"feedbackMd":"结构清晰","improvedScriptMd":',
      salvage,
    );
    expect(parsed).toEqual({ score: 4, feedbackMd: '结构清晰' });
  });

  it('截在键名中间：整个残缺成员丢掉', () => {
    const parsed = parseJsonResponse<{ score: number }>('{"score":4,"improvedScri', salvage);
    expect(parsed).toEqual({ score: 4 });
  });

  it('截在尾逗号后面', () => {
    expect(parseJsonResponse('{"score":4,', salvage)).toEqual({ score: 4 });
  });

  it('截断处正好是个转义符', () => {
    const parsed = parseJsonResponse<{ feedbackMd: string }>('{"feedbackMd":"换行\\', salvage);
    expect(parsed.feedbackMd).toBe('换行');
  });

  it('嵌套容器逐层收口', () => {
    const parsed = parseJsonResponse<{ score: number; detail: { a: string } }>(
      '{"score":4,"detail":{"a":"半句',
      salvage,
    );
    expect(parsed).toEqual({ score: 4, detail: { a: '半句' } });
  });

  it('带围栏的半截输出也能救', () => {
    const parsed = parseJsonResponse<{ score: number }>('```json\n{"score":4,"feedbackMd":"半', salvage);
    expect(parsed.score).toBe(4);
  });

  it('完整输出开着抢救也不受影响，原样解析', () => {
    expect(parseJsonResponse('{"score":4,"feedbackMd":"完整"}', salvage)).toEqual({
      score: 4,
      feedbackMd: '完整',
    });
  });

  it('救不回来的照样报错，不返回空对象糊弄', () => {
    expect(() => parseJsonResponse('完全不是 JSON 的一段话', salvage)).toThrow('JSON 解析失败');
  });
});

describe('抢救名单', () => {
  it('只包含单对象长文本的评分类 prompt', () => {
    // 往这个名单里加返回数组的 prompt 前，先想清楚少给数据用户能不能发现
    expect([...SALVAGE_TRUNCATED_PROMPTS].sort()).toEqual(['design.score', 'quiz.score']);
  });
});
