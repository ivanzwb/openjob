export type ActionModalMode =
  | 'highlight'
  | 'note'
  | 'edit'
  | 'elaboration'
  | 'viewMarker'
  | 'regenerate';

export interface ExplanationSelectionState {
  phrase: string;
  selectionStart: number | undefined;
  modalMode: ActionModalMode | null;
}

export type ExplanationSelectionAction =
  | { type: 'select'; phrase: string; selectionStart: number | undefined }
  | {
      type: 'open';
      mode: ActionModalMode;
      phrase?: string;
      selectionStart?: number;
    }
  | { type: 'clear' }
  | { type: 'close' }
  | { type: 'reset' };

export const EMPTY_EXPLANATION_SELECTION: ExplanationSelectionState = {
  phrase: '',
  selectionStart: undefined,
  modalMode: null,
};

/**
 * WebView 的 action 后经常紧跟 selectionchange/clear。把选区和弹窗合并为一个
 * 顺序状态机，确保 action → clear 时 clear 看到的是已打开弹窗的最新状态。
 */
export function explanationSelectionReducer(
  state: ExplanationSelectionState,
  action: ExplanationSelectionAction,
): ExplanationSelectionState {
  switch (action.type) {
    case 'select':
      return {
        ...state,
        phrase: action.phrase.trim(),
        selectionStart: action.selectionStart,
      };
    case 'open':
      return {
        phrase: action.phrase?.trim() ?? state.phrase,
        selectionStart:
          action.selectionStart !== undefined
            ? action.selectionStart
            : state.selectionStart,
        modalMode: action.mode,
      };
    case 'clear':
      return state.modalMode === null ? EMPTY_EXPLANATION_SELECTION : state;
    case 'close':
      return { ...state, modalMode: null };
    case 'reset':
      return EMPTY_EXPLANATION_SELECTION;
  }
}
