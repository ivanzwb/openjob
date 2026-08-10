import { useEffect, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import type { Explanation } from '@shared/entities';
import type { QuizSubmitResult } from '@shared/ipc';
import { invokeRemote } from '../remote/rpc';
import { useRemoteTask } from '../context/RemoteTaskContext';
import { theme } from '../theme';

export function NodeStudyPanel({
  nodeId,
  nodeName,
  mode,
}: {
  nodeId: string;
  nodeName: string;
  mode: 'explain' | 'drill';
}): React.JSX.Element {
  const { runTask } = useRemoteTask();
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [question, setQuestion] = useState<string | null>(null);
  const [answer, setAnswer] = useState('');
  const [quizResult, setQuizResult] = useState<QuizSubmitResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setContent(null);
    setQuestion(null);
    setQuizResult(null);
    setAnswer('');

    void (async () => {
      try {
        if (mode === 'explain') {
          const { result: cached } = await invokeRemote<
            'explain:get',
            { nodeId: string; tier: string },
            Explanation | null
          >('explain:get', { nodeId, tier: 'spoken' });
          if (cancelled) return;
          if (cached?.contentMd) {
            setContent(cached.contentMd);
            return;
          }
          const generated = await runTask('生成讲解', async () => {
            const { result } = await invokeRemote<
              'explain:generate',
              { nodeId: string; tier: string },
              Explanation
            >('explain:generate', { nodeId, tier: 'spoken' });
            return result;
          });
          if (!cancelled) setContent(generated.contentMd);
        } else {
          const { result } = await invokeRemote<
            'quiz:question',
            { nodeId: string },
            { nodeId: string; nodeName: string; question: string }
          >('quiz:question', { nodeId });
          if (!cancelled) setQuestion(result.question);
        }
      } catch (e) {
        if (!cancelled) setContent(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [nodeId, mode, runTask]);

  const submitQuiz = async (): Promise<void> => {
    if (!question || !answer.trim()) return;
    try {
      const result = await runTask('考我评分', async () => {
        const { result: scored } = await invokeRemote<
          'quiz:submit',
          { nodeId: string; question: string; userAnswer: string },
          QuizSubmitResult
        >('quiz:submit', { nodeId, question, userAnswer: answer.trim() });
        return scored;
      });
      setQuizResult(result);
    } catch (e) {
      setContent(e instanceof Error ? e.message : String(e));
    }
  };

  if (loading) {
    return <Text style={{ color: theme.muted, fontSize: 13 }}>{mode === 'explain' ? '加载讲解…' : '出题中…'}</Text>;
  }

  if (mode === 'drill') {
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
              onPress={() => void submitQuiz()}
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

  return (
    <Text style={{ color: theme.text, fontSize: 13, lineHeight: 20 }}>
      {content ?? `暂无「${nodeName}」的讲解`}
    </Text>
  );
}
