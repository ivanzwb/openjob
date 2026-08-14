import { useCallback, useState } from 'react';
import { Alert, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import type { Repo } from '@shared/entities';
import { RepoQaPanel } from '../components/RepoQaPanel';
import { getRawDb } from '../db';
import { listRepos } from '../data/repoLocal';
import { getRepoFileContent, listRepoFilePaths } from '../data/repoFiles';
import { useLocalDataReload } from '../hooks/useLocalDataReload';
import { markdownToPlainText } from '../lib/markdownBlocks';
import { useTheme } from '../theme';

type RepoTab = 'summary' | 'files' | 'qa';

const TABS: { id: RepoTab; label: string }[] = [
  { id: 'summary', label: '项目摘要' },
  { id: 'files', label: '源码文件' },
  { id: 'qa', label: '问答' },
];

export function ReposScreen(): React.JSX.Element {
  const theme = useTheme();
  const [repos, setRepos] = useState<Repo[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedTab, setSelectedTab] = useState<RepoTab>('summary');
  const [cloneUrl, setCloneUrl] = useState('');
  const [filePath, setFilePath] = useState('');
  const [content, setContent] = useState('');
  const [viewingRepoId, setViewingRepoId] = useState<string | null>(null);

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

  // 挂载、同步完成、切回本 Tab 都由它统一读库
  useLocalDataReload(loadRepos);

  // filePath / content / selectedTab 是「当前仓库的浏览状态」，换仓库就得作废。
  // 打开文件或预览时会连带更新 viewingRepoId，所以那两条路径不会被这里清掉
  if (viewingRepoId !== selectedId) {
    setViewingRepoId(selectedId);
    setFilePath('');
    setContent('');
    setSelectedTab('summary');
  }

  const addRepo = (): void => {
    if (!cloneUrl.trim()) return;
    Alert.alert(
      '需在桌面端添加',
      '克隆与索引仓库需要本机文件系统，请在桌面端添加仓库后同步到手机。',
    );
  };

  const openFile = (repo: Repo, path: string): void => {
    const raw = getRepoFileContent(getRawDb(), repo.id, path);
    setSelectedId(repo.id);
    setViewingRepoId(repo.id);
    setFilePath(path);
    setContent(raw ?? '（文件未同步）');
    setSelectedTab('files');
  };

  const openSample = (repo: Repo): void => {
    setSelectedId(repo.id);
    setViewingRepoId(repo.id);
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

  const renderFilesTab = (repo: Repo): React.JSX.Element => {
    if (filePath) {
      return (
        <View style={{ gap: 6 }}>
          <Pressable onPress={() => { setFilePath(''); setContent(''); }}>
            <Text style={{ color: theme.accent, fontSize: 11 }}>← 返回文件列表</Text>
          </Pressable>
          <Text style={{ color: theme.muted, fontSize: 11 }}>{filePath}</Text>
          <Text style={{ color: theme.text, fontSize: 11, fontFamily: 'monospace', lineHeight: 18 }}>
            {content.slice(0, 12000)}
            {content.length > 12000 ? '\n…（已截断）' : ''}
          </Text>
        </View>
      );
    }

    const paths = listRepoFilePaths(getRawDb(), repo.id);
    if (paths.length === 0) {
      return (
        <Text style={{ color: theme.muted, fontSize: 12 }}>
          {repo.status === 'ready'
            ? '暂无同步的源码文件，请在桌面端重新索引后全量同步。'
            : '仓库索引中，完成后将同步源码快照…'}
        </Text>
      );
    }

    return (
      <View style={{ gap: 4 }}>
        <Text style={{ color: theme.muted, fontSize: 11 }}>共 {paths.length} 个文件（来自桌面索引快照）</Text>
        {paths.slice(0, 80).map((p) => (
          <Pressable key={p} onPress={() => openFile(repo, p)}>
            <Text style={{ color: theme.accent, fontSize: 11, fontFamily: 'monospace' }} numberOfLines={1}>
              {p}
            </Text>
          </Pressable>
        ))}
        {paths.length > 80 && (
          <Text style={{ color: theme.muted, fontSize: 10 }}>…另有 {paths.length - 80} 个文件</Text>
        )}
      </View>
    );
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
        仓库列表来自本地同步。克隆与索引在桌面端完成，源码快照同步后可读。
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

          {selectedTab === 'summary'
            ? renderSummaryTab(selected)
            : selectedTab === 'files'
              ? renderFilesTab(selected)
              : <RepoQaPanel repo={selected} />}
        </View>
      )}
    </ScrollView>
  );
}
