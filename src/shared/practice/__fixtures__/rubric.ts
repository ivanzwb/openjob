/**
 * 一个两维度的小量规。
 *
 * 校验逻辑的用例需要能一眼看出「哪一维该过、哪一维该挂」，内置岗位包的四维量规
 * 做不到这点；涉及「真实岗位包能不能被引擎解析」的用例才用内置包。
 */
import type { RubricDefinition } from '../../plugins/types';

function anchors(a1: string, a2: string, a3: string, a4: string, a5: string) {
  return { 1: a1, 2: a2, 3: a3, 4: a4, 5: a5 } as const;
}

export const TEST_RUBRIC: RubricDefinition = {
  id: 'test.rubric',
  dimensions: [
    {
      id: 'accuracy',
      label: '准确性',
      weight: 0.6,
      critical: true,
      anchors: anchors('结论错误', '有明显硬伤', '基本正确', '正确且有取舍', '正确并能说明边界'),
    },
    {
      id: 'structure',
      label: '结构',
      weight: 0.4,
      anchors: anchors('无组织', '有罗列无主线', '主线清楚', '分层清楚', '分层且详略得当'),
    },
  ],
  passThreshold: 3,
};

/** 未声明 passThreshold，用来验证默认阈值 */
export const NO_THRESHOLD_RUBRIC: RubricDefinition = {
  id: 'test.rubric.no-threshold',
  dimensions: TEST_RUBRIC.dimensions,
};

export const ANSWER_MD = [
  '# 我的回答',
  '',
  'B+ 树的非叶子节点只存键，所以扇出更大，三层就能覆盖上千万行。',
  '回表的代价来自随机 IO，覆盖索引可以避免。',
].join('\n');
