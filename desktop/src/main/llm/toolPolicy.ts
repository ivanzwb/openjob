/**
 * 一次对话该带哪套工具。
 *
 * 单独拎出来，是因为这条规则曾经把「指定了 repoId」写成关闭工具的条件：源码问答于是
 * 一个文件都读不到，只能拿项目摘要和模型自己对这个项目的印象作答，而系统提示又硬要求
 * 它给出 path:line 引用——编一条看着合理的路径是必然结果，用户点开就是「文件不存在」。
 * 一个方向写反的布尔表达式没人看得出来，所以每条分支都由用例钉住。
 */

export type ChatToolKind =
  /** 不注入任何工具，纯多轮对话 */
  | 'none'
  /** 源码 Agent：list_dir / read_file / grep，外加联网 */
  | 'code'
  /** 联网检索（有 campaign 时附带知识图谱） */
  | 'web'
  /** 只读写知识图谱，不产生外部调用 */
  | 'graph';

export interface ToolPolicyInput {
  allowTools?: boolean;
  allowWebSearch?: boolean;
  sessionKind?: string;
  repoId?: string;
  campaignId?: string | null;
}

export function decideToolKind(req: ToolPolicyInput, searchRequired = false): ChatToolKind {
  // 调用方显式说了不要就不给；没表态时只有考点追问默认不带工具
  const enabled = req.allowTools ?? req.sessionKind !== 'nodeFollowUp';
  if (!enabled) return 'none';
  // 源码问答的事实来源只有仓库本身，读代码的工具是它的前提，跟有没有开联网无关
  if (req.repoId) return 'code';
  if (req.allowWebSearch || searchRequired) return 'web';
  return req.campaignId ? 'graph' : 'none';
}
