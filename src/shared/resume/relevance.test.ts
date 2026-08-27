/**
 * 守「简历经历怎么排序、怎么进 prompt」这件事。
 *
 * 这里曾经守的是一道门禁：低于阈值的经历判为不相关、整条剔除，一条都挑不出时
 * prompt 里写「简历里没有与本题直接相关的经历」。门禁拆掉了，理由见 relevance.ts
 * 顶部——词法跨不过 K8s↔Kubernetes 这类同义关系，撑不起这么强的断言。
 *
 * 所以现在钉的是两件事：排序要把最可能相关的顶上来（词法擅长的），以及无论排得
 * 好不好都别把经历弄丢、并且明确告诉模型相关性要它自己判断（词法不擅长的）。
 */
import { describe, expect, it } from 'vitest';
import {
  NO_EXPERIENCE_ENTRIES_NOTICE,
  rankResumeExperience,
  rankResumeProjects,
  relevantResumeExperienceBlock,
} from './relevance';

/** 一份后端简历：三段经历分别打在消息队列、数据库、前端三个方向 */
const BACKEND_RESUME = `# 张三

## 工作经历

### 涌泉科技 | 后端工程师 | 2021-04 ~ 至今
- 重构对账中心，用 Kafka 做异步削峰，处理消费端幂等，日终跑批从 40 分钟压到 6 分钟
- 消息重复投递用唯一键加 Redis 去重表兜底

### 明河网络 | 后端工程师 | 2019-06 ~ 2021-03
- 订单库分库分表，基于 MySQL 做水平拆分，处理跨库事务与慢查询治理
- 用 MVCC 分析了一批幻读问题，调整隔离级别

## 项目经历

### 内部管理台 | 前端负责人 | 2018-01 ~ 2019-05
- 用 React 重写管理后台，做了组件库和权限路由
`;

const orgsOf = (resume: string, query: Parameters<typeof rankResumeExperience>[1]): string[] =>
  rankResumeExperience(resume, query).map((r) => r.entry.org);

