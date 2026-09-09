import { describe, expect, it } from 'vitest';

import {
  INTERACTION_FIELD_KINDS,
  INTERACTION_PROTOCOL_VERSION,
  isInteractionFieldKind,
  validateInteractionResultSchema,
  validateInteractionResultValue,
  validateInteractionSchema,
  type InteractionChoiceField,
  type InteractionResultSchema,
  type InteractionSchema,
} from './schema';

function schema(fields: InteractionSchema['fields']): InteractionSchema {
  return { protocolVersion: INTERACTION_PROTOCOL_VERSION, fields };
}

const REPLY_FIELD = {
  id: 'reply',
  kind: 'reply',
  label: '你的回应',
  maxChars: 100,
  voiceCapable: true,
} as const;

const CHOICE_FIELD: InteractionChoiceField = {
  id: 'intent',
  kind: 'choice',
  label: '本轮意图',
  options: [
    { value: 'discover', label: '探询' },
    { value: 'advance', label: '推进' },
  ],
};

function resultSchema(fields: InteractionResultSchema['fields']): InteractionResultSchema {
  return { protocolVersion: INTERACTION_PROTOCOL_VERSION, fields };
}

describe('interaction field protocol', () => {
  /**
   * 字段类型集必须是封闭的。
   *
   * 一旦允许任意类型，宿主就渲染不出来，最后只能给插件开「自带组件」的后门，
   * 「插件不注入任意 React 组件」这条约束随之作废。
   */
  it('字段类型集封闭，不认识的类型不被接受', () => {
    expect([...INTERACTION_FIELD_KINDS]).toEqual([
      'note',
      'factList',
      'transcript',
      'countdown',
      'reply',
      'choice',
    ]);
    expect(isInteractionFieldKind('note')).toBe(true);
    expect(isInteractionFieldKind('webview')).toBe(false);
    expect(isInteractionFieldKind('component')).toBe(false);
  });

  it('合法 schema 无 issue', () => {
    expect(
      validateInteractionSchema(
        schema([
          { id: 'persona', kind: 'factList', label: '人设' },
          { id: 'remaining-time', kind: 'countdown', label: '剩余', totalSeconds: 60 },
          REPLY_FIELD,
        ]),
      ),
    ).toEqual([]);
  });

  it('不认识的字段类型报 unknown-field-kind', () => {
    const issues = validateInteractionSchema({
      protocolVersion: INTERACTION_PROTOCOL_VERSION,
      fields: [{ id: 'panel', kind: 'react-component', label: '自定义' }, REPLY_FIELD],
    });
    expect(issues.map((issue) => issue.code)).toContain('unknown-field-kind');
  });

  it('协议版本高于本机时报 unsupported-protocol', () => {
    const issues = validateInteractionSchema({
      protocolVersion: INTERACTION_PROTOCOL_VERSION + 1,
      fields: [REPLY_FIELD],
    });
    expect(issues.map((issue) => issue.code)).toContain('unsupported-protocol');
  });

  it('没有任何可输入字段时报错', () => {
    const issues = validateInteractionSchema(
      schema([{ id: 'persona', kind: 'factList', label: '人设' }]),
    );
    expect(issues.map((issue) => issue.code)).toContain('no-input-field');
  });

  it('字段 ID 重复被拒', () => {
    const issues = validateInteractionSchema(schema([REPLY_FIELD, { ...REPLY_FIELD }]));
    expect(issues.map((issue) => issue.code)).toContain('duplicate-id');
  });

  it('单选少于两个选项或选项重复被拒', () => {
    expect(
      validateInteractionSchema(
        schema([REPLY_FIELD, { ...CHOICE_FIELD, options: [{ value: 'a', label: 'A' }] }]),
      ).map((issue) => issue.code),
    ).toContain('invalid-value');

    expect(
      validateInteractionSchema(
        schema([
          REPLY_FIELD,
          {
            ...CHOICE_FIELD,
            options: [
              { value: 'a', label: 'A' },
              { value: 'a', label: 'A2' },
            ],
          },
        ]),
      ).map((issue) => issue.code),
    ).toContain('duplicate-id');
  });

  it('非对象、空字段列表都被拒而不是抛异常', () => {
    expect(validateInteractionSchema(null).length).toBeGreaterThan(0);
    expect(validateInteractionSchema('reply').length).toBeGreaterThan(0);
    expect(validateInteractionSchema({ protocolVersion: 1, fields: [] }).length).toBeGreaterThan(0);
  });
});

describe('result schema 与输入 schema 的交叉校验', () => {
  /**
   * 这是协议的关键不变量：宿主不可能返回它从未渲染过的字段。
   * 插件想拿额外数据，只能先声明一个宿主真的会画出来的输入字段。
   */
  it('结果字段必须对应输入 schema 里的可输入字段', () => {
    const input = schema([REPLY_FIELD]);
    const issues = validateInteractionResultSchema(
      resultSchema([{ id: 'clipboard', valueType: 'text', required: true }]),
      input,
    );
    expect(issues.map((issue) => issue.code)).toContain('missing-reference');
  });

  it('只读展示字段不能作为结果字段', () => {
    const input = schema([{ id: 'persona', kind: 'factList', label: '人设' }, REPLY_FIELD]);
    const issues = validateInteractionResultSchema(
      resultSchema([{ id: 'persona', valueType: 'text', required: true }]),
      input,
    );
    expect(issues.map((issue) => issue.code)).toContain('missing-reference');
  });

  it('结果值类型由字段类型唯一决定，插件不能自选', () => {
    const input = schema([REPLY_FIELD, CHOICE_FIELD]);
    const issues = validateInteractionResultSchema(
      resultSchema([{ id: 'intent', valueType: 'text', required: false }]),
      input,
    );
    expect(issues.map((issue) => issue.code)).toContain('type-mismatch');

    expect(
      validateInteractionResultSchema(
        resultSchema([
          { id: 'reply', valueType: 'text', required: true },
          { id: 'intent', valueType: 'choice', required: false },
        ]),
        input,
      ),
    ).toEqual([]);
  });
});

describe('运行期结果数据校验', () => {
  const input = schema([REPLY_FIELD, CHOICE_FIELD]);
  const result = resultSchema([
    { id: 'reply', valueType: 'text', required: true },
    { id: 'intent', valueType: 'choice', required: false },
  ]);

  it('必填缺失被拒，选填缺失通过', () => {
    expect(
      validateInteractionResultValue(result, input, { intent: 'discover' }).map(
        (issue) => issue.code,
      ),
    ).toContain('missing-required');
    expect(validateInteractionResultValue(result, input, { reply: '好的' })).toEqual([]);
  });

  it('空白字符串等同于未填', () => {
    expect(
      validateInteractionResultValue(result, input, { reply: '   ' }).map((issue) => issue.code),
    ).toContain('missing-required');
  });

  it('未声明的字段被拒，防止悄悄塞入额外内容', () => {
    expect(
      validateInteractionResultValue(result, input, {
        reply: '好的',
        screenshot: 'data:image/png;base64,...',
      }).map((issue) => issue.code),
    ).toContain('unknown-field');
  });

  it('超出长度上限被拒', () => {
    expect(
      validateInteractionResultValue(result, input, { reply: 'x'.repeat(101) }).map(
        (issue) => issue.code,
      ),
    ).toContain('too-long');
  });

  it('单选值必须来自已渲染的选项', () => {
    expect(
      validateInteractionResultValue(result, input, { reply: '好的', intent: 'hack' }).map(
        (issue) => issue.code,
      ),
    ).toContain('not-an-option');
  });
});
