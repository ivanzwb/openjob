import type { TaskView } from '@shared/ipc';
import { ExplanationPanel } from './ExplanationPanel';
import { QuizPanel } from './QuizPanel';
import { ReadCodePanel } from './ReadCodePanel';

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
  if (task) {
    if (task.kind === 'readCode' && task.repoId) {
      return (
        <ReadCodePanel
          key={task.repoId}
          repoId={task.repoId}
          onComplete={onComplete ?? (() => undefined)}
        />
      );
    }
    if (!task.nodeId) {
      return <p className="text-sm text-[var(--color-muted)]">该任务无关联考点</p>;
    }
    if (task.kind === 'drill') {
      return (
        <QuizPanel
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
