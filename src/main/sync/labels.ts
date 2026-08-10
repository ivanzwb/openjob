import type { MergeContext } from '@shared/syncMerge';
import { isDeviceLocalColumn, syncTableSpec } from './tables';

const TABLE_LABELS: Record<string, string> = {
  resume: '简历',
  campaign: '备考',
  knowledge_node: '知识点',
  node_edge: '图谱边',
  explanation: '讲解',
  source: '来源',
  company_intel: '公司情报',
  interview_report: '面经',
  interview_question: '真题',
  plan_day: '计划日',
  task: '任务',
  quiz_attempt: '测验',
  repo: '源码仓库',
  code_ref: '代码引用',
  annotation: '标记',
  speech_snippet: '话术',
  session: '对话',
  message: '消息',
  tool_call: '工具调用',
};

const FIELD_LABELS: Record<string, string> = {
  name: '名称',
  status: '状态',
  mastery: '掌握度',
  company: '公司',
  role_title: '岗位',
  content_md: '内容',
  note_md: '笔记',
  question_text: '题目',
  delete: '删除冲突',
};

function titleFromValues(table: string, values: Record<string, unknown>): string {
  if (typeof values.name === 'string' && values.name) return values.name;
  if (typeof values.title === 'string' && values.title) return values.title;
  if (typeof values.company === 'string' && values.company) {
    const role = typeof values.role_title === 'string' ? values.role_title : '';
    return role ? `${values.company} · ${role}` : values.company;
  }
  if (typeof values.label === 'string' && values.label) return values.label;
  if (typeof values.question_text === 'string' && values.question_text) {
    return values.question_text.slice(0, 40);
  }
  return table;
}

export function buildMergeContext(clockOffsetMs = 0): MergeContext {
  return {
    clockOffsetMs,
    isDeviceLocal: isDeviceLocalColumn,
    primaryKey: (table) => syncTableSpec(table).pk,
    labelFor: (table, _rowId, values) => {
      const tableLabel = TABLE_LABELS[table] ?? table;
      const title = titleFromValues(table, values);
      return `${tableLabel}：${title}`;
    },
  };
}

export function fieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field;
}
