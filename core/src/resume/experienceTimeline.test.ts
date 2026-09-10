/**
 * 经历时间线的排序与格式容忍度。
 *
 * 「最近的经历优先」这条规则全押在排序上：排错了，提示词里那句「序号越小越近」
 * 就是在骗模型，比不给顺序更糟。而简历里的时间写法是用户手打的，`2021-04`、
 * `2021.4`、`2021年4月`、`至今` 都得认。
 */
import { describe, expect, it } from 'vitest';
import {
  buildResumeExperienceTimeline,
  formatResumeExperienceForPrompt,
  resumeExperienceBlock,
  resumeFactsBlockForSelfIntro,
  skillsFromResumeMd,
} from './experienceTimeline';

const RESUME = `## 基本信息

- 姓名：张三

## 工作经历

### 老东家科技 | 前端工程师 | 2018-07 ~ 2021-03

- 维护一个 jQuery 老系统

### 现东家网络 | 高级前端工程师 | 2021-04 ~ 至今

- 负责 B 端中台的前端架构

## 项目经历

### 数据看板重构 | 技术负责人 | 2023.05 ~ 2024.08

- 把首屏从 4s 压到 1.2s

### 内部脚手架 | 主要开发 | 2019年3月 ~ 2019年11月

- 统一了七个项目的构建配置

## 专业技能

前端：React、TypeScript
`;

describe('buildResumeExperienceTimeline', () => {
  it('按时间倒序排，进行中的排最前', () => {
    const entries = buildResumeExperienceTimeline(RESUME);

    expect(entries.map((e) => e.org)).toEqual([
      '现东家网络', // 至今
      '数据看板重构', // 2024-08
      '老东家科技', // 2021-03
      '内部脚手架', // 2019-11
    ]);
  });

  it('认得出工作经历和项目经历，并标出进行中', () => {
    const entries = buildResumeExperienceTimeline(RESUME);

    expect(entries[0]).toMatchObject({
      section: 'experience',
      org: '现东家网络',
      role: '高级前端工程师',
      period: '2021-04 ~ 至今',
      ongoing: true,
    });
    expect(entries[1]).toMatchObject({
      section: 'project',
      org: '数据看板重构',
      ongoing: false,
    });
  });

  it('吃得下手打的各种时间写法', () => {
    const md = `## 项目经历

### A 项目 | 开发 | 2020/06-2021/08

内容 A

### B 项目 | 开发 | 2022年1月 ~ 2022年12月

内容 B

### C 项目 | 开发 | 2019.03 ~ 2019.09

内容 C
`;

    expect(buildResumeExperienceTimeline(md).map((e) => e.org)).toEqual([
      'B 项目',
      'A 项目',
      'C 项目',
    ]);
  });

  it('没写时间的经历排在最后，不冒充最近', () => {
    const md = `## 工作经历

### 没写时间的公司 | 工程师

内容

### 有时间的公司 | 工程师 | 2015-01 ~ 2016-01

内容
`;

    expect(buildResumeExperienceTimeline(md).map((e) => e.org)).toEqual([
      '有时间的公司',
      '没写时间的公司',
    ]);
  });
});

describe('formatResumeExperienceForPrompt', () => {
  it('带上倒序说明、序号和进行中标记', () => {
    const text = formatResumeExperienceForPrompt(RESUME);

    expect(text).toContain('按时间倒序');
    expect(text).toContain('1. [工作·进行中] 2021-04 ~ 至今 现东家网络 · 高级前端工程师');
    expect(text).toContain('2. [项目] 2023.05 ~ 2024.08 数据看板重构 · 技术负责人');
  });

  it('条数与单条篇幅都有上限，免得把上下文撑爆', () => {
    const text = formatResumeExperienceForPrompt(RESUME, {
      maxEntries: 2,
      maxDescriptionChars: 5,
    });

    expect(text).toContain('现东家网络');
    expect(text).not.toContain('老东家科技');
    expect(text).toContain('…');
  });

  it('简历里一个时间都没有时返回空串，让调用方退回旧摘要', () => {
    expect(formatResumeExperienceForPrompt('随便一段没有结构的简历正文')).toBe('');
  });
});

