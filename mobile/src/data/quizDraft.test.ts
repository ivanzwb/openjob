/**
 * 考我的作答草稿必须能活过组件卸载。
 *
 * 这个面板挂在备考页里，切 tab 就整个卸载。答案原来只在组件 state 里，切走再
 * 回来是一片空白——口述一段长回答再发现白打了，比不能存更难受。
 *
 * 这里守两件事：草稿存得进读得出，以及只存答案时不能把题目和推荐答案顺手清掉
 * ——三个字段共用一条 UPDATE，写错了就是「保存草稿把题目弄丢」。
 */
import { describe, expect, it, vi } from 'vitest';
import type { SQLiteDatabase } from 'expo-sqlite';

// 被测路径用不到，但它们在模块顶层把 react-native 拉进来，vitest 解析不了
vi.mock('expo-crypto', () => ({ randomUUID: () => 'generated-id' }));
vi.mock('expo-secure-store', () => ({}));
vi.mock('../search', () => ({ searchWeb: vi.fn() }));
vi.mock('../llm/json', () => ({ completeJson: vi.fn() }));
vi.mock('../sync/identity', () => ({
  getDeviceIdentity: () => Promise.resolve({ deviceId: 'dev-1' }),
}));
// writingAs 只负责把写入标成本机来源，直接执行回调即可
vi.mock('../sync/triggers', () => ({
  writingAs: (_db: unknown, _id: string, fn: () => void) => fn(),
}));

const { getQuizDraft, updateQuizDraft } = await import('./quizLocal');

interface NodeRow {
  id: string;
  name: string;
  quiz_question_md: string | null;
  quiz_recommended_answer_md: string | null;
  quiz_answer_draft_md: string | null;
}

/**
 * 存得住值的假库：只认这一条 UPDATE 的列顺序，别的 SQL 撞上就报错，
 * 免得静默返回 null 把断言蒙过去。
 */
function fakeDb(row: NodeRow): { db: SQLiteDatabase; row: NodeRow } {
  const state = { ...row };
  const db = {
    getFirstSync: (sql: string, id: string) => {
      if (!sql.includes('knowledge_node')) throw new Error(`未预期的查询：${sql}`);
      return id === state.id ? { ...state } : null;
    },
    runSync: (sql: string, ...args: unknown[]) => {
      if (!sql.includes('UPDATE knowledge_node')) throw new Error(`未预期的写入：${sql}`);
      const [question, recommended, answerDraft] = args as (string | null)[];
      state.quiz_question_md = question;
      state.quiz_recommended_answer_md = recommended;
      state.quiz_answer_draft_md = answerDraft;
    },
  } as unknown as SQLiteDatabase;
  return { db, row: state };
}

const BASE: NodeRow = {
  id: 'n1',
  name: '消息队列幂等消费',
  quiz_question_md: '说说你怎么保证消费幂等',
  quiz_recommended_answer_md: '参考答案',
  quiz_answer_draft_md: null,
};

describe('作答草稿', () => {
  it('存进去的答案读得出来', async () => {
    const { db } = fakeDb(BASE);

    await updateQuizDraft(db, { nodeId: 'n1', answerDraftMd: '我会用唯一键去重…' });

    expect(getQuizDraft(db, 'n1').answerDraftMd).toBe('我会用唯一键去重…');
  });

  it('只存答案时，题目和推荐答案原样留着', async () => {
    const { db } = fakeDb(BASE);

    await updateQuizDraft(db, { nodeId: 'n1', answerDraftMd: '打了一半的回答' });

    const draft = getQuizDraft(db, 'n1');
    expect(draft.questionMd).toBe('说说你怎么保证消费幂等');
    expect(draft.recommendedAnswerMd).toBe('参考答案');
  });

  it('只存推荐答案时，不会把已经打好的草稿冲掉', async () => {
    const { db } = fakeDb({ ...BASE, quiz_answer_draft_md: '打了一半的回答' });

    await updateQuizDraft(db, { nodeId: 'n1', recommendedAnswerMd: '改过的参考答案' });

    const draft = getQuizDraft(db, 'n1');
    expect(draft.answerDraftMd).toBe('打了一半的回答');
    expect(draft.recommendedAnswerMd).toBe('改过的参考答案');
  });

  it('清空答案存的是 null，下次进来不会恢复出一个空串', async () => {
    const { db, row } = fakeDb({ ...BASE, quiz_answer_draft_md: '要删掉的内容' });

    await updateQuizDraft(db, { nodeId: 'n1', answerDraftMd: null });

    expect(row.quiz_answer_draft_md).toBeNull();
    expect(getQuizDraft(db, 'n1').answerDraftMd).toBeNull();
  });

  it('什么都没传就不写库——防抖每轮都会调一次，不能白刷一条 oplog', async () => {
    const { db } = fakeDb(BASE);
    const runSync = vi.spyOn(db, 'runSync');

    await updateQuizDraft(db, { nodeId: 'n1' });

    expect(runSync).not.toHaveBeenCalled();
  });

  it('考点不存在时报错，而不是静默建一条空草稿', async () => {
    const { db } = fakeDb(BASE);

    await expect(updateQuizDraft(db, { nodeId: 'missing', answerDraftMd: 'x' })).rejects.toThrow(
      '考点不存在',
    );
  });
});
