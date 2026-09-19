/**
 * 代码插件的**话术库与标记原语**宿主实现（`library:write`）。
 *
 * 话术库是宿主拥有的用户面（`speech_snippet`），标记汇总是宿主的跨功能标记面
 * （`annotation`）；包只往里存、只按自己起的取值取回自己存过的那几条。这一层只做一件
 * 额外的事：**授权来自声明**——调用方只有在自己 manifest 里声明过 `library:write` 才能
 * 存/取，宿主不认识任何具体来源取值或目标取值。
 *
 * 与其它原语同一条方向：未声明在读任何状态之前就被拒。桌面渲染层的 IPC 处理器与手机端
 * 的 RPC 处理器共用这里，两处逐次校验，不把授权只留在端侧。
 */
import type { ExplanationTier } from '@core/enums';
import type { LibraryAnnotation, LibrarySnippet } from '@core/plugins/pluginRuntime/host';
import { listLibrarySnippets, saveLibrarySnippet } from '../speech';
import {
  createExternalAnnotation,
  deleteAnnotation,
  listExternalAnnotations,
} from '../annotation';
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

/**
 * 把包自己的标记写进宿主的**跨功能标记汇总**（annotation 表）。
 *
 * 目标类型（targetKind）与标签都由包给，宿主不认识；写进去之后它就是一条普通的标记，
 * 因而会出现在宿主的标记面板里——这正是「包内标记也要能被汇总」的那条通路。
 */
export function pluginLibraryAnnotate(
  pluginId: string,
  request: {
    targetKind: string;
    targetId: string;
    targetLabel?: string;
    kind: string;
    selectedText?: string;
    noteMd?: string;
    highlightColor?: string;
  },
): LibraryAnnotation {
  assertLibraryPermission(pluginId);
  const targetKind = request.targetKind.trim();
  if (!targetKind) throw new Error('标记目标类型为空');
  const targetId = request.targetId.trim();
  if (!targetId) throw new Error('标记目标为空');
  const kind = request.kind.trim();
  if (!kind) throw new Error('标记类型为空');
  return createExternalAnnotation({
    targetType: targetKind,
    targetId,
    targetLabel: request.targetLabel,
    kind,
    selectedText: request.selectedText,
    noteMd: request.noteMd,
    highlightColor: request.highlightColor,
  });
}

export function pluginLibraryListAnnotations(
  pluginId: string,
  query: { targetKind?: string; limit?: number },
): LibraryAnnotation[] {
  assertLibraryPermission(pluginId);
  return listExternalAnnotations({ targetType: query.targetKind, limit: query.limit });
}

export function pluginLibraryDeleteAnnotation(pluginId: string, id: string): void {
  assertLibraryPermission(pluginId);
  deleteAnnotation(id);
}
