import type { TaskView } from '@core/ipc';
import { ExplanationPanel } from './ExplanationPanel';
import { PluginRuntimeWebView } from './PluginRuntimeWebView';
import { QuizPanel } from './QuizPanel';
import { usePluginRuntimeTabs } from '../pluginRuntimes/runtime';

/**
 * 任务学习面板。
 *
 * 分派顺序：**任务声明的包页面**优先（岗位包在任务模板里用 `view.pageId` 声明），
 * 其次是宿主自己生成的那几种任务（drill → 口述练习，其余按考点讲解）。宿主不认识
 * 岗位包声明的任务种类，也不为它们写分支——任务页内容全部由包提供。
 */
export function TaskStudyPanel({
  task,
  nodeId,
  nodeName,
  onComplete,
  onAnnotationChange,
}: {
  task?: TaskView | null;
  nodeId?: string;
  nodeName?: string;
  onComplete?: () => void;
  onAnnotationChange?: () => void;
}): React.JSX.Element {
  const runtimes = usePluginRuntimeTabs();
  const page = task?.pageId
    ? runtimes
        .flatMap((plugin) => plugin.pages.map((item) => ({ plugin, item })))
        .find(({ item }) => item.id === task.pageId)
    : undefined;

  if (task && page) {
    return (
      <PluginRuntimeWebView
        key={`${task.id}:${page.item.fullId}`}
        pluginId={page.plugin.pluginId}
        version={page.plugin.version}
        webviewPath={page.item.webviewPath}
        permissions={page.plugin.permissions}
        declaredBridgeMethods={page.plugin.bridgeMethods}
      />
    );
  }

  if (task) {
    if (task.pageId) {
      return (
        <p className="text-sm text-[var(--color-muted)]">
          该任务页由岗位包提供，装上对应岗位包后即可使用
        </p>
      );
    }
    if (!task.nodeId) {
      return <p className="text-sm text-[var(--color-muted)]">该任务无关联考点</p>;
    }
    if (task.kind === 'drill') {
      return (
        <QuizPanel
          key={task.nodeId}
          nodeId={task.nodeId}
          nodeName={task.nodeName ?? ''}
          onDone={onComplete}
        />
      );
    }
    if (task.kind === 'fallbackScript') {
      return (
        <ExplanationPanel
          nodeId={task.nodeId}
          nodeName={task.nodeName ?? ''}
          fallbackMode
          onComplete={onComplete}
          onAnnotationChange={onAnnotationChange}
        />
      );
    }
    return (
      <ExplanationPanel
        nodeId={task.nodeId}
        nodeName={task.nodeName ?? ''}
        onComplete={onComplete}
        onAnnotationChange={onAnnotationChange}
      />
    );
  }

  if (nodeId) {
    return (
      <ExplanationPanel
        key={nodeId}
        nodeId={nodeId}
        nodeName={nodeName ?? ''}
        onAnnotationChange={onAnnotationChange}
      />
    );
  }

  return <p className="text-sm text-[var(--color-muted)]">选择考点或日历任务开始学习</p>;
}
