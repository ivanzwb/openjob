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
