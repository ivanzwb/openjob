/**
 * 守「考我/追问的 user message 里必须有候选人简历」这条线。
 *
 * 这几个调用点原先只喂公司名、岗位名、考点名，模型要举例就只能照岗位职责
 * 编一段候选人的经历——用户报的就是这个。谁把简历这一段拿掉，这里要红。
 */
import { describe, expect, it } from 'vitest';
import type { SQLiteDatabase } from 'expo-sqlite';
import {
  buildNodeFollowUpSystem,
  jdSummaryForPrompt,
  loadQuizPromptContext,
  parseResumeForPrompt,
  quizAnswerUserMessage,
  quizQuestionUserMessage,
  quizScoreUserMessage,
} from './candidateContextLocal';

const RESUME_MD = `## 工作经历

### 现东家网络 | 高级前端工程师 | 2021-04 ~ 至今

- 负责 B 端中台的前端架构，把首屏从 4s 压到 1.2s

## 项目经历

### 内部脚手架 | 主要开发 | 2019年3月 ~ 2019年11月

- 统一了七个项目的构建配置
`;

const RESUME_PARSED = JSON.stringify({
  skills: ['React', 'TypeScript'],
  projects: [{ name: '内部脚手架', summary: '统一构建配置', drillableTopics: ['webpack'] }],
});

const NODE_ROW = {
  id: 'n1',
  campaign_id: 'c1',
  parent_id: null,
  name: 'MVCC',
  kind: 'concept',
  coverage_type: 'gap',
  exam_prob: 0.6,
  difficulty: 3,
  est_minutes: 20,
  exam_forms: '["concept"]',
  mastery: 2,
  mastery_source: 'self',
  priority_score: 1,
  status: 'shaky',
  is_user_added: 0,
  quiz_question_md: null,
  quiz_recommended_answer_md: null,
  created_at: 0,
};

/** 只实现被测路径用到的 getFirstSync，其余查询撞上就直接报错，免得静默返回 null */
function fakeDb(resume: { parsed: string | null; raw_text: string | null } | null): SQLiteDatabase {
  const campaignRow = {
    id: 'c1',
    company: '某公司',
    role_title: '后端工程师',
    jd_raw: '要求精通 Kubernetes 与容器化部署',
    jd_parsed: null,
    job_target_id: null,
    resume_id: resume ? 'r1' : null,
    interview_date: null,
    daily_minutes: null,
    status: 'active',
    created_at: 0,
    updated_at: 0,
  };

  return {
    getFirstSync: (sql: string) => {
      if (sql.includes('knowledge_node')) return NODE_ROW;
      if (sql.includes('FROM campaign')) return campaignRow;
      if (sql.includes('FROM resume')) return resume;
      throw new Error(`未预期的查询：${sql}`);
    },
  } as unknown as SQLiteDatabase;
}

const withResume = (): SQLiteDatabase => fakeDb({ parsed: RESUME_PARSED, raw_text: RESUME_MD });

describe('考我三件套的 user message', () => {
  it('出题带上简历经历块和考点', () => {
    const message = quizQuestionUserMessage(loadQuizPromptContext(withResume(), 'n1'));

    expect(message).toContain('简历经历');
    expect(message).toContain('现东家网络');
    expect(message).toContain('前端架构');
    expect(message).toContain('简历技能：React、TypeScript');
    expect(message).toContain('考点：MVCC');
    expect(message).toContain('公司：某公司');
  });

  it('推荐答案带上简历经历块，并保留原来的「问题：」', () => {
    const message = quizAnswerUserMessage(
      loadQuizPromptContext(withResume(), 'n1'),
      'MVCC 是怎么实现快照读的？',
    );

    expect(message).toContain('简历经历');
    expect(message).toContain('前端架构');
    expect(message).toContain('问题：MVCC 是怎么实现快照读的？');
  });

  it('评分带上简历经历块，并保留原来的「问题：」「候选人回答：」', () => {
    const message = quizScoreUserMessage(
      loadQuizPromptContext(withResume(), 'n1'),
      'MVCC 是怎么实现快照读的？',
      '靠 undo log 加 read view',
    );

    expect(message).toContain('简历经历');
    expect(message).toContain('前端架构');
    expect(message).toContain('问题：MVCC 是怎么实现快照读的？');
    expect(message).toContain('候选人回答：靠 undo log 加 read view');
  });

  it('没关联简历时明说，不能只留一句「未提供」让模型拿 JD 填经历', () => {
    const message = quizQuestionUserMessage(loadQuizPromptContext(fakeDb(null), 'n1'));

    expect(message).toContain('尚未关联简历');
    expect(message).toContain('不要虚构');
  });
});

describe('追问 system prompt', () => {
  it('走 registry，并带上简历与考点', () => {
    const text = buildNodeFollowUpSystem(withResume(), 'n1', 'MVCC');

    expect(text).toContain('nodeId: n1');
    expect(text).toContain('考点：MVCC');
    expect(text).toContain('前端架构');
  });

  it('没关联简历时也要带上禁止虚构经历的提示', () => {
    const text = buildNodeFollowUpSystem(fakeDb(null), 'n1', 'MVCC');

    expect(text).toContain('尚未关联简历');
  });

  it('考点查不到时退回不带上下文的那份，不能让整段对话发不出去', () => {
    const brokenDb = { getFirstSync: () => null } as unknown as SQLiteDatabase;

    const text = buildNodeFollowUpSystem(brokenDb, 'n1', 'MVCC');

    expect(text).toContain('nodeId: n1');
    expect(text).not.toContain('公司：');
    expect(text).not.toContain('尚未关联简历');
  });
});

describe('jdSummaryForPrompt', () => {
  it('有结构化解析时用它定重点', () => {
    const summary = jdSummaryForPrompt({
      jdRaw: '原文',
      jdParsed: {
        roleTitle: '后端工程师',
        seniority: 'P6',
        requirements: [{ skill: 'Go', weight: 0.8 }],
      },
    });

    expect(summary).toBe('职级：P6；要求：Go(80%)');
  });

  it('没有解析时退回 JD 原文', () => {
    expect(jdSummaryForPrompt({ jdRaw: 'JD 原文', jdParsed: null })).toBe('JD 原文');
  });
});

describe('parseResumeForPrompt', () => {
  it('parsed 是坏 JSON 时不炸，简历原文仍然要进上下文', () => {
    const fields = parseResumeForPrompt({ parsed: '{不是 JSON', raw_text: RESUME_MD });

    expect(fields.skills).toEqual([]);
    expect(fields.rawText).toBe(RESUME_MD);
  });
});
