/**
 * 宿主渲染交互协议。
 *
 * schema：Core 拥有的封闭字段协议与校验；
 * hostView：两端共用的渲染/降级决策。
 */
export {
  INPUT_KIND_RESULT_TYPE,
  INTERACTION_DISPLAY_KINDS,
  INTERACTION_FIELD_KINDS,
  INTERACTION_INPUT_KINDS,
  INTERACTION_PROTOCOL_VERSION,
  INTERACTION_RESULT_VALUE_TYPES,
  collectUnknownFieldKinds,
  isInteractionFieldKind,
  isInteractionInputKind,
  validateInteractionResultSchema,
  validateInteractionResultValue,
  validateInteractionSchema,
  type InteractionChoiceField,
  type InteractionChoiceOption,
  type InteractionCountdownField,
  type InteractionDisplayKind,
  type InteractionFactListField,
  type InteractionField,
  type InteractionFieldKind,
  type InteractionInputKind,
  type InteractionNoteField,
  type InteractionReplyField,
  type InteractionResultField,
  type InteractionResultSchema,
  type InteractionResultValue,
  type InteractionResultValueIssue,
  type InteractionResultValueType,
  type InteractionSchema,
  type InteractionSchemaIssue,
  type InteractionSchemaIssueCode,
  type InteractionTranscriptField,
} from './schema';

export type {
  EndRolePlayRequest,
  RolePlayFieldValues,
  RolePlayPersonaFactView,
  RolePlayRejectionView,
  RolePlaySessionView,
  RolePlayTurnView,
  StartRolePlayRequest,
  SubmitRolePlayTurnRequest,
} from './sessionView';

export {
  INTERACTION_ACTIVE_STATUSES,
  INTERACTION_SESSION_STATUSES,
  INTERACTION_TERMINAL_LABELS,
  INTERACTION_TERMINAL_STATUSES,
  isInteractionTerminalStatus,
  type InteractionActiveStatus,
  type InteractionSessionStatus,
  type InteractionTerminalStatus,
} from './session';

export {
  MICROPHONE_PERMISSION,
  buildInteractionHostView,
  interactionDegradationDetail,
  unknownFieldKinds,
  type InteractionHostView,
  type InteractionHostViewInput,
  type RenderableChoice,
  type RenderableCountdown,
  type RenderableFactList,
  type RenderableInteractionField,
  type RenderableNote,
  type RenderableReply,
  type RenderableTranscript,
} from './hostView';
