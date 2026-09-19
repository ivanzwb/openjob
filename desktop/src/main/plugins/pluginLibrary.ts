/**
 * 代码插件的**话术库原语**宿主实现（`library:write`）。
 *
 * 话术库是宿主拥有的用户面（`speech_snippet`）；包只往里存、只按自己起的 `sourceKind`
 * 取回自己存过的那几条。这一层只做一件额外的事：**授权来自声明**——调用方只有在自己
 * manifest 里声明过 `library:write` 才能存/取，宿主不认识任何具体来源取值。
 *
 * 与其它原语同一条方向：未声明在读任何状态之前就被拒。桌面渲染层的 IPC 处理器与手机端
 * 的 RPC 处理器共用这里，两处逐次校验，不把授权只留在端侧。
 */
import type { ExplanationTier } from '@core/enums';
import type { LibrarySnippet } from '@core/plugins/pluginRuntime/host';
import { listLibrarySnippets, saveLibrarySnippet } from '../speech';
import { listExternalPlugins } from './runtime';

/** 声明即授权：本机已装且带代码入口、manifest 里声明过 library:write 的包才放行。 */
function assertLibraryPermission(pluginId: string): void {
  const entry = listExternalPlugins().find(
    (item) =>
      item.package.manifest.id === pluginId && item.package.manifest.main !== undefined,
  );
  if (!entry?.package.manifest.permissions.includes('library:write')) {
    throw new Error(`插件 ${pluginId} 未声明 library:write 权限`);
  }
}

export function pluginLibrarySave(
  pluginId: string,
  request: { text: string; sourceKind: string; sourceLabel: string; tier?: ExplanationTier },
): LibrarySnippet {
  assertLibraryPermission(pluginId);
  return saveLibrarySnippet(request.sourceKind, request.sourceLabel, request.text, request.tier);
}

export function pluginLibraryList(
  pluginId: string,
  query: { sourceKind?: string; limit?: number },
): LibrarySnippet[] {
  assertLibraryPermission(pluginId);
  return listLibrarySnippets(query.sourceKind, query.limit);
}
