import type { RubricDefinition } from '@core/plugins/types';
import { anchors } from './anchors';
import { SALES_CUSTOMER_SUCCESS_RUBRIC_IDS } from '../ids';

/**
 * 两份量规都不含技术准确性、吞吐、容量这类工程口径。
 *
 * 对话量规按计划取倾听、澄清、应变、推进四维：它们衡量的是一次真实对话里能被
 * 观察到的东西，与行为面看「过去做过什么、口径是否可追溯」是两回事，所以维度名
 * 与行为面不重叠——同名会让两种题型的历史分被放在一起比较。
 */
export const rolePlayRubric: RubricDefinition = {
  id: SALES_CUSTOMER_SUCCESS_RUBRIC_IDS.rolePlay,
  dimensions: [
    {
      id: 'listening',
      label: '倾听与信息接收',
      weight: 0.25,
      critical: true,
      anchors: anchors(
        '客户给出的信息被完全忽略，按预设话术推进',
        '能复述客户原话，但不影响下一句怎么说',
        '能接住关键信息并据此调整方向',
        '能听出客户没直说的顾虑并加以确认',
        '能分辨客户话里的事实、判断与情绪，并分别处理',
      ),
    },
    {
      id: 'clarifying',
      label: '澄清与提问质量',
      weight: 0.25,
      anchors: anchors(
        '不提问，或只问能用是否回答的问题',
        '提问零散，问完仍说不清客户处境',
        '提问在逐步缩小范围',
        '能围绕决策链和替代方案系统地问',
        '能用一个问题同时验证需求真实性与紧迫性',
      ),
    },
    {
      id: 'adaptability',
      label: '应变与立场处理',
      weight: 0.25,
      anchors: anchors(
        '被顶回来就让价或转移话题',
        '重复原话，不换角度',
        '能针对当下的顾虑给出新回应',
        '能区分真异议与借口，分别应对',
        '能在被否定后重新建立共同前提再推进',
      ),
    },
    {
      id: 'advancing',
      label: '推进与下一步',
      weight: 0.25,
      anchors: anchors(
        '对话结束时没有任何约定',
        '只留下「保持联系」这类模糊承诺',
        '拿到一个明确的下一步动作',
        '下一步带时间、参与人和交付物',
        '下一步与客户内部流程对齐，并留了推进的抓手',
      ),
    },
  ],
  passThreshold: 3,
  failConditions: ['倾听与信息接收为 1 分'],
};

export const behavioralRubric: RubricDefinition = {
  id: SALES_CUSTOMER_SUCCESS_RUBRIC_IDS.behavioral,
  dimensions: [
    {
      id: 'customer-diagnosis-depth',
      label: '客户诊断深度',
      weight: 0.3,
      critical: true,
      anchors: anchors(
        '说不出客户是谁、卡在哪一步',
        '只描述客户行业和规模',
        '能说清客户处境、预算与决策人',
        '能还原客户的替代方案和不采购的后果',
        '能说明当初判断偏在哪，以及靠哪个提问纠正过来',
      ),
    },
    {
      id: 'value-translation',
      label: '价值翻译',
      weight: 0.25,
      anchors: anchors(
        '只罗列产品功能',
        '有收益表述但与客户目标无关',
        '能把能力对应到客户的业务收益',
        '能按不同角色分别组织价值口径',
        '能用客户自己的考核指标来表述收益',
      ),
    },
    {
      id: 'trust-and-objection',
      label: '信任与异议',
      weight: 0.2,
      anchors: anchors(
        '面对质疑只会让价',
        '能回应质疑但不处理背后的顾虑',
        '能复述顾虑并给出针对性回应',
        '能用第三方证据或试点降低对方风险',
        '能在长期关系与本次成交之间做出取舍并说明理由',
      ),
    },
    {
      id: 'result-attribution',
      label: '结果与归因',
      weight: 0.25,
      anchors: anchors(
        '业绩表述没有任何口径',
        '给出数字但说不出周期和分母',
        '业绩口径清楚，可追溯',
        '能分清自己的动作与市场、产品带来的影响',
        '能从丢掉的单子里提炼出已经改进的具体动作',
      ),
    },
  ],
  passThreshold: 3,
  failConditions: ['客户诊断深度为 1 分'],
};