describe('resumeExperienceBlock', () => {
  it('有时间就用时间线', () => {
    expect(resumeExperienceBlock(RESUME, [])).toContain('按时间倒序');
  });

  it('没时间就退回项目摘要，并说清为什么没有顺序', () => {
    const block = resumeExperienceBlock('一段纯文本简历', [
      { name: '某项目', summary: '做了些事', drillableTopics: ['缓存', '一致性'] },
    ]);

    expect(block).toContain('简历未填写时间');
    expect(block).toContain('某项目：做了些事；可深挖：缓存、一致性');
  });

  it('两样都没有时不至于拼出空段落', () => {
    expect(resumeExperienceBlock('', [])).toContain('（未提供）');
  });
});

describe('resumeFactsBlockForSelfIntro', () => {
  it('包含唯一事实来源说明、时间线和个人优势', () => {
    const block = resumeFactsBlockForSelfIntro(RESUME);

    expect(block).toContain('自我介绍唯一事实来源');
    expect(block).toContain('按时间倒序');
    expect(block).toContain('现东家网络');
  });

  it('没有时间线时退回项目摘要', () => {
    const block = resumeFactsBlockForSelfIntro('一段纯文本简历', [
      { name: '某项目', summary: '做了些事', drillableTopics: ['缓存'] },
    ]);

    expect(block).toContain('自我介绍唯一事实来源');
    expect(block).toContain('某项目：做了些事');
  });
});

describe('resumeFactsBlockForSelfIntro 身份素材', () => {
  it('开场身份素材包含基本信息里的姓名（脱敏字段不进）', () => {
    const block = resumeFactsBlockForSelfIntro(RESUME);
    expect(block).toContain('基本信息（开场身份素材）');
    expect(block).toContain('姓名：张三');
    expect(block).not.toContain('1380000');
  });
});

describe('resumeFactsBlockForSelfIntro 工作线并入', () => {
  const NESTED = `## 工作经历

### 甲厂 | 后端工程师 | 2020-01 ~ 至今

- 负责订单中台

## 项目经历

### 订单中台重构 | 技术负责人 | 2022-06 ~ 至今

- 把下单链路延迟降低 40%

### 毕业设计 | 学生 | 2018-03 ~ 2018-06

- 课程作业
`;

  it('落在工作经历期间的项目紧随该工作条目，并标注并入', () => {
    const block = resumeFactsBlockForSelfIntro(NESTED);
    const workIdx = block.indexOf('1. [工作·进行中]');
    const projectIdx = block.indexOf('订单中台重构');
    expect(workIdx).toBeGreaterThanOrEqual(0);
    expect(projectIdx).toBeGreaterThan(workIdx);
    expect(block).toContain('[项目·并入工作线');
    expect(block).toContain('不要重复报时间与职级');
    // 工作期之外的项目不并入、也不加注
    expect(block).toContain('[项目]');
  });

  it('工作条目与项目条目按时间各自归位，不影响「按时间倒序」说明', () => {
    expect(resumeFactsBlockForSelfIntro(NESTED)).toContain('按时间倒序');
  });
});

describe('resumeFactsBlockForSelfIntro 岗位匹配候选素材', () => {
  it('按 JD 要求预筛出相关经历与技能节，带命中要求与权重', () => {
    const block = resumeFactsBlockForSelfIntro(RESUME, null, [
      { skill: '数据看板重构 首屏', weight: 0.9 },
      { skill: 'TypeScript', weight: 0.8 },
    ]);
    expect(block).toContain('岗位匹配候选素材');
    expect(block).toContain('经历条目 2');
    expect(block).toContain('数据看板重构');
    expect(block).toContain('命中：数据看板重构 首屏(90%)');
    // 内容仍然只准从唯一事实来源取
    expect(block.indexOf('岗位匹配候选素材')).toBeGreaterThan(block.indexOf('唯一事实来源'));
  });

  it('没有能覆盖 JD 要求的素材时不生成候选块（退回全量事实）', () => {
    const block = resumeFactsBlockForSelfIntro(RESUME, null, [
      { skill: '量子计算 拓扑纠错', weight: 0.9 },
    ]);
    expect(block).not.toContain('岗位匹配候选素材');
    expect(block).toContain('现东家网络');
  });

  it('不传 JD 要求时不生成候选块', () => {
    expect(resumeFactsBlockForSelfIntro(RESUME)).not.toContain('岗位匹配候选素材');
  });
});

describe('skillsFromResumeMd', () => {
  it('parsed 缺失时能从专业技能节提取技能（冒号后按顿号拆）', () => {
    expect(skillsFromResumeMd(RESUME)).toEqual(['React', 'TypeScript']);
  });

  it('没有专业技能节时返回空', () => {
    expect(skillsFromResumeMd('## 工作经历\n\n### A | B | 2020 ~ 至今\n- x')).toEqual([]);
  });
});