describe('rankResumeExperience 排序', () => {
  it('考点命中哪段就把哪段顶到第一，而不是最近的那段', () => {
    const ranked = rankResumeExperience(BACKEND_RESUME, { nodeName: 'MySQL 分库分表' });

    expect(ranked[0]!.entry.org).toBe('明河网络');
    // 最近的那段是涌泉科技，按时间倒序会排第一，按相关度不该排第一
    expect(ranked[0]!.recencyIndex).not.toBe(0);
  });

  it('换个考点就换一段排第一', () => {
    expect(orgsOf(BACKEND_RESUME, { nodeName: '消息队列幂等消费' })[0]).toBe('涌泉科技');
  });

  it('用户当轮问的话也参与排序，不只看考点名', () => {
    const ranked = rankResumeExperience(BACKEND_RESUME, {
      nodeName: '性能优化',
      userText: '想听你讲讲 React 组件库那块怎么做的',
    });

    expect(ranked[0]!.entry.org).toBe('内部管理台');
  });

  it('两个字的考点名也能把对的那段顶上来', () => {
    // 中文技术词大量是两个字的：限流、熔断、幂等、缓存、索引、死锁，只切得出
    // 一个二元组。这一条钉住它们不会因为信号太弱而排不动。
    const resume = `# 周八

## 工作经历

### 甲公司 | 工程师 | 2023-01 ~ 至今
- 负责网关限流与熔断

### 乙公司 | 工程师 | 2020-01 ~ 2022-12
- 维护订单系统
`;

    expect(orgsOf(resume, { nodeName: '限流' })[0]).toBe('甲公司');
  });

  it('啰嗦的追问不会把考点名的精确命中盖过去', () => {
    const resume = `# 吴九

## 工作经历

### 甲公司 | 工程师 | 2023-01 ~ 至今
- 负责网关限流与熔断

### 乙公司 | 工程师 | 2020-01 ~ 2022-12
- 维护订单系统
`;
    const ranked = rankResumeExperience(resume, {
      nodeName: '限流',
      userText:
        '我想听你详细讲讲这块在实际项目里到底是怎么一步步落地的，最好能结合一些具体的数字和当时的取舍',
    });

    expect(ranked[0]!.entry.org).toBe('甲公司');
  });

  it('只传划选原文、没有考点名时照样排得动', () => {
    // 细化链路（模拟面试里划一段让它展开）就是这个形状：只有 userText，没有考点名
    const resume = `# 郑十

## 工作经历

### 甲公司 | 工程师 | 2023-01 ~ 至今
- 负责网关限流与熔断

### 乙公司 | 工程师 | 2020-01 ~ 2022-12
- 维护订单系统
`;

    expect(orgsOf(resume, { userText: '限流' })[0]).toBe('甲公司');
  });

  it('到处都出现的中文词不制造排序信号', () => {
    // 每条经历都写了「负责」「系统」「优化」，靠原始重叠会让三段全部命中、
    // 排序退化成随机。IDF 把 df 等于文档数的词压到接近零，顺序应该保持时间倒序。
    const resume = `# 王五

## 工作经历

### 甲公司 | 工程师 | 2023-01 ~ 至今
- 负责订单系统的优化，用 Kafka 削峰

### 乙公司 | 工程师 | 2021-01 ~ 2022-12
- 负责风控系统的优化，做了规则引擎

### 丙公司 | 工程师 | 2019-01 ~ 2020-12
- 负责报表系统的优化，写了聚合任务
`;

    expect(orgsOf(resume, { nodeName: '负责系统优化' })).toEqual(['甲公司', '乙公司', '丙公司']);
    // 同一份简历里，真正的技术词照样能改变顺序
    expect(orgsOf(resume, { nodeName: 'Kafka' })[0]).toBe('甲公司');
  });

  it('每段经历都在用的技术，问起来仍然排得出先后', () => {
    // df 等于文档数时 IDF 趋零。如果拉丁技术词也乘 IDF，一个一直在做 Kafka 的人
    // 问 Kafka 会得到一个全零打分、排序退化成时间倒序——恰恰是覆盖最充分的情况
    // 失去了信号。
    const resume = `# 赵六

## 工作经历

### 新东家 | 工程师 | 2023-01 ~ 至今
- Kafka 消费链路治理

### 老东家 | 工程师 | 2020-01 ~ 2022-12
- 只做过一些报表
`;
    const ranked = rankResumeExperience(resume, { nodeName: 'Kafka' });

    expect(ranked[0]!.entry.org).toBe('新东家');
    expect(ranked[0]!.score).toBeGreaterThan(0);
  });

  it('年份不参与匹配', () => {
    // 「2021」在简历里到处都是，放进查询词会让日期蹭出相关性
    const ranked = rankResumeExperience(BACKEND_RESUME, { nodeName: '2021' });

    expect(ranked.every((r) => r.score === 0)).toBe(true);
  });

  it('同分时时间近的在前', () => {
    const resume = `# 李四

## 工作经历

### 新东家 | 工程师 | 2023-01 ~ 至今
- 负责 Kafka 消费链路

### 老东家 | 工程师 | 2020-01 ~ 2022-12
- 负责 Kafka 消费链路
`;

    expect(orgsOf(resume, { nodeName: 'Kafka' })[0]).toBe('新东家');
  });
});

describe('rankResumeExperience 不做剔除', () => {
  it('词法一条都打不中时，仍然把经历全给出来', () => {
    // 这是拆掉门禁的正题：考点「K8s」和简历里的 Kubernetes 是同一件事，词法看不出。
    // 旧实现在这里返回空、prompt 写「简历里没有相关经历」，而候选人明明做过。
    const resume = `# 陈十二

## 工作经历

### 甲公司 | 运维开发 | 2023-01 ~ 至今
- 用 Kubernetes 做多集群灰度发布

### 乙公司 | 工程师 | 2020-01 ~ 2022-12
- 维护订单系统
`;

    expect(orgsOf(resume, { nodeName: 'K8s 调度' })).toEqual(['甲公司', '乙公司']);
  });

  it('查询词为空时按时间倒序给全，不是给空', () => {
    expect(orgsOf(BACKEND_RESUME, {})).toEqual(['涌泉科技', '明河网络', '内部管理台']);
    expect(orgsOf(BACKEND_RESUME, { nodeName: '   ' })).toHaveLength(3);
  });

  it('简历为空时不炸', () => {
    expect(rankResumeExperience('', { nodeName: 'Kafka' })).toEqual([]);
  });
});

