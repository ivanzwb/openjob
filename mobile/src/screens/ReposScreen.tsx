import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import type { Repo } from '@shared/entities';
import { RepoQaPanel } from '../components/RepoQaPanel';
import { getRawDb } from '../db';
import { listRepos } from '../data/repoLocal';
import { useLocalDataReload } from '../hooks/useLocalDataReload';
import { markdownToPlainText } from '../lib/markdownBlocks';
import { theme } from '../theme';

type RepoTab = 'summary' | 'qa';

const TABS: { id: RepoTab; label: string }[] = [
  { id: 'summary', label: '项目摘要' },
  { id: 'qa', label: '问答' },
];

export function ReposScreen(): React.JSX.Element {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedTab, setSelectedTab] = useState<RepoTab>('summary');
  const [cloneUrl, setCloneUrl] = useState('');
  const [filePath, setFilePath] = useState('');
  const [content, setContent] = useState('');

  const selected = repos.find((r) => r.id === selectedId) ?? null;

  const loadRepos = useCallback((): Repo[] => {
    const list = listRepos(getRawDb());
    setRepos(list);
    setSelectedId((prev) => {
      if (prev && list.some((r) => r.id === prev)) return prev;
      return list[0]?.id ?? null;
    });
    return list;
  }, []);

  useEffect(() => {
    try {
      loadRepos();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  }, [loadRepos]);

  useLocalDataReload(loadRepos);

  useEffect(() => {
    setFilePath('');
    setContent('');
    setSelectedTab('summary');
  }, [selectedId]);

  const addRepo = (): void => {
    if (!cloneUrl.trim()) return;
    Alert.alert(
      '需在桌面端添加',
      '克隆与索引仓库需要本机文件系统，请在桌面端添加仓库后同步到手机。',
    );
  };

  const openSample = (repo: Repo): void => {
    setSelectedId(repo.id);
    if (repo.summaryMd) {
      setFilePath(`${repo.url} · 项目摘要`);
      setContent(markdownToPlainText(repo.summaryMd).slice(0, 8000));
      setSelectedTab('summary');
      return;
    }
    if (repo.repoMapMd) {
      setFilePath(`${repo.url} · repo map`);
      setContent(repo.repoMapMd.slice(0, 8000));
      setSelectedTab('summary');
      return;
    }
    Alert.alert('暂无预览', '请先在桌面端索引该仓库，同步后即可查看摘要与 Repo Map。');
  };

  const renderSummaryTab = (repo: Repo): React.JSX.Element => {
    if (filePath) {
      return (
        <View style={{ gap: 6 }}>
          <Text style={{ color: theme.muted, fontSize: 11 }}>{filePath}</Text>
          <Text style={{ color: theme.text, fontSize: 11, fontFamily: 'monospace', lineHeight: 18 }}>
            {content}
          </Text>
        </View>
      );
    }

    if (repo.summaryMd) {
      return (
        <Text style={{ color: theme.text, fontSize: 13, lineHeight: 20 }}>
          {markdownToPlainText(repo.summaryMd)}
        </Text>
      );
    }

    if (repo.repoMapMd) {
      return (
        <View style={{ gap: 6 }}>
          <Text style={{ color: theme.muted, fontSize: 11 }}>Repo Map（节选）</Text>
          <Text style={{ color: theme.text, fontSize: 11, fontFamily: 'monospace', lineHeight: 18 }}>
            {repo.repoMapMd.slice(0, 8000)}
          </Text>
        </View>
      );
    }

    return (
      <View style={{ gap: 8 }}>
        <Text style={{ color: theme.muted, fontSize: 12 }}>
          {repo.status === 'ready'
            ? '暂无项目摘要，可打开已同步的摘要或 Repo Map 预览。'
            : '仓库索引中，完成后将显示项目摘要…'}
        </Text>
        {repo.status === 'ready' && (
          <Pressable onPress={() => openSample(repo)}>
            <Text style={{ color: theme.accent, fontSize: 12 }}>打开预览</Text>
          </Pressable>
        )}
      </View>
    );
  };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.bg }} contentContainerStyle={{ padding: 16, gap: 10 }}>
      <Pressable onPress={loadRepos}>
        <Text style={{ color: theme.accent }}>刷新列表</Text>
      </Pressable>

      <Text style={{ color: theme.muted, fontSize: 11 }}>
        仓库列表来自本地同步。克隆与索引请在桌面端完成。
      </Text>

      <View style={{ flexDirection: 'row', gap: 8 }}>
        <TextInput
          value={cloneUrl}
          onChangeText={setCloneUrl}
          placeholder="https://github.com/..."
          placeholderTextColor={theme.muted}
          autoCapitalize="none"
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
          onPress={addRepo}
          disabled={!cloneUrl.trim()}
          style={{
            backgroundColor: theme.surface,
            paddingHorizontal: 14,
            justifyContent: 'center',
            borderRadius: 8,
            borderWidth: 1,
            borderColor: theme.border,
            opacity: !cloneUrl.trim() ? 0.5 : 1,
          }}
        >
          <Text style={{ color: theme.text, fontSize: 12 }}>添加</Text>
        </Pressable>
      </View>

      {repos.length === 0 && (
        <Text style={{ color: theme.muted, fontSize: 13 }}>暂无仓库，请在桌面端添加后同步</Text>
      )}

      {repos.map((r) => (
        <Pressable
          key={r.id}
          onPress={() => setSelectedId(r.id)}
          style={{
            borderWidth: 1,
            borderColor: selectedId === r.id ? theme.accent : theme.border,
            borderRadius: 8,
            padding: 12,
            backgroundColor: theme.surface,
            gap: 4,
          }}
        >
          <Text style={{ color: theme.text, fontSize: 12 }} numberOfLines={2}>
            {r.url}
          </Text>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
            <Text
              style={{
                color: r.status === 'ready' ? theme.success : theme.muted,
                fontSize: 10,
              }}
            >
              {r.status === 'ready' ? '已就绪' : r.status === 'indexing' ? '索引中' : r.status}
            </Text>
            {r.languages.length > 0 && (
              <Text style={{ color: theme.muted, fontSize: 10 }}>{r.languages.join(', ')}</Text>
            )}
          </View>
          {selectedId === r.id && (
            <Pressable onPress={() => openSample(r)}>
              <Text style={{ color: theme.accent, fontSize: 11 }}>打开预览</Text>
            </Pressable>
          )}
        </Pressable>
      ))}

      {selected && (
        <View style={{ gap: 10, marginTop: 4 }}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {TABS.map((t) => (
              <Pressable
                key={t.id}
                onPress={() => setSelectedTab(t.id)}
                style={{
                  paddingHorizontal: 10,
                  paddingVertical: 5,
                  borderRadius: 8,
                  backgroundColor: selectedTab === t.id ? theme.accent : theme.bg,
                }}
              >
                <Text style={{ color: selectedTab === t.id ? '#fff' : theme.muted, fontSize: 12 }}>
                  {t.label}
                </Text>
              </Pressable>
            ))}
          </View>

          {selectedTab === 'summary' ? renderSummaryTab(selected) : <RepoQaPanel repo={selected} />}
        </View>
      )}
    </ScrollView>
  );
}
