import { useEffect, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import type { Explanation } from '@shared/entities';
import type { QuizSubmitResult, TaskView } from '@shared/ipc';
import { invokeRemote } from '../remote/rpc';
import { useRemoteTask } from '../context/RemoteTaskContext';
import { theme } from '../theme';

export function TaskStudyPanel({
  task,
  onComplete,
}: {
  task: TaskView;
  onComplete?: () => void;
}): React.JSX.Element {
  const { runTask } = useRemoteTask();
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [question, setQuestion] = useState<string | null>(null);
  const [answer, setAnswer] = useState('');
  const [quizResult, setQuizResult] = useState<QuizSubmitResult | null>(null);

  useEffect(() => {
    if (task.kind === 'readCode') {
      setContent(null);
      setLoading(false);
      return;
    }
    if (task.kind === 'drill' && task.nodeId) {
      let cancelled = false;
      setLoading(true);
      setQuestion(null);
      setQuizResult(null);
      setAnswer('');
      void invokeRemote<
        'quiz:question',
        { nodeId: string },
        { nodeId: string; nodeName: string; question: string }
      >('quiz:question', { nodeId: task.nodeId })
        .then(({ result }) => {
          if (!cancelled) setQuestion(result.question);
        })
        .catch((e) => {
          if (!cancelled) setContent(e instanceof Error ? e.message : String(e));
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
      return () => {
        cancelled = true;
      };
    }
    if (!task.nodeId) {
      setContent('该任务无关联考点');
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setContent(null);
    void (async () => {
      try {
        const tier = task.kind === 'fallbackScript' ? 'oneliner' : 'spoken';
        const { result: cached } = await invokeRemote<
          'explain:get',
          { nodeId: string; tier: string },
          Explanation | null
        >('explain:get', { nodeId: task.nodeId!, tier });
        if (cancelled) return;
        if (cached?.contentMd) {
          setContent(cached.contentMd);
          return;
        }
        if (task.kind === 'fallbackScript') {
          const { result } = await invokeRemote<'explain:fallback', { nodeId: string }, Explanation>(
            'explain:fallback',
            { nodeId: task.nodeId! },
          );
          if (!cancelled) setContent(result.contentMd);
          return;
        }
        const generated = await runTask('生成讲解', async () => {
          const { result } = await invokeRemote<
            'explain:generate',
            { nodeId: string; tier: string },
            Explanation
          >('explain:generate', { nodeId: task.nodeId!, tier });
          return result;
        });
        if (!cancelled) setContent(generated.contentMd);
      } catch (e) {
        if (!cancelled) setContent(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [task, runTask]);

  if (task.kind === 'readCode') {
    return (
      <Text style={{ color: theme.muted, fontSize: 13 }}>
        读源码任务请在桌面端完成：{task.repoUrl ?? task.repoId}
      </Text>
    );
  }

  if (task.kind === 'drill' && task.nodeId) {
    if (loading) return <Text style={{ color: theme.muted, fontSize: 13 }}>出题中…</Text>;
    return (
      <View style={{ gap: 8 }}>
        {question && <Text style={{ color: theme.text, fontSize: 13, lineHeight: 20 }}>{question}</Text>}
        {!quizResult ? (
          <>
            <TextInput
              multiline
              value={answer}
              onChangeText={setAnswer}
              placeholder="口述你的回答…"
              placeholderTextColor={theme.muted}
              style={{
                minHeight: 100,
                color: theme.text,
                borderWidth: 1,
                borderColor: theme.border,
                borderRadius: 8,
                padding: 10,
                textAlignVertical: 'top',
              }}
            />
            <Pressable
              onPress={() => {
                if (!task.nodeId || !question || !answer.trim()) return;
                void runTask('考我评分', async () => {
                  const { result } = await invokeRemote<
                    'quiz:submit',
                    { nodeId: string; question: string; userAnswer: string },
                    QuizSubmitResult
                  >('quiz:submit', {
                    nodeId: task.nodeId!,
                    question,
                    userAnswer: answer.trim(),
                  });
                  setQuizResult(result);
                  onComplete?.();
                });
              }}
              disabled={!answer.trim()}
              style={{
                backgroundColor: theme.accent,
                padding: 10,
                borderRadius: 8,
                alignItems: 'center',
                opacity: !answer.trim() ? 0.6 : 1,
              }}
            >
              <Text style={{ color: '#fff' }}>提交评分</Text>
            </Pressable>
          </>
        ) : (
          <View style={{ gap: 6 }}>
            <Text style={{ color: theme.success, fontWeight: '600' }}>得分 {quizResult.attempt.score}/5</Text>
            <Text style={{ color: theme.text, fontSize: 13 }}>{quizResult.attempt.feedbackMd}</Text>
          </View>
        )}
      </View>
    );
  }

  if (!task.nodeId) {
    return <Text style={{ color: theme.muted, fontSize: 13 }}>该任务无关联考点</Text>;
  }

  if (loading) return <Text style={{ color: theme.muted, fontSize: 13 }}>加载讲解…</Text>;

  return (
    <View style={{ gap: 8 }}>
      <Text style={{ color: theme.text, fontSize: 13, lineHeight: 20 }}>
        {content ?? '暂无讲解'}
      </Text>
      {onComplete && (
        <Pressable onPress={onComplete} style={{ alignSelf: 'flex-start', padding: 6 }}>
          <Text style={{ color: theme.accent, fontSize: 12 }}>标记完成</Text>
        </Pressable>
      )}
    </View>
  );
}
