import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { getRawDb } from '../db';
import { describeDebriefResult, ingestSelfDebrief } from '../data/debriefLocal';
import { runTask, useTaskState } from '../context/RemoteTaskContext';
import { useTheme } from '../theme';
import { VoiceInputButton } from './VoiceInputButton';

/**
 * 面后复盘：刚出面试间就把被问到的题记下来。
 *
 * 之所以做在手机上而不是等回桌面端：复盘的价值随时间衰减得极快。出面试间那几分钟里
 * 还记得考官追问到第三层，等晚上回到电脑前只剩「问了 Kafka」。所以这里首选语音——
 * 站在电梯里说两句比打字现实得多，转写还是本地跑的，不联网也能用。
 *
 * 抽题、建盲区、抬概率都在本机跑完并写进同步表，桌面端下次同步就能看到同一份结果。
 */
export function DebriefPanel({
  campaignId,
  onDone,
}: {
  campaignId: string;
  onDone?: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  const [text, setText] = useState('');
  const taskKey = `debrief:${campaignId}`;
  const { running, error } = useTaskState(taskKey);

  const submit = (): void => {
    const raw = text.trim();
    if (!raw) return;
    void runTask(
      taskKey,
      '复盘摄入',
      async () => {
        const result = await ingestSelfDebrief(getRawDb(), campaignId, raw);
        // 摄入成功才清空输入框：失败时那段口述还得留着重试，重录一遍代价太大
        setText('');
        onDone?.();
        return describeDebriefResult(result);
      },
    );
  };

  return (
    <View style={{ gap: 8 }}>
      <Text style={{ color: theme.text, fontSize: 14, fontWeight: '600' }}>面后复盘</Text>
      <Text style={{ color: theme.muted, fontSize: 12 }}>
        说说刚才被问到了什么。会自动拆成题目、对上考点，没预测到的记成盲区。
      </Text>

      <View
        style={{
          flexDirection: 'row',
          alignItems: 'flex-end',
          gap: 4,
          borderWidth: 1,
          borderColor: theme.border,
          borderRadius: 8,
          backgroundColor: theme.bg,
          paddingLeft: 10,
          paddingRight: 2,
        }}
      >
        <TextInput
          value={text}
          onChangeText={setText}
          editable={!running}
          multiline
          placeholder="一面问了 Kafka 副本同步怎么保证不丢消息，追问了 ISR 收缩…"
          placeholderTextColor={theme.muted}
          style={{
            flex: 1,
            color: theme.text,
            fontSize: 13,
            minHeight: 88,
            maxHeight: 220,
            paddingVertical: 8,
          }}
        />
        <VoiceInputButton
          disabled={running}
          // 口述的是面试内容，引导词给面试领域的高频词，压一压同音字
          prompt="面试 面经 复盘 考官 追问 一面 二面 三面 项目 架构 算法"
          onTranscript={(spoken) =>
            // 追加而不是替换：一次面试往往分几段想起来，说一段停一下再说下一段
            setText((prev) => (prev.trim() ? `${prev.trim()}\n${spoken}` : spoken))
          }
        />
      </View>

      {error && <Text style={{ color: theme.danger, fontSize: 12 }}>{error}</Text>}

      <Pressable
        onPress={submit}
        disabled={running || !text.trim()}
        style={{
          alignSelf: 'flex-start',
          paddingHorizontal: 14,
          paddingVertical: 8,
          borderRadius: 8,
          backgroundColor: theme.accent,
          opacity: running || !text.trim() ? 0.5 : 1,
        }}
      >
        <Text style={{ color: theme.bg, fontSize: 13, fontWeight: '600' }}>
          {running ? '正在拆题…' : '记下这次复盘'}
        </Text>
      </Pressable>
    </View>
  );
}
