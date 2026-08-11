import { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import type { RepoReadFileResult } from '@shared/ipc';
import type { Repo } from '@shared/entities';
import { RepoQaPanel } from '../components/RepoQaPanel';
import { invokeRemote, jobResultFromEvents } from '../remote/rpc';
import { useApp } from '../context/AppContext';
import { useRemoteTask } from '../context/RemoteTaskContext';
import { markdownToPlainText } from '../lib/markdownBlocks';
import { theme } from '../theme';

type RepoTab = 'summary' | 'qa';

const TABS: { id: RepoTab; label: string }[] = [
  { id: 'summary', label: '项目摘要' },
  { id: 'qa', label: '问答' },
];

export function ReposScreen(): React.JSX.Element {
  const { triggerSync } = useApp();
  const { runTask, active } = useRemoteTask();
  const [repos, setRepos] = useState<Repo[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedTab, setSelectedTab] = useState<RepoTab>('summary');
  const [cloneUrl, setCloneUrl] = useState('');
  const [filePath, setFilePath] = useState('');
  const [content, setContent] = useState('');

  const busy = Boolean(active);
  const cloning = active?.label === '克隆并索引仓库';
  const selected = repos.find((r) => r.id === selectedId) ?? null;

  const loadRepos = async (): Promise<Repo[]> => {
    const { result } = await invokeRemote('repo:list');
    const list = result as Repo[];
    setRepos(list);
    if (list.length && !selectedId) setSelectedId(list[0]!.id);
    return list;
  };

  useEffect(() => {
    void loadRepos().catch((e) => alert(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    setFilePath('');
    setContent('');
    setSelectedTab('summary');
  }, [selectedId]);

  const reload = async (): Promise<void> => {
    try {
      await runTask('刷新仓库', async () => {
        await loadRepos();
        return '仓库列表已更新';
      });
    } catch {
      // toast handled by runTask
    }
  };

  const addRepo = async (): Promise<void> => {
    const url = cloneUrl.trim();
    if (!url || cloning) return;
    try {
      await runTask('克隆并索引仓库', async () => {
        const { events } = await invokeRemote('repo:add', { url });
        const { message, error } = jobResultFromEvents(events);
        if (error) throw new Error(error);
        return message;
      });
      setCloneUrl('');
      await triggerSync();
      const list = await loadRepos();
      const added = list.find((r) => r.url === url) ?? list[list.length - 1];
      if (added) setSelectedId(added.id);
    } catch {
      // toast handled by runTask
    }
  };

  const openFile = async (repoId: string, path: string): Promise<void> => {
    try {
      await runTask('读取文件', async () => {
        const { result } = await invokeRemote('repo:readFile', { repoId, filePath: path });
        const file = result as RepoReadFileResult;
        setFilePath(path);
        setContent(file.content);
        setSelectedTab('summary');
        return `已加载 ${path}`;
      }, { toastSuccess: false });
    } catch {
      // toast handled by runTask
    }
  };

  const readFileQuiet = async (repoId: string, path: string): Promise<boolean> => {
    try {
      const { result } = await invokeRemote('repo:readFile', { repoId, filePath: path });
      const file = result as RepoReadFileResult;
      setFilePath(path);
      setContent(file.content);
      setSelectedTab('summary');
      return true;
    } catch {
      return false;
    }
  };

  const openSample = async (repo: Repo): Promise<void> => {
    setSelectedId(repo.id);
    const candidates = ['README.md', 'readme.md', 'package.json', 'go.mod', 'Cargo.toml'];
    for (const path of candidates) {
      if (await readFileQuiet(repo.id, path)) return;
    }
    if (repo.repoMapMd) {
      setFilePath(`${repo.url} · repo map`);
      setContent(repo.repoMapMd.slice(0, 8000));
      setSelectedTab('summary');
      return;
    }
    alert('未能读取示例文件，请先在桌面端索引仓库');
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
            ? '暂无项目摘要，可打开示例文件预览仓库内容。'
            : '仓库索引中，完成后将显示项目摘要…'}
        </Text>
        {repo.status === 'ready' && (
          <Pressable onPress={() => void openSample(repo)}>
            <Text style={{ color: theme.accent, fontSize: 12 }}>打开示例文件</Text>
          </Pressable>
        )}
      </View>
    );
  };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.bg }} contentContainerStyle={{ padding: 16, gap: 10 }}>
      <Pressable onPress={() => void reload()}>
        <Text style={{ color: theme.accent }}>{busy && !cloning ? '刷新中…' : '刷新仓库（桌面代理）'}</Text>
      </Pressable>

      <View style={{ flexDirection: 'row', gap: 8 }}>
        <TextInput
          value={cloneUrl}
          onChangeText={setCloneUrl}
          placeholder="https://github.com/..."
          placeholderTextColor={theme.muted}
          autoCapitalize="none"
          editable={!cloning}
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
          onPress={() => void addRepo()}
          disabled={cloning || !cloneUrl.trim()}
          style={{
            backgroundColor: theme.accent,
            paddingHorizontal: 14,
            justifyContent: 'center',
            borderRadius: 8,
            opacity: cloning || !cloneUrl.trim() ? 0.5 : 1,
          }}
        >
          <Text style={{ color: '#fff', fontSize: 12 }}>{cloning ? '克隆中…' : '添加'}</Text>
        </Pressable>
      </View>

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
          <Text style={{ color: theme.text, fontSize: 12 }} numberOfLines={2}>{r.url}</Text>
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
            <Pressable onPress={() => void openSample(r)}>
              <Text style={{ color: theme.accent, fontSize: 11 }}>打开示例文件</Text>
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
