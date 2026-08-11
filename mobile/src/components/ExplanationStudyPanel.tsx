import { useEffect, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import type { Explanation } from '@shared/entities';
import type { ExplanationTier } from '@shared/enums';
import type { ExplainElaborateResult } from '@shared/ipc';
import { invokeRemote } from '../remote/rpc';
import { useRemoteTask } from '../context/RemoteTaskContext';
import { theme } from '../theme';

export function ExplanationStudyPanel({
  nodeId,
  nodeName,
  tier = 'spoken',
}: {
  nodeId: string;
  nodeName: string;
  tier?: ExplanationTier;
}): React.JSX.Element {
  const { runTask } = useRemoteTask();
  const [content, setContent] = useState<Explanation | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draftMd, setDraftMd] = useState('');
  const [elaborateInput, setElaborateInput] = useState('');
  const [elaboration, setElaboration] = useState<ExplainElaborateResult | null>(null);

  const load = async (forceGenerate = false): Promise<void> => {
    setLoading(true);
    setError(null);
    setElaboration(null);
    try {
      if (!forceGenerate) {
        const { result: cached } = await invokeRemote<
          'explain:get',
          { nodeId: string; tier: ExplanationTier },
          Explanation | null
        >('explain:get', { nodeId, tier });
        if (cached?.contentMd) {
          setContent(cached);
          setDraftMd(cached.contentMd);
          return;
        }
      }
      const generated = await runTask('生成讲解', async () => {
        const { result } = await invokeRemote<
          'explain:generate',
          { nodeId: string; tier: ExplanationTier },
          Explanation
        >('explain:generate', { nodeId, tier });
        return result;
      });
      setContent(generated);
      setDraftMd(generated.contentMd);
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setElaboration(null);
    setEditing(false);
    void (async () => {
      try {
        const { result: cached } = await invokeRemote<
          'explain:get',
          { nodeId: string; tier: ExplanationTier },
          Explanation | null
        >('explain:get', { nodeId, tier });
        if (cancelled) return;
        if (cached?.contentMd) {
          setContent(cached);
          setDraftMd(cached.contentMd);
          return;
        }
        const generated = await runTask('生成讲解', async () => {
          const { result } = await invokeRemote<
            'explain:generate',
            { nodeId: string; tier: ExplanationTier },
            Explanation
          >('explain:generate', { nodeId, tier });
          return result;
        });
        if (!cancelled) {
          setContent(generated);
          setDraftMd(generated.contentMd);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [nodeId, tier, runTask]);

  const saveEdit = async (): Promise<void> => {
    if (!content) return;
    try {
      const { result } = await invokeRemote<
        'explain:update',
        { id: string; contentMd: string },
        Explanation
      >('explain:update', { id: content.id, contentMd: draftMd });
      setContent(result);
      setDraftMd(result.contentMd);
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const elaborate = async (): Promise<void> => {
    const text = elaborateInput.trim();
    if (!text || !content) return;
    try {
      const { result } = await runTask('细化讲解', async () =>
        invokeRemote<'explain:elaborate', {
          nodeId: string;
          tier: ExplanationTier;
          selectedText: string;
          contextMd?: string;
        }, ExplainElaborateResult>('explain:elaborate', {
          nodeId,
          tier,
          selectedText: text,
          contextMd: content.contentMd,
        }),
      );
      setElaboration(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (loading) {
    return <Text style={{ color: theme.muted, fontSize: 13 }}>加载讲解…</Text>;
  }

  if (error) {
    return <Text style={{ color: theme.danger, fontSize: 13 }}>{error}</Text>;
  }

  if (!content) {
    return <Text style={{ color: theme.muted, fontSize: 13 }}>暂无「{nodeName}」的讲解</Text>;
  }

  return (
    <View style={{ gap: 10 }}>
      {content.modelUsed === 'user-edit' && (
        <Text style={{ color: '#fbbf24', fontSize: 11 }}>已手动修订</Text>
      )}

      {editing ? (
        <TextInput
          multiline
          value={draftMd}
          onChangeText={setDraftMd}
          style={{
            minHeight: 200,
            color: theme.text,
            borderWidth: 1,
            borderColor: theme.border,
            borderRadius: 8,
            padding: 10,
            textAlignVertical: 'top',
            fontSize: 13,
            lineHeight: 20,
          }}
        />
      ) : (
        <Text style={{ color: theme.text, fontSize: 13, lineHeight: 20 }}>{content.contentMd}</Text>
      )}

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {editing ? (
          <>
            <Pressable
              onPress={() => void saveEdit()}
              style={{ backgroundColor: theme.accent, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8 }}
            >
              <Text style={{ color: '#fff', fontSize: 12 }}>保存修改</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                setDraftMd(content.contentMd);
                setEditing(false);
              }}
              style={{ paddingHorizontal: 12, paddingVertical: 8 }}
            >
              <Text style={{ color: theme.muted, fontSize: 12 }}>取消</Text>
            </Pressable>
          </>
        ) : (
          <>
            <Pressable
              onPress={() => setEditing(true)}
              style={{ paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, backgroundColor: theme.bg }}
            >
              <Text style={{ color: theme.accent, fontSize: 12 }}>编辑讲解</Text>
            </Pressable>
            <Pressable
              onPress={() => void load(true)}
              style={{ paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, backgroundColor: theme.bg }}
            >
              <Text style={{ color: theme.muted, fontSize: 12 }}>重新生成</Text>
            </Pressable>
          </>
        )}
      </View>

      {!editing && (
        <View style={{ gap: 6 }}>
          <Text style={{ color: theme.muted, fontSize: 11 }}>输入要细化的词句（或从讲解里复制）</Text>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <TextInput
              value={elaborateInput}
              onChangeText={setElaborateInput}
              placeholder="例如：CAS、双亲委派…"
              placeholderTextColor={theme.muted}
              style={{
                flex: 1,
                color: theme.text,
                borderWidth: 1,
                borderColor: theme.border,
                borderRadius: 8,
                paddingHorizontal: 10,
                paddingVertical: 8,
                fontSize: 13,
              }}
            />
            <Pressable
              onPress={() => void elaborate()}
              disabled={!elaborateInput.trim()}
              style={{
                backgroundColor: theme.accent,
                paddingHorizontal: 12,
                justifyContent: 'center',
                borderRadius: 8,
                opacity: !elaborateInput.trim() ? 0.5 : 1,
              }}
            >
              <Text style={{ color: '#fff', fontSize: 12 }}>细化</Text>
            </Pressable>
          </View>
        </View>
      )}

      {elaboration && (
        <View
          style={{
            borderWidth: 1,
            borderColor: theme.accent,
            borderRadius: 8,
            padding: 10,
            backgroundColor: theme.bg,
            gap: 6,
          }}
        >
          <Text style={{ color: theme.accent, fontSize: 12, fontWeight: '600' }}>
            细化：{elaboration.selectedText}
          </Text>
          <Text style={{ color: theme.text, fontSize: 13, lineHeight: 20 }}>{elaboration.elaborationMd}</Text>
        </View>
      )}
    </View>
  );
}