describe('relevantResumeExperienceBlock', () => {
  it('表头说排序只是粗排，不能声称已经筛过', () => {
    const block = relevantResumeExperienceBlock(BACKEND_RESUME, { nodeName: 'Kafka 幂等' });

    expect(block).toContain('粗排');
    expect(block).toContain('仅供参考');
    expect(block).not.toContain('按时间倒序');
    // 排序是词法算的，说成「已筛选」会让模型默认第一条就是相关的那条
    expect(block).not.toContain('已按与本题的相关度筛选');
  });

  it('把相关性判断明确交给模型，并保留防编造条款', () => {
    const block = relevantResumeExperienceBlock(BACKEND_RESUME, { nodeName: 'Kafka 幂等' });

    expect(block).toContain('先判断上面哪几段与本题真的相关');
    expect(block).toContain('若都不相关');
    expect(block).toContain('不要把无关经历硬套到本题上');
  });

  it('相关的排前面，不相关的仍然留在列表里', () => {
    const block = relevantResumeExperienceBlock(BACKEND_RESUME, { nodeName: 'Kafka 幂等消费' });

    expect(block.indexOf('涌泉科技')).toBeGreaterThan(-1);
    // 前端那段和消息队列无关，但不能丢——词法说无关不算数
    expect(block.indexOf('内部管理台')).toBeGreaterThan(block.indexOf('涌泉科技'));
  });

  it('每条仍带时间和进行中标记，新旧看得出来', () => {
    const block = relevantResumeExperienceBlock(BACKEND_RESUME, { nodeName: 'Kafka 幂等' });

    expect(block).toContain('2021-04 ~ 至今');
    expect(block).toContain('进行中');
  });

  it('命中的证据在描述靠后位置时，截断不能把它切掉', () => {
    // 把「之所以排第一」的那句话截掉，模型看到的是一段与题目无关的文字，
    // 却排在最前面——它会照着这段编。
    const padding = '先讲一段和主题无关的铺垫内容。'.repeat(30);
    const resume = `# 钱十一

## 工作经历

### 甲公司 | 工程师 | 2023-01 ~ 至今
- ${padding}最后才提到用 Kafka 做削峰填谷

### 乙公司 | 工程师 | 2020-01 ~ 2022-12
- 维护订单系统
`;
    const block = relevantResumeExperienceBlock(resume, { nodeName: 'Kafka' });

    expect(block).toContain('甲公司');
    expect(block).toContain('Kafka');
  });

  it('一条经历条目都抽不出来时给显式提示', () => {
    const block = relevantResumeExperienceBlock('# 只有名字，没有经历', { nodeName: 'Kafka' });

    expect(block).toBe(NO_EXPERIENCE_ENTRIES_NOTICE);
    expect(block).toContain('没有可引用的经历条目');
    // 这条和「没关联简历」是两件事，不能混
    expect(block).not.toContain('尚未关联简历');
  });

  it('简历没写时间时退回项目摘要，同样是粗排不剔除', () => {
    const block = relevantResumeExperienceBlock('# 空简历', { nodeName: 'Kafka 幂等' }, {
      fallbackProjects: [
        { name: '消息平台', summary: '基于 Kafka 的消息中台', drillableTopics: ['幂等', '重试'] },
        { name: '官网改版', summary: 'React 静态站', drillableTopics: ['SSR'] },
      ],
    });

    expect(block.indexOf('消息平台')).toBeGreaterThan(-1);
    expect(block.indexOf('官网改版')).toBeGreaterThan(block.indexOf('消息平台'));
    expect(block).toContain('无法判断新旧');
  });

  it('限制条数，不让长简历挤占篇幅', () => {
    const block = relevantResumeExperienceBlock(
      BACKEND_RESUME,
      { nodeName: 'Kafka MySQL React 幂等 分库 组件' },
      { maxEntries: 1 },
    );

    expect(block.match(/^\d+\. \[/gm)).toHaveLength(1);
  });
});

describe('rankResumeProjects', () => {
  it('可深挖点参与排序', () => {
    const ranked = rankResumeProjects(
      [
        { name: '甲项目', summary: '一个后台', drillableTopics: ['分布式锁'] },
        { name: '乙项目', summary: '一个前台', drillableTopics: ['骨架屏'] },
      ],
      { nodeName: '分布式锁怎么实现' },
    );

    expect(ranked.map((p) => p.name)[0]).toBe('甲项目');
  });

  it('没有项目时返回空', () => {
    expect(rankResumeProjects(null, { nodeName: 'Kafka' })).toEqual([]);
  });
});
