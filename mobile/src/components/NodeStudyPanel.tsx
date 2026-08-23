import type { QuizAnswerResult, QuizSubmitResult } from '@shared/ipc';
import { ExplanationStudyPanel } from './ExplanationStudyPanel';
import { MarkdownPreview } from './MarkdownPreview';
import { getRawDb } from '../db';
import { generateQuizAnswer, generateQuizQuestion, submitQuizAnswer } from '../data/quizLocal';
import { saveSpeechFromQuizNode } from '../data/mutations';
import { useApp } from '../context/AppContext';
import { isTaskRunning, runTask, useTaskResult, useTaskState } from '../context/RemoteTaskContext';
import { useTheme } from '../theme';
import { useEffect, useState } from 'react';
import { Alert, Pressable, Text, TextInput, View } from 'react-native';
import { VoiceInputButton } from './VoiceInputButton';

export function NodeStudyPanel({
  nodeId,
  nodeName,
  mode,
}: {
  nodeId: string;
  nodeName: string;
  mode: 'explain' | 'drill';
}): React.JSX.Element {
  const theme = useTheme();
  const { notifyDataChanged } = useApp();
  // 出题、参考答案与评分都按考点记：换考点、切页再回来还是这道题和这份评分
  const questionKey = `quiz:question:${nodeId}`;
  const answerKey = `quiz:answer:${nodeId}`;
  const submitKey = `quiz:submit:${nodeId}`;
  const { running: loading, error: questionError } = useTaskState(questionKey);
  const { running: generatingAnswer, error: answerError } = useTaskState(answerKey);
  const { running: submitting, error: submitError } = useTaskState(submitKey);
  const [question, setQuestion] = useState<string | null>(null);
  const [answer, setAnswer] = useState('');
  const [quizResult, setQuizResult] = useState<QuizSubmitResult | null>(null);
  const [recommended, setRecommended] = useState('');
  const [editingRecommended, setEditingRecommended] = useState(false);

  useTaskResult<{ question: string }>(questionKey, (result) => setQuestion(result.question));
  useTaskResult<QuizAnswerResult>(answerKey, (result) => {
    setRecommended(result.recommendedAnswerMd);
    setEditingRecommended(false);
  });
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
    return (
      <Text selectable style={{ color: theme.danger, fontSize: 13 }}>
        {questionError}
      </Text>
    );
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

  const generateRecommended = (): void => {
    if (!question) return;
    const asked = question;
    void runTask(answerKey, '生成推荐答案', () =>
      generateQuizAnswer(getRawDb(), nodeId, asked),
    ).catch(() => undefined);
  };

  const saveRecommendedToSpeech = (): void => {
    const text = recommended.trim();
    if (!text) return;
    void saveSpeechFromQuizNode(getRawDb(), nodeId, text).then((saved) => {
      notifyDataChanged();
      setEditingRecommended(false);
      Alert.alert('话术库', saved.existing ? '这段已经在话术库里' : '已加入话术库');
    });
  };

  return (
    <View style={{ gap: 8 }}>
      {question && (
        <Text selectable style={{ color: theme.text, fontSize: 13, lineHeight: 20 }}>
          {question}
        </Text>
      )}
      {!quizResult ? (
        <>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end' }}>
            <VoiceInputButton onTranscript={(text) => setAnswer((prev) => prev + text)} />
          </View>
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
          {submitError !== null && (
            <Text selectable style={{ color: theme.danger, fontSize: 12 }}>
              {submitError}
            </Text>
          )}
        </>
      ) : (
        <View style={{ gap: 6 }}>
          <Text style={{ color: theme.success, fontWeight: '600' }}>得分 {quizResult.attempt.score}/5</Text>
          <Text selectable style={{ color: theme.text, fontSize: 13 }}>
            {quizResult.attempt.feedbackMd}
          </Text>
        </View>
      )}

      {question && (
        <View style={{ gap: 8, borderTopWidth: 1, borderColor: theme.border, paddingTop: 10 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Text style={{ color: theme.text, fontWeight: '600', fontSize: 13 }}>推荐答案</Text>
            <View style={{ flexDirection: 'row', gap: 12 }}>
              <Pressable onPress={generateRecommended} disabled={generatingAnswer} hitSlop={8}>
                <Text style={{ color: generatingAnswer ? theme.muted : theme.accent, fontSize: 11 }}>
                  {generatingAnswer ? '生成中…' : recommended ? '重新生成' : '生成推荐答案'}
                </Text>
              </Pressable>
              {recommended ? (
                <Pressable onPress={() => setEditingRecommended((v) => !v)} hitSlop={8}>
                  <Text style={{ color: theme.accent, fontSize: 11 }}>
                    {editingRecommended ? '预览' : '编辑'}
                  </Text>
                </Pressable>
              ) : null}
            </View>
          </View>
          {answerError !== null && (
            <Text selectable style={{ color: theme.danger, fontSize: 12 }}>
              {answerError}
            </Text>
          )}
          {recommended ? (
            <>
              {editingRecommended ? (
                <TextInput
                  multiline
                  value={recommended}
                  onChangeText={setRecommended}
                  style={{
                    minHeight: 140,
                    color: theme.text,
                    borderWidth: 1,
                    borderColor: theme.border,
                    borderRadius: 8,
                    padding: 10,
                    textAlignVertical: 'top',
                    fontFamily: 'monospace',
                    fontSize: 12,
                  }}
                />
              ) : (
                <MarkdownPreview text={recommended} />
              )}
              <Pressable onPress={saveRecommendedToSpeech} hitSlop={8}>
                <Text style={{ color: theme.accent, fontSize: 11 }}>加入话术库</Text>
              </Pressable>
            </>
          ) : (
            <Text style={{ color: theme.muted, fontSize: 12 }}>
              答不上来可以先要一份参考答案，改成自己的说法后加入话术库。
            </Text>
          )}
        </View>
      )}
    </View>
  );
}
