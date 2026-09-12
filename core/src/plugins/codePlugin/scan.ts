/**
 * 代码插件的静态隔离扫描（§13.4 准入第二层）。
 *
 * 插件入口进程内直跑，没有硬沙箱——这层扫描直接不放过带宿主越权能力的包：
 * Node 内建模块、子进程、环境变量、直连数据库、Electron 内部通道都不允许出现在
 * 入口与 Webview 资产里。插件代码只允许依赖 `openjob.*` 门面与自身纯逻辑。
 *
 * 静态扫描不是唯一边界，是第一道闸：它挡「明知故犯」和「顺手抄来的依赖」，
 * 真正的运行期收敛靠 API 门面只暴露白名单命名空间。
 */

export interface IsolationViolation {
  path: string;
  pattern: string;
  reason: string;
}

interface ForbiddenPattern {
  pattern: RegExp;
  reason: string;
}

const FORBIDDEN: readonly ForbiddenPattern[] = [
  { pattern: /\brequire\s*\(\s*['"]node:/, reason: 'Node 内建模块（node: 前缀）' },
  { pattern: /\brequire\s*\(\s*['"](fs|path|os|crypto|child_process|net|http|https|vm|worker_threads)['"]/,
    reason: 'Node 内建模块' },
  { pattern: /\bfrom\s+['"]node:/, reason: 'Node 内建模块（node: 前缀）' },
  { pattern: /\bfrom\s+['"](fs|path|os|crypto|child_process|net|http|https|vm|worker_threads)['"]/,
    reason: 'Node 内建模块' },
  { pattern: /\bchild_process\b/, reason: '子进程' },
  { pattern: /\bprocess\s*\.\s*(env|exit|kill|binding)/, reason: 'process 环境/控制' },
  { pattern: /\bglobalThis\s*\.\s*(process|require)\b/, reason: '全局 process/require' },
  { pattern: /\bbetter-sqlite3\b/, reason: '直连数据库驱动' },
  { pattern: /\b__dirname\b|\b__filename\b/, reason: '文件系统定位' },
  { pattern: /\belectron\b(?!-)/i, reason: 'Electron 内部通道（ipcRenderer/remote 等）' },
  { pattern: /\beval\s*\(/, reason: '动态求值' },
  { pattern: /new\s+Function\s*\(/, reason: '动态求值' },
  { pattern: /\bfetch\s*\(\s*['"`]/, reason: '不受控网络请求（请经 ctx 通道）' },
  { pattern: /XMLHttpRequest/, reason: '不受控网络请求（请经 ctx 通道）' },
];

/**
 * 扫描插件代码资产（入口 + Webview 资源）。全部违规一起返回，
 * 安装期一次性展示给发布者/用户，而不是挤牙膏式拒装。
 */
export function scanPluginSources(
  sources: Readonly<Record<string, string>>,
): IsolationViolation[] {
  const violations: IsolationViolation[] = [];
  for (const path of Object.keys(sources).sort()) {
    const text = sources[path] ?? '';
    for (const { pattern, reason } of FORBIDDEN) {
      if (pattern.test(text)) {
        violations.push({ path, pattern: pattern.source, reason });
      }
    }
  }
  return violations;
}
