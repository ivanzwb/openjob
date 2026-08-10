import { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text } from 'react-native';
import type { RepoReadFileResult } from '@shared/ipc';
import type { Repo } from '@shared/entities';
import { invokeRemote } from '../remote/rpc';
import { theme } from '../theme';

export function ReposScreen(): React.JSX.Element {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [filePath, setFilePath] = useState('');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);

  const reload = async () => {
    setBusy(true);
    try {
      const { result } = await invokeRemote('repo:list');
      setRepos(result as Repo[]);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void reload();
  }, []);

  const openFile = async (repoId: string, path: string) => {
    setBusy(true);
    try {
      const { result } = await invokeRemote('repo:readFile', { repoId, filePath: path });
      const file = result as RepoReadFileResult;
      setFilePath(path);
      setContent(file.content);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const openSample = async (repo: Repo) => {
    const candidates = ['README.md', 'readme.md', 'package.json', 'go.mod', 'Cargo.toml'];
    for (const path of candidates) {
      try {
        await openFile(repo.id, path);
        return;
      } catch {
        // try next
      }
    }
    if (repo.repoMapMd) {
      setFilePath(`${repo.url} · repo map`);
      setContent(repo.repoMapMd.slice(0, 8000));
      return;
    }
    alert('未能读取示例文件，请先在桌面端索引仓库');
  };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.bg }} contentContainerStyle={{ padding: 16, gap: 10 }}>
      <Pressable onPress={() => void reload()}>
        <Text style={{ color: theme.accent }}>{busy ? '刷新中…' : '刷新仓库（桌面代理）'}</Text>
      </Pressable>
      {repos.map((r) => (
        <Pressable
          key={r.id}
          onPress={() => void openSample(r)}
          style={{ borderWidth: 1, borderColor: theme.border, borderRadius: 8, padding: 12, backgroundColor: theme.surface }}
        >
          <Text style={{ color: theme.text, fontSize: 12 }} numberOfLines={2}>{r.url}</Text>
          <Text style={{ color: theme.muted, fontSize: 10 }}>{r.status} · {r.languages.join(', ')}</Text>
        </Pressable>
      ))}
      {filePath ? (
        <>
          <Text style={{ color: theme.muted, fontSize: 11 }}>{filePath}</Text>
          <Text style={{ color: theme.text, fontSize: 11, fontFamily: 'monospace' }}>{content}</Text>
        </>
      ) : null}
    </ScrollView>
  );
}
