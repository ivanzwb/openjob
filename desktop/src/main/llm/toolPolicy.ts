/**
 * 一次对话该带哪套工具。
 *
 * 单独拎出来，是因为这套判定曾经写反过：某条分支把「显式关掉工具」也放行了，
 * 于是模型拿不到任何工具，只能拿项目摘要和自己对这个项目的印象作答，而系统提示
 * 又硬要求它给出 path:line 引用——编一条看着合理的路径是必然结果，用户点开就是
 * 「文件不存在」。一个方向写反的布尔表达式没人看得出来，所以每条分支都由用例钉住。
 */

export type ChatToolKind =
  /** 不注入任何工具，纯多轮对话 */
  | 'none'
  /** 联网检索（有 campaign 时附带知识图谱） */
  | 'web'
  /** 只读写知识图谱，不产生外部调用 */
  | 'graph';

export interface ToolPolicyInput {
  allowTools?: boolean;
  allowWebSearch?: boolean;
  sessionKind?: string;
  campaignId?: string | null;
}

export function decideToolKind(req: ToolPolicyInput, searchRequired = false): ChatToolKind {
  // 调用方显式说了不要就不给；没表态时只有考点追问默认不带工具
  const enabled = req.allowTools ?? req.sessionKind !== 'nodeFollowUp';
  if (!enabled) return 'none';
  if (req.allowWebSearch || searchRequired) return 'web';
  return req.campaignId ? 'graph' : 'none';
}
