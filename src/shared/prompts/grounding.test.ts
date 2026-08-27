/**
 * 守「简历是事实源、JD 是目标要求」这条线。
 *
 * 这些断言看着琐碎，但它们守的是一个没法在代码里表达、只能靠 prompt 文字
 * 维持的约束：模型分不清简历和 JD 时会拿岗位职责给用户编经历，用户照着背
 * 上考场，被追问两句就穿帮。谁把某条规则从 prompt 里删掉，这里要红。
 */
import { describe, expect, it } from 'vitest';
import {
  ANSWER_SYSTEM_BY_TYPE,
  SCENARIO_CASE_SYSTEM,
  SELF_INTRO_ANSWER_SYSTEM,
  answerSystemForType,
  caseSystemForType,
  scoreSystemForType,
} from '../design/prompts';
import { buildCandidateContext } from './candidateContext';
import { buildNodeFollowUpSystemPrompt } from './followUp';
import { QUESTION_GROUNDING_RULE, RESUME_GROUNDING_RULE, SCORE_GROUNDING_RULE } from './grounding';
import { QUIZ_ANSWER_SYSTEM, QUIZ_QUESTION_SYSTEM, QUIZ_SCORE_SYSTEM } from './quiz';
import { resolvePrompt } from './registry';
import { buildStructuredPrompt } from './structure';

