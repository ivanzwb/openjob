import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import type {
  CampaignSummary,
  DesignCaseResult,
  DesignSubmitResult,
  MockInterviewType,
} from '@shared/ipc';
import {
  MOCK_INTERVIEW_CONSTRAINTS_LABEL,
  MOCK_INTERVIEW_LANGUAGE_LABELS,
  MOCK_INTERVIEW_LANGUAGE_OPTIONS,
  MOCK_INTERVIEW_TYPE_LABELS,
  MOCK_INTERVIEW_TYPE_OPTIONS,
} from '@shared/ipc';
import { effectiveInterviewLanguage } from '@shared/design/prompts';
import type { MockInterviewKind, MockInterviewLanguage } from '@shared/design/prompts';
import { getRawDb } from '../db';
import { listCampaigns } from '../data/queries';
import {
  elaborateDesignAnswer,
  generateDesignCase,
  generateRecommendedAnswer,
  submitDesignAnswer,
  updateDesignCaseAnswers,
} from '../data/designLocal';
import { saveSpeechFromDesign } from '../data/mutations';
import { useApp } from '../context/AppContext';
import { runTask, useTaskResult, useTaskState } from '../context/RemoteTaskContext';
import { useLocalDataReload } from '../hooks/useLocalDataReload';
import { useTheme } from '../theme';
import { OverflowHintScrollView } from '../components/OverflowHintScrollView';
import { MarkdownPreview } from '../components/MarkdownPreview';
import { VoiceInputButton } from '../components/VoiceInputButton';

function campaignLabel(c: CampaignSummary): string {
  return `${c.company} · ${c.roleTitle}`;
}

const ANSWER_PLACEHOLDERS: Record<MockInterviewKind, Record<MockInterviewLanguage, string>> = {
  concept: {
    zh: '先给结论，再讲原理，最后补充 trade-off 和实际踩坑…',
    en: 'Start with the conclusion, explain the mechanism, then add trade-offs and examples...',
  },
  coding: {
    zh: '说明思路 → 核心代码/伪代码 → 复杂度 → 边界情况…',
    en: 'Explain your approach, core code or pseudocode, complexity, and edge cases...',
  },
  design: {
    zh: '需求澄清 → 高层架构 → 核心模块 → 扩展与权衡…',
    en: 'Clarify requirements, outline the architecture, key components, scaling, and trade-offs...',
  },
  scenario: {
    zh: '背景 → 你的职责 → 具体行动 → 结果与复盘…',
    en: 'Use STAR: situation, your role, actions, results, and lessons learned...',
  },
  selfIntro: {
    zh: '用 60-90 秒介绍你的背景、核心项目、技术亮点，以及为什么匹配这个岗位…',
    en: 'Give a 60-90 second intro covering your background, key projects, strengths, and role fit...',
  },
};

