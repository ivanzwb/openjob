import { describe, expect, it } from 'vitest';
import {
  EMPTY_EXPLANATION_SELECTION,
  explanationSelectionReducer,
} from './explanationSelectionState';

describe('explanationSelectionReducer', () => {
  it('动作弹窗打开后忽略紧随其后的 WebView clear', () => {
    const opened = explanationSelectionReducer(EMPTY_EXPLANATION_SELECTION, {
      type: 'open',
      mode: 'elaboration',
      phrase: 'ReAct 循环',
      selectionStart: 42,
    });
    const afterClear = explanationSelectionReducer(opened, { type: 'clear' });

    expect(afterClear).toEqual(opened);
    expect(afterClear.phrase).toBe('ReAct 循环');
    expect(afterClear.selectionStart).toBe(42);
  });

  it('没有动作弹窗时 clear 正常清空普通选区', () => {
    const selected = explanationSelectionReducer(EMPTY_EXPLANATION_SELECTION, {
      type: 'select',
      phrase: '临时选区',
      selectionStart: 7,
    });
    expect(explanationSelectionReducer(selected, { type: 'clear' })).toEqual(
      EMPTY_EXPLANATION_SELECTION,
    );
  });

  it('关闭弹窗后允许下一次 clear 清理选区', () => {
    const opened = explanationSelectionReducer(EMPTY_EXPLANATION_SELECTION, {
      type: 'open',
      mode: 'highlight',
      phrase: '共享状态',
      selectionStart: 12,
    });
    const closed = explanationSelectionReducer(opened, { type: 'close' });
    expect(explanationSelectionReducer(closed, { type: 'clear' })).toEqual(
      EMPTY_EXPLANATION_SELECTION,
    );
  });
});
