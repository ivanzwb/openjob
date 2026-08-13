import type { QuizSubmitResult } from '@shared/ipc';
import { ExplanationStudyPanel } from './ExplanationStudyPanel';
import { getRawDb } from '../db';
import { generateQuizQuestion, submitQuizAnswer } from '../data/quizLocal';
import { useApp } from '../context/AppContext';
import { isTaskRunning, runTask, useTaskResult, useTaskState } from '../context/RemoteTaskContext';
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
  const { notifyDataChanged } = useApp();
  // 出题与评分都按考点记：换考点、切页再回来还是这道题和这份评分
  const questionKey = `quiz:question:${nodeId}`;
  const submitKey = `quiz:submit:${nodeId}`;
  const { running: loading, error: questionError } = useTaskState(questionKey);
  const { running: submitting, error: submitError } = useTaskState(submitKey);
  const [question, setQuestion] = useState<string | null>(null);
  const [answer, setAnswer] = useState('');
  const [quizResult, setQuizResult] = useState<QuizSubmitResult | null>(null);

  useTaskResult<{ question: string }>(questionKey, (result) => setQuestion(result.question));
  useTaskResult<QuizSubmitResult>(submitKey, setQuizResult);

  useEffect(() => {
    // 已经在出题、或题目还没被领走时不要重复问一遍
    if (mode !== 'drill' || question !== null || isTaskRunning(questionKey)) return;
    void runTask(questionKey, '考我出题', () => generateQuizQuestion(getRawDb(), nodeId)).catch(
      () => undefined,
    );
  }, [mode, nodeId, questionKey, question]);

  if (mode === 'explain') {
    return <ExplanationStudyPanel nodeId={nodeId} nodeName={nodeName} tier="spoken" />;
  }

  if (loading && question === null) {
    return <Text style={{ color: theme.muted, fontSize: 13 }}>出题中…</Text>;
  }

  if (questionError !== null && question === null) {
    return <Text style={{ color: '#f87171', fontSize: 13 }}>{questionError}</Text>;
  }

  const submitQuiz = (): void => {
    if (!question || !answer.trim()) return;
    const payload = { question, answer: answer.trim() };
    void runTask(submitKey, '考我评分', async () => {
      const result = await submitQuizAnswer(getRawDb(), nodeId, payload.question, payload.answer);
      notifyDataChanged();
      return result;
    }).catch(() => undefined);
  };

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
            onPress={submitQuiz}
            disabled={!answer.trim() || !question || submitting}
            style={{
              backgroundColor: theme.accent,
              padding: 10,
              borderRadius: 8,
              alignItems: 'center',
              opacity: !answer.trim() || submitting ? 0.6 : 1,
            }}
          >
            <Text style={{ color: '#fff' }}>{submitting ? '评分中…' : '提交评分'}</Text>
          </Pressable>
          {submitError !== null && <Text style={{ color: theme.danger, fontSize: 12 }}>{submitError}</Text>}
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