export function DesignScreen(): React.JSX.Element {
  const theme = useTheme();
  const { notifyDataChanged } = useApp();
  const [campaigns, setCampaigns] = useState<CampaignSummary[]>([]);
  const [campaignId, setCampaignId] = useState('');
  const [interviewType, setInterviewType] = useState<MockInterviewType>('mixed');
  const [interviewLanguage, setInterviewLanguage] = useState<MockInterviewLanguage>('zh');
  const [designCase, setDesignCase] = useState<DesignCaseResult | null>(null);
  const [answer, setAnswer] = useState('');
  const [recommendedAnswer, setRecommendedAnswer] = useState('');
  const [editingRecommended, setEditingRecommended] = useState(false);
  const [result, setResult] = useState<DesignSubmitResult | null>(null);
  const [elaborationMd, setElaborationMd] = useState<string | null>(null);

  const effectiveLang = useMemo(
    () => effectiveInterviewLanguage(interviewType, interviewLanguage),
    [interviewType, interviewLanguage],
  );

  const reload = useCallback(() => {
    const list = listCampaigns(getRawDb());
    setCampaigns(list);
    setCampaignId((prev) => {
      if (prev && list.some((c) => c.id === prev)) return prev;
      return list[0]?.id ?? '';
    });
  }, []);

  useLocalDataReload(reload);

  const caseKey = `design:case:${campaignId}:${interviewType}:${effectiveLang}`;
  const submitKey = `design:submit:${campaignId}`;
  const answerKey = `design:answer:${campaignId}:${interviewType}:${effectiveLang}`;
  const elaborateKey = `design:elaborate:${campaignId}`;
  const { running: loadingCase, error: caseError } = useTaskState(caseKey);
  const { running: submitting, error: submitError } = useTaskState(submitKey);
  const { running: generatingAnswer, error: answerError } = useTaskState(answerKey);
  const { running: elaborating, error: elaborateError } = useTaskState(elaborateKey);

  useTaskResult<DesignCaseResult>(caseKey, (res) => {
    setDesignCase(res);
    setResult(null);
    setAnswer(res.userAnswerMd ?? '');
    setRecommendedAnswer(res.recommendedAnswerMd ?? '');
    setEditingRecommended(false);
  });
  useTaskResult<DesignSubmitResult>(submitKey, setResult);
  useTaskResult<{ recommendedAnswerMd: string }>(answerKey, (res) => {
    setRecommendedAnswer(res.recommendedAnswerMd);
    setEditingRecommended(false);
    if (designCase) {
      void updateDesignCaseAnswers(getRawDb(), campaignId, interviewType, interviewLanguage, {
        recommendedAnswerMd: res.recommendedAnswerMd,
      }).then(setDesignCase);
    }
  });
  useTaskResult<{ elaborationMd: string }>(elaborateKey, (res) => {
    setElaborationMd(res.elaborationMd);
  });

  useEffect(() => {
    if (!designCase || !campaignId) return;
    const timer = setTimeout(() => {
      void updateDesignCaseAnswers(getRawDb(), campaignId, interviewType, interviewLanguage, {
        userAnswerMd: answer,
      }).catch(() => undefined);
    }, 600);
    return () => clearTimeout(timer);
  }, [answer, campaignId, designCase, interviewLanguage, interviewType]);

  const loadCase = (force = false): void => {
    void runTask(caseKey, '模拟面试出题', () =>
      generateDesignCase(getRawDb(), campaignId, interviewType, interviewLanguage, force),
    ).catch(() => undefined);
  };

  const submit = (): void => {
    if (!designCase) return;
    const input = { campaignId, designCase, answer, interviewType };
    void runTask(submitKey, '模拟面试评分', async () => {
      const res = await submitDesignAnswer(
        getRawDb(),
        input.campaignId,
        input.designCase.title,
        input.designCase.scenarioMd,
        input.answer,
        input.designCase.interviewType,
        input.designCase.interviewLanguage,
        input.interviewType,
      );
      notifyDataChanged();
      return res;
    }).catch(() => undefined);
  };

  const clearAnswer = (): void => {
    setAnswer('');
    setResult(null);
    if (!designCase) return;
    void updateDesignCaseAnswers(getRawDb(), campaignId, interviewType, interviewLanguage, {
      userAnswerMd: '',
    }).then(setDesignCase);
  };

  const generateAnswer = (): void => {
    if (!designCase) return;
    void runTask(answerKey, '生成推荐答案', () =>
      generateRecommendedAnswer(
        getRawDb(),
        campaignId,
        designCase.title,
        designCase.scenarioMd,
        designCase.interviewType,
        designCase.interviewLanguage,
        designCase.constraints,
      ),
    ).catch(() => undefined);
  };

  const saveRecommended = (): void => {
    if (!designCase) return;
    void updateDesignCaseAnswers(getRawDb(), campaignId, interviewType, interviewLanguage, {
      recommendedAnswerMd: recommendedAnswer,
    }).then((updated) => {
      setDesignCase(updated);
      setEditingRecommended(false);
      Alert.alert('已保存', '推荐答案已保存');
    });
  };

  const saveRecommendedToSpeech = (): void => {
    const text = recommendedAnswer.trim();
    if (!text) return;
    void saveSpeechFromDesign(getRawDb(), campaignId, text).then((saved) => {
      notifyDataChanged();
      Alert.alert('话术库', saved.existing ? '这段已经在话术库里' : '已加入话术库');
    });
  };

  const elaborateRecommended = (): void => {
    const text = recommendedAnswer.trim();
    if (!text || !designCase) return;
    const contextMd = `题目：${designCase.title}\n\n${designCase.scenarioMd}\n\n参考答案：\n${text}`;
    void runTask(elaborateKey, '细化讲解', () => elaborateDesignAnswer(text, contextMd)).catch(() => undefined);
  };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.bg }} contentContainerStyle={{ padding: 16, gap: 10 }}>
      {campaigns.length === 0 ? (
        <Text style={{ color: theme.muted, fontSize: 13 }}>请先创建 Campaign 或从桌面端同步</Text>
      ) : (
        <>
          <Text style={{ color: theme.muted, fontSize: 12 }}>
            结合公司、JD、简历与考点出题，覆盖概念、编码、系统设计、项目场景 · 关联 Campaign
          </Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            {campaigns.map((c) => (
              <Pressable
                key={c.id}
                onPress={() => {
                  setCampaignId(c.id);
                  setDesignCase(null);
                  setResult(null);
                  setAnswer('');
                  setRecommendedAnswer('');
                }}
                style={{
                  marginRight: 8,
                  paddingHorizontal: 10,
                  paddingVertical: 8,
                  borderRadius: 8,
                  borderWidth: 1,
                  borderColor: campaignId === c.id ? theme.accent : theme.border,
                  backgroundColor: campaignId === c.id ? `${theme.accent}18` : theme.surface,
                  maxWidth: 260,
                }}
              >
                <Text style={{ color: theme.text, fontSize: 11 }} numberOfLines={2}>
                  {campaignLabel(c)}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        </>
      )}

      <OverflowHintScrollView contentContainerStyle={{ gap: 8 }}>
        {MOCK_INTERVIEW_TYPE_OPTIONS.map((o) => (
          <Pressable
            key={o.value}
            onPress={() => {
              setInterviewType(o.value);
              setDesignCase(null);
              setResult(null);
              setAnswer('');
              setRecommendedAnswer('');
            }}
            style={{
              paddingHorizontal: 10,
              paddingVertical: 6,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: interviewType === o.value ? theme.accent : theme.border,
              backgroundColor: theme.surface,
            }}
          >
            <Text style={{ color: interviewType === o.value ? theme.accent : theme.muted, fontSize: 12 }}>
              {o.label}
            </Text>
          </Pressable>
        ))}
      </OverflowHintScrollView>

      {interviewType === 'selfIntro' && (
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {MOCK_INTERVIEW_LANGUAGE_OPTIONS.map((o) => (
            <Pressable
              key={o.value}
              onPress={() => {
                setInterviewLanguage(o.value);
                setDesignCase(null);
                setResult(null);
                setAnswer('');
                setRecommendedAnswer('');
              }}
              style={{
                paddingHorizontal: 10,
                paddingVertical: 6,
                borderRadius: 8,
                borderWidth: 1,
                borderColor: interviewLanguage === o.value ? theme.accent : theme.border,
                backgroundColor: theme.surface,
              }}
            >
              <Text style={{ color: interviewLanguage === o.value ? theme.accent : theme.muted, fontSize: 12 }}>
                {o.label}
              </Text>
            </Pressable>
          ))}
        </View>
      )}

      <Pressable
        onPress={() => loadCase(Boolean(designCase))}
        disabled={loadingCase || !campaignId}
        style={{
          backgroundColor: theme.accent,
          padding: 12,
          borderRadius: 8,
          alignItems: 'center',
          opacity: loadingCase || !campaignId ? 0.6 : 1,
        }}
      >
        <Text style={{ color: '#fff' }}>{loadingCase ? '出题中…' : designCase ? '重新出题' : '开始模拟'}</Text>
      </Pressable>
      <Text style={{ color: theme.muted, fontSize: 11 }}>
        已生成的题目会自动保存；再次进入会直接显示保存题，只有点「重新出题」才会生成新题。你的作答也会自动缓存。
      </Text>
      {caseError !== null && <Text style={{ color: theme.danger, fontSize: 12 }}>{caseError}</Text>}

      {designCase && (
        <View style={{ gap: 8 }}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
            <Text style={{ color: theme.text, fontWeight: '600' }}>{designCase.title}</Text>
            <Text style={{ color: theme.accent, fontSize: 11 }}>
              {MOCK_INTERVIEW_TYPE_LABELS[designCase.interviewType]}
              {' · '}
              {MOCK_INTERVIEW_LANGUAGE_LABELS[designCase.interviewLanguage]}
            </Text>
          </View>
          {designCase.relatedNodeName && (
            <Text style={{ color: theme.muted, fontSize: 11 }}>关联考点：{designCase.relatedNodeName}</Text>
          )}
          <MarkdownPreview text={designCase.scenarioMd} />
          {designCase.constraints.length > 0 && (
            <View style={{ gap: 2 }}>
              <Text style={{ color: theme.muted, fontSize: 11 }}>
                {MOCK_INTERVIEW_CONSTRAINTS_LABEL}
              </Text>
              {/* 一条一行，和桌面端的 ul 对齐：挤成一行后每条约束都得从中间的分隔点里认，
                  而这些正是作答时要逐条兑掉的东西 */}
              {designCase.constraints.map((c) => (
                <Text key={c} style={{ color: theme.text, fontSize: 13 }}>
                  {'• '}
                  {c}
                </Text>
              ))}
            </View>
          )}

          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Text style={{ color: theme.text, fontWeight: '600', fontSize: 13 }}>你的回答</Text>
            {answer.trim() && (
              <Pressable onPress={clearAnswer} hitSlop={8}>
                <Text style={{ color: theme.danger, fontSize: 11 }}>清空重答</Text>
              </Pressable>
            )}
          </View>
          <TextInput
            multiline
            value={answer}
            onChangeText={setAnswer}
            placeholder={ANSWER_PLACEHOLDERS[designCase.interviewType][designCase.interviewLanguage]}
            placeholderTextColor={theme.muted}
            style={{
              minHeight: 120,
              color: theme.text,
              borderWidth: 1,
              borderColor: theme.border,
              borderRadius: 8,
              padding: 10,
              textAlignVertical: 'top',
            }}
          />
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end' }}>
            <VoiceInputButton onTranscript={(text) => setAnswer((prev) => prev + text)} />
            <Pressable
              onPress={submit}
              disabled={submitting || !answer.trim()}
              style={{
                flex: 1,
                backgroundColor: theme.accent,
                padding: 12,
                borderRadius: 8,
                alignItems: 'center',
                opacity: submitting || !answer.trim() ? 0.6 : 1,
              }}
            >
              <Text style={{ color: '#fff' }}>{submitting ? '评分中…' : '提交评分'}</Text>
            </Pressable>
          </View>
          {submitError !== null && <Text style={{ color: theme.danger, fontSize: 12 }}>{submitError}</Text>}

          <View style={{ gap: 8, borderTopWidth: 1, borderColor: theme.border, paddingTop: 10 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <Text style={{ color: theme.text, fontWeight: '600', fontSize: 13 }}>推荐答案</Text>
              <View style={{ flexDirection: 'row', gap: 12 }}>
                <Pressable onPress={generateAnswer} disabled={generatingAnswer} hitSlop={8}>
                  <Text style={{ color: generatingAnswer ? theme.muted : theme.accent, fontSize: 11 }}>
                    {generatingAnswer ? '生成中…' : recommendedAnswer ? '重新生成' : '生成推荐答案'}
                  </Text>
                </Pressable>
                {recommendedAnswer ? (
                  <Pressable onPress={() => setEditingRecommended((v) => !v)} hitSlop={8}>
                    <Text style={{ color: theme.accent, fontSize: 11 }}>
                      {editingRecommended ? '预览' : '编辑'}
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            </View>
            {answerError !== null && <Text style={{ color: theme.danger, fontSize: 12 }}>{answerError}</Text>}
            {recommendedAnswer ? (
              <>
                {editingRecommended ? (
                  <TextInput
                    multiline
                    value={recommendedAnswer}
                    onChangeText={setRecommendedAnswer}
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
                  <MarkdownPreview text={recommendedAnswer} />
                )}
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
                  {editingRecommended && (
                    <Pressable onPress={saveRecommended} hitSlop={8}>
                      <Text style={{ color: theme.accent, fontSize: 11 }}>保存</Text>
                    </Pressable>
                  )}
                  <Pressable onPress={saveRecommendedToSpeech} hitSlop={8}>
                    <Text style={{ color: theme.accent, fontSize: 11 }}>加入话术库</Text>
                  </Pressable>
                  <Pressable onPress={elaborateRecommended} disabled={elaborating} hitSlop={8}>
                    <Text style={{ color: elaborating ? theme.muted : theme.accent, fontSize: 11 }}>
                      {elaborating ? '细化中…' : '细化讲解'}
                    </Text>
                  </Pressable>
                </View>
                {elaborateError !== null && (
                  <Text style={{ color: theme.danger, fontSize: 12 }}>{elaborateError}</Text>
                )}
              </>
            ) : (
              <Text style={{ color: theme.muted, fontSize: 12 }}>
                可按需生成参考答案，支持编辑保存、加入话术库与细化讲解。
              </Text>
            )}
          </View>
        </View>
      )}

      {result && (
        <View style={{ gap: 6 }}>
          <Text style={{ color: theme.success }}>得分 {result.score}/5</Text>
          <MarkdownPreview text={result.feedbackMd} />
        </View>
      )}

      <Modal visible={elaborationMd !== null} animationType="slide" transparent onRequestClose={() => setElaborationMd(null)}>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' }}>
          <View
            style={{
              maxHeight: '80%',
              backgroundColor: theme.surface,
              borderTopLeftRadius: 16,
              borderTopRightRadius: 16,
              padding: 16,
              gap: 10,
            }}
          >
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <Text style={{ color: theme.text, fontWeight: '600' }}>细化讲解</Text>
              <Pressable onPress={() => setElaborationMd(null)} hitSlop={8}>
                <Text style={{ color: theme.accent }}>关闭</Text>
              </Pressable>
            </View>
            <ScrollView style={{ maxHeight: 400 }}>
              <MarkdownPreview text={elaborationMd ?? ''} />
            </ScrollView>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}
