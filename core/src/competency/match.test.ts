/**
 * 能力对账的用例。
 *
 * 这一步决定覆盖类型和证据归属，所以两类错都要盯：漏判会让 JD 明写的要求变成
 * 「无人认领」，误判会让一段和能力无关的经历替它背书，进而把证据风险压下去。
 */
import { describe, expect, it } from 'vitest';
import { competencySignature, matchAgainstCompetency, textSignature } from './match';

const SYSTEM_DESIGN = competencySignature({
  name: '系统设计与架构',
  description: '在规模、可靠性、一致性、延迟和成本约束下设计系统',
});

describe('textSignature', () => {
  it('先整词删套话，避免切出跨词残片', () => {
    const signature = textSignature('熟悉良好的沟通能力');
    expect(signature.has('通能')).toBe(false);
    expect(signature.has('好的')).toBe(false);
  });

  it('英文按词切，单字母噪声不入签名', () => {
    const signature = textSignature('Go / Kubernetes a b');
    expect(signature.has('go')).toBe(true);
    expect(signature.has('kubernetes')).toBe(true);
    expect(signature.has('a')).toBe(false);
  });
});

describe('matchAgainstCompetency', () => {
  it('命中能力名称即算相关', () => {
    const result = matchAgainstCompetency(SYSTEM_DESIGN, '熟悉分布式系统设计与高并发架构');
    expect(result.matched).toBe(true);
    expect(result.relevance).toBeGreaterThan(0.5);
  });

  it('只擦到描述里的一个词不算相关', () => {
    // 「成本」在几乎任何岗位的材料里都会出现，一个词就放行等于没有判定
    const result = matchAgainstCompetency(SYSTEM_DESIGN, '负责控制投放成本');
    expect(result.matched).toBe(false);
    expect(result.relevance).toBe(0);
  });

  it('描述里凑够两个词才算相关', () => {
    const result = matchAgainstCompetency(SYSTEM_DESIGN, '优化延迟并提升可靠性');
    expect(result.matched).toBe(true);
  });

  it('完全无关的文本不产生命中', () => {
    const result = matchAgainstCompetency(SYSTEM_DESIGN, '组织用户访谈并输出调研报告');
    expect(result.matched).toBe(false);
    expect(result.hits).toEqual([]);
  });

  it('命中越多相关度越高，但不超过 1', () => {
    const few = matchAgainstCompetency(SYSTEM_DESIGN, '优化延迟并提升可靠性');
    const many = matchAgainstCompetency(
      SYSTEM_DESIGN,
      '主导系统设计与架构演进，在延迟、一致性和成本之间做规模取舍',
    );
    expect(many.relevance).toBeGreaterThan(few.relevance);
    expect(many.relevance).toBeLessThan(1);
  });

  it('名称里出现过的词不在描述里再计一次分', () => {
    const signature = competencySignature({ name: '用户洞察', description: '用户洞察与访谈' });
    expect(signature.description.has('用户')).toBe(false);
  });
});
