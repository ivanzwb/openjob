import type { QuizSubmitResult } from '@shared/ipc';
import { ExplanationStudyPanel } from './ExplanationStudyPanel';
import { getRawDb } from '../db';
import { generateQuizQuestion, submitQuizAnswer } from '../data/quizLocal';
import { useApp } from '../context/AppContext';
import { useRemoteTask } from '../context/RemoteTaskContext';
import { theme } from '../theme';
import { useEffect, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

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
  const { notifyDataChanged } = useApp();
  const [loading, setLoading] = useState(false);
  const [question, setQuestion] = useState<string | null>(null);
  const [answer, setAnswer] = useState('');
  const [quizResult, setQuizResult] = useState<QuizSubmitResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (mode !== 'drill') return;
    let cancelled = false;
    setLoading(true);
    setQuestion(null);
    setQuizResult(null);
    setAnswer('');
    setError(null);
    void generateQuizQuestion(getRawDb(), nodeId)
      .then((result) => {
        if (!cancelled) setQuestion(result.question);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [nodeId, mode]);

  if (mode === 'explain') {
    return <ExplanationStudyPanel nodeId={nodeId} nodeName={nodeName} tier="spoken" />;
  }

  if (loading) {
    return <Text style={{ color: theme.muted, fontSize: 13 }}>出题中…</Text>;
  }

  if (error) {
    return <Text style={{ color: '#f87171', fontSize: 13 }}>{error}</Text>;
  }

  async function submitQuiz(): Promise<void> {
    if (!question || !answer.trim()) return;
    try {
      const result = await runTask('考我评分', async () =>
        submitQuizAnswer(getRawDb(), nodeId, question, answer.trim()),
      );
      setQuizResult(result);
      notifyDataChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

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
            disabled={!answer.trim() || !question}
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
