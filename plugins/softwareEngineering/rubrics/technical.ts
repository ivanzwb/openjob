import type { RubricDefinition } from '@core/plugins/types';
import { anchors } from './anchors';

export const technicalKnowledgeRubric: RubricDefinition = {
  id: 'se.technical-knowledge-rubric',
  dimensions: [
    {
      id: 'technical-accuracy',
      label: '技术准确性',
      weight: 0.5,
      critical: true,
      anchors: anchors(
        '核心结论错误或自相矛盾',
        '结论部分正确，但关键机制解释错误',
        '结论正确，能解释主要机制',
        '准确解释机制、边界和常见陷阱',
        '能从机制推导边界并比较实际取舍',
      ),
    },
    {
      id: 'depth',
      label: '原理深度',
      weight: 0.3,
      anchors: anchors(
        '停留在术语复述',
        '只能回答定义，无法承接追问',
        '能回答一层原理追问',
        '能连接实现细节与实际影响',
        '能跨层分析并指出版本或场景差异',
      ),
    },
    {
      id: 'tradeoffs',
      label: '工程取舍',
      weight: 0.2,
      anchors: anchors(
        '把方案描述为无条件最优',
        '知道存在取舍但无法说明',
        '能说出主要优缺点',
        '能结合约束选择方案',
        '能量化约束并说明决策边界',
      ),
    },
  ],
  passThreshold: 3,
  failConditions: ['技术准确性为 1 分'],
};

export const codingRubric: RubricDefinition = {
  id: 'se.coding-rubric',
  dimensions: [
    {
      id: 'correctness',
      label: '正确性',
      weight: 0.4,
      critical: true,
      anchors: anchors(
        '没有可执行解法',
        '只能通过少量基本样例',
        '主要逻辑正确，遗漏少量边界',
        '解法正确并覆盖关键边界',
        '解法正确、简洁且验证充分',
      ),
    },
    {
      id: 'complexity',
      label: '复杂度与方案选择',
      weight: 0.25,
      anchors: anchors(
        '无法分析复杂度',
        '复杂度判断明显错误',
        '能正确说明主要时间和空间复杂度',
        '能比较方案并选择合理复杂度',
        '能证明关键界限并识别实际性能因素',
      ),
    },
    {
      id: 'edge-cases-and-testing',
      label: '边界与测试',
      weight: 0.2,
      anchors: anchors(
        '不检查样例或边界',
        '只能覆盖题目给出的样例',
        '能识别常见空值和边界输入',
        '主动构造分类测试并修正缺陷',
        '用不变量和系统化测试验证实现',
      ),
    },
    {
      id: 'implementation-clarity',
      label: '实现表达',
      weight: 0.15,
      anchors: anchors(
        '思路和代码均难以理解',
        '代码可运行但结构混乱',
        '能边写边解释主要步骤',
        '命名清晰，主动说明关键决策',
        '表达简洁，能根据反馈快速调整实现',
      ),
    },
  ],
  passThreshold: 3,
  failConditions: ['正确性为 1 分'],
};
