import type { QuizAnswerResult, QuizQuestionResult, QuizSubmitResult } from '@shared/ipc';
import { ExplanationStudyPanel } from './ExplanationStudyPanel';
import { MarkdownPreview } from './MarkdownPreview';
import { getRawDb } from '../db';
import {
  generateQuizAnswer,
  generateQuizQuestion,
  getQuizDraft,
  submitQuizAnswer,
  updateQuizDraft,
} from '../data/quizLocal';
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
  const [draftLoaded, setDraftLoaded] = useState(false);

  useEffect(() => {
    if (mode !== 'drill') return;
    try {
      const draft = getQuizDraft(getRawDb(), nodeId);
      if (draft.questionMd) setQuestion(draft.questionMd);
      if (draft.recommendedAnswerMd) setRecommended(draft.recommendedAnswerMd);
    } finally {
      setDraftLoaded(true);
    }
  }, [mode, nodeId]);

  useTaskResult<QuizQuestionResult>(questionKey, (result) => {
    setQuestion(result.question);
    setQuizResult(null);
    setAnswer('');
    setRecommended('');
    setEditingRecommended(false);
  });
  useTaskResult<QuizAnswerResult>(answerKey, (result) => {
    setRecommended(result.recommendedAnswerMd);
    setEditingRecommended(false);
  });
  useTaskResult<QuizSubmitResult>(submitKey, setQuizResult);

  if (mode === 'explain') {
    return <ExplanationStudyPanel nodeId={nodeId} nodeName={nodeName} tier="spoken" />;
  }

  if (!draftLoaded) {
    return <Text style={{ color: theme.muted, fontSize: 13 }}>加载中…</Text>;
  }

  const startQuiz = (): void => {
    void runTask(questionKey, '考我出题', async () => {
      const result = await generateQuizQuestion(getRawDb(), nodeId);
      notifyDataChanged();
      return result;
    }).catch(() => undefined);
  };

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
    void runTask(answerKey, '生成推荐答案', async () => {
      const result = await generateQuizAnswer(getRawDb(), nodeId, asked);
      notifyDataChanged();
      return result;
    }).catch(() => undefined);
  };

  const saveRecommendedDraft = (): void => {
    void updateQuizDraft(getRawDb(), { nodeId, recommendedAnswerMd: recommended }).then(() => {
      notifyDataChanged();
      setEditingRecommended(false);
      Alert.alert('已保存', '推荐答案已保存');
    });
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
      <Pressable
        onPress={startQuiz}
        disabled={loading || isTaskRunning(questionKey)}
        style={{
          backgroundColor: theme.accent,
          padding: 10,
          borderRadius: 8,
          alignItems: 'center',
          opacity: loading || isTaskRunning(questionKey) ? 0.6 : 1,
        }}
      >
        <Text style={{ color: '#fff' }}>
          {loading || isTaskRunning(questionKey) ? '出题中…' : question ? '重新出题' : '开始出题'}
        </Text>
      </Pressable>
      <Text style={{ color: theme.muted, fontSize: 11 }}>
        已生成的题目与推荐答案会自动保存；再次进入会直接显示，只有点「重新出题」才会换题。
      </Text>
      {questionError !== null && (
        <Text selectable style={{ color: theme.danger, fontSize: 12 }}>
          {questionError}
        </Text>
      )}

      {question && <MarkdownPreview text={question} />}
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
        <View style={{ gap: 8 }}>
          <Text style={{ color: theme.success, fontWeight: '600' }}>得分 {quizResult.attempt.score}/5</Text>
          <MarkdownPreview text={quizResult.attempt.feedbackMd} />
          {quizResult.attempt.improvedScriptMd?.trim() ? (
            <View style={{ gap: 4 }}>
              <Text style={{ color: theme.muted, fontSize: 11 }}>改进话术</Text>
              <MarkdownPreview text={quizResult.attempt.improvedScriptMd!} />
            </View>
          ) : null}
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
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
                {editingRecommended && (
                  <Pressable onPress={saveRecommendedDraft} hitSlop={8}>
                    <Text style={{ color: theme.accent, fontSize: 11 }}>保存</Text>
                  </Pressable>
                )}
                <Pressable onPress={saveRecommendedToSpeech} hitSlop={8}>
                  <Text style={{ color: theme.accent, fontSize: 11 }}>加入话术库</Text>
                </Pressable>
              </View>
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