describe('buildStructuredPrompt', () => {
  it('按固定顺序输出小节，约束紧挨输出格式', () => {
    const text = buildStructuredPrompt({
      role: '你是面试官。',
      inputs: '输入说明',
      task: '出题',
      focus: '侧重原理',
      rules: ['规则一', '规则二'],
      output: '输出 JSON',
    });

    const order = ['# 角色', '# 输入', '# 任务', '# 侧重', '# 约束', '# 输出格式'].map((h) =>
      text.indexOf(h),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('省略空小节，不留下空标题', () => {
    const text = buildStructuredPrompt({ role: '角色', task: '任务', output: '输出' });

    expect(text).not.toContain('# 输入');
    expect(text).not.toContain('# 侧重');
    expect(text).not.toContain('# 约束');
  });

  it('只有空白的规则不算规则', () => {
    const text = buildStructuredPrompt({
      role: '角色',
      task: '任务',
      rules: ['  ', ''],
      output: '输出',
    });

    expect(text).not.toContain('# 约束');
  });
});

const RESUME_MD = `## 工作经历

### 老东家科技 | 后端工程师 | 2019-07 ~ 2021-03

- 维护订单系统

### 现东家网络 | 高级后端工程师 | 2021-04 ~ 至今

- 负责网关限流与熔断`;

describe('buildCandidateContext', () => {
  const base = { company: '某公司', roleTitle: '后端工程师' };

  it('有简历时带上经历块', () => {
    const text = buildCandidateContext({
      ...base,
      resumeSkills: ['Go', 'MySQL'],
      resumeRawText: RESUME_MD,
    });

    expect(text).toContain('简历技能：Go、MySQL');
    expect(text).toContain('简历经历');
    expect(text).toContain('网关限流');
  });

  it('没简历时给出明确指引，而不是只留一句「未提供」', () => {
    // 只说「未提供」的话，上下文里 JD 依然很厚，模型会拿它填「候选人做过什么」
    const text = buildCandidateContext({ ...base, jdSummary: '要求精通 Kubernetes' });

    expect(text).toContain('尚未关联简历');
    expect(text).toContain('不要虚构');
    expect(text).toContain('可换成你简历里的对应经历');
  });

  it('简历原文解析不出任何经历时，按没简历处理', () => {
    // rawText 非空但一条带时间的经历都抽不出来（纯文本简历、格式不规范）。
    // 只看 rawText 非空的话会拼出一串「（未提供）」标签，一句指引都没有。
    const text = buildCandidateContext({ ...base, resumeRawText: '我做过一些后端开发工作。' });

    expect(text).toContain('尚未关联简历');
    expect(text).not.toContain('简历技能：（未提供）');
  });

  it('JD 摘要过长时截断，不让它挤占篇幅', () => {
    const text = buildCandidateContext({ ...base, jdSummary: 'A'.repeat(5000) });

    expect(text).not.toContain('A'.repeat(1000));
  });

  it('考点信息可选，缺了不会拼出空标签', () => {
    const withNode = buildCandidateContext(base, { name: 'MVCC', coverageType: 'gap' });
    expect(withNode).toContain('考点：MVCC');
    expect(withNode).toContain('覆盖类型：gap');

    const withoutNode = buildCandidateContext(base);
    expect(withoutNode).not.toContain('考点：');
    expect(withoutNode).not.toContain('覆盖类型：');
  });
});

describe('考我三件套带上事实来源约束', () => {
  it('出题用出题版规则：可以考缺口，但不得预设经历', () => {
    expect(QUIZ_QUESTION_SYSTEM).toContain(QUESTION_GROUNDING_RULE);
    expect(QUIZ_QUESTION_SYSTEM).toContain('不得预设候选人做过某件事');
  });

  it('参考答案用简历版规则', () => {
    expect(QUIZ_ANSWER_SYSTEM).toContain(RESUME_GROUNDING_RULE);
  });

  it('评分改进稿不许拿 JD 替候选人补经历', () => {
    expect(QUIZ_SCORE_SYSTEM).toContain(SCORE_GROUNDING_RULE);
  });

  it('输出 JSON schema 保持不变，否则下游解析会炸', () => {
    expect(QUIZ_QUESTION_SYSTEM).toContain('输出 JSON：{ "question": "..." }');
    expect(QUIZ_ANSWER_SYSTEM).toContain('输出 JSON：{ "answerMd": "..." }');
    expect(QUIZ_SCORE_SYSTEM).toContain(
      '输出 JSON：{ "score": 1-5, "feedbackMd": "...", "improvedScriptMd": "口语改进稿" }',
    );
  });
});

describe('模拟面试', () => {
  it('场景题不再允许拿 JD 职责当候选人的项目', () => {
    expect(SCENARIO_CASE_SYSTEM).not.toContain('围绕简历项目或 JD 职责');
    expect(SCENARIO_CASE_SYSTEM).toContain('不能当成候选人做过的项目来出题');
    // 简历没料时要退成假设题，而不是虚构一段经历
    expect(SCENARIO_CASE_SYSTEM).toContain('假设性场景题');
  });

  it('所有出题题型都带出题版事实来源规则', () => {
    for (const type of ['concept', 'coding', 'design', 'scenario', 'selfIntro', 'mixed'] as const) {
      expect(caseSystemForType(type)).toContain(QUESTION_GROUNDING_RULE);
    }
  });

  it('非自我介绍的参考答案也有经历隔离，不只自我介绍有', () => {
    for (const type of ['concept', 'coding', 'design', 'scenario'] as const) {
      expect(ANSWER_SYSTEM_BY_TYPE[type]).toContain('这种口吻出现的内容，只能来自简历');
    }
  });

  it('技术内容仍可用通用知识作答——不能把概念题也锁死在简历里', () => {
    // 一刀切禁止简历外内容的话，「什么是 MVCC」就没法答了
    expect(ANSWER_SYSTEM_BY_TYPE.concept).toContain('技术内容本身可以用通用知识作答');
  });

  it('自我介绍原有的硬隔离没被削弱', () => {
    expect(SELF_INTRO_ANSWER_SYSTEM).toContain('不能当成候选人做过的事');
    expect(SELF_INTRO_ANSWER_SYSTEM).toContain('自我介绍唯一事实来源');
    expect(answerSystemForType('selfIntro')).toContain('自我介绍是复述候选人自己的履历');
  });

  it('评分带改进稿取材规则', () => {
    expect(scoreSystemForType('scenario')).toContain(SCORE_GROUNDING_RULE);
    expect(scoreSystemForType('selfIntro')).toContain(SCORE_GROUNDING_RULE);
  });
});

describe('追问', () => {
  it('带上候选人上下文时把它放进 system', () => {
    const context = buildCandidateContext(
      { company: '某公司', roleTitle: '后端', resumeRawText: RESUME_MD },
      { name: '限流' },
    );
    const text = buildNodeFollowUpSystemPrompt('限流', 'n1', context);

    expect(text).toContain('限流');
    expect(text).toContain('网关限流');
    expect(text).toContain(RESUME_GROUNDING_RULE);
  });

  it('没有上下文时不留空行拼接', () => {
    const text = buildNodeFollowUpSystemPrompt('限流', 'n1');

    expect(text).toContain('nodeId: n1');
    expect(text).not.toMatch(/\n{3,}/);
  });

  it('已纳入 registry，可以按 promptId 取', () => {
    const resolved = resolvePrompt('followUp.node', { nodeName: '限流', nodeId: 'n1' });

    expect(resolved.versionId).toBe('followUp.node@v1');
    expect(resolved.text).toContain('限流');
  });
});
