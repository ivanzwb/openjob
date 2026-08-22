import { useMemo } from 'react';
import { Text, View } from 'react-native';
import { visibleMarkdownBlocks } from '../lib/markdownBlocks';
import { normalizeDisplayText } from '../lib/markdownDisplay';
import { useTheme } from '../theme';

function normalizeInlineMarkdown(line: string): string {
  return line
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
}

function parseTableRows(text: string): string[][] | null {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.includes('|'));
  if (lines.length < 2) return null;
  const rows = lines
    .filter((line) => !/^\|?[\s:-]+\|[\s|:-]*$/.test(line))
    .map((line) =>
      line
        .split('|')
        .map((cell) => cell.trim())
        .filter(Boolean),
    )
    .filter((row) => row.length > 0);
  return rows.length > 0 ? rows : null;
}

export function MarkdownPreview({ text }: { text: string }): React.JSX.Element {
  const theme = useTheme();
  const normalized = useMemo(() => normalizeDisplayText(text), [text]);
  const blocks = useMemo(() => visibleMarkdownBlocks(normalized), [normalized]);

  if (blocks.length === 0) {
    return <Text style={{ color: theme.muted, fontSize: 13 }}>（空）</Text>;
  }

  return (
    <View style={{ gap: 8 }}>
      {blocks.map((block, blockIdx) => {
        if (block.type === 'code' || block.type === 'mermaid') {
          return (
            <View
              key={`${block.type}-${blockIdx}`}
              style={{
                borderRadius: 8,
                backgroundColor: theme.bg,
                borderWidth: 1,
                borderColor: theme.border,
                padding: 10,
              }}
            >
              <Text style={{ color: theme.muted, fontSize: 10, marginBottom: 4 }}>
                {block.type === 'mermaid' ? 'mermaid' : block.lang ?? 'code'}
              </Text>
              <Text
                selectable
                style={{ color: theme.text, fontSize: 12, lineHeight: 18, fontFamily: 'monospace' }}
              >
                {block.value.trim()}
              </Text>
            </View>
          );
        }

        const tableRows = parseTableRows(block.value);
        if (tableRows) {
          const [header, ...body] = tableRows;
          return (
            <View
              key={`table-${blockIdx}`}
              style={{ borderWidth: 1, borderColor: theme.border, borderRadius: 8, overflow: 'hidden' }}
            >
              <View style={{ flexDirection: 'row', backgroundColor: theme.bg }}>
                {header!.map((cell, cellIdx) => (
                  <Text
                    key={`h-${cellIdx}`}
                    selectable
                    style={{
                      flex: 1,
                      color: theme.text,
                      fontSize: 12,
                      fontWeight: '700',
                      padding: 8,
                      borderRightWidth: cellIdx < header!.length - 1 ? 1 : 0,
                      borderColor: theme.border,
                    }}
                  >
                    {normalizeInlineMarkdown(cell)}
                  </Text>
                ))}
              </View>
              {body.map((row, rowIdx) => (
                <View key={`r-${rowIdx}`} style={{ flexDirection: 'row', borderTopWidth: 1, borderColor: theme.border }}>
                  {row.map((cell, cellIdx) => (
                    <Text
                      key={`c-${rowIdx}-${cellIdx}`}
                      selectable
                      style={{
                        flex: 1,
                        color: theme.text,
                        fontSize: 12,
                        lineHeight: 18,
                        padding: 8,
                        borderRightWidth: cellIdx < row.length - 1 ? 1 : 0,
                        borderColor: theme.border,
                      }}
                    >
                      {normalizeInlineMarkdown(cell)}
                    </Text>
                  ))}
                </View>
              ))}
            </View>
          );
        }

        const lines = block.value
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean);
        return (
          <View key={`text-${blockIdx}`} style={{ gap: 4 }}>
            {lines.map((line, lineIdx) => {
              const heading = /^(#{1,3})\s+(.+)$/.exec(line);
              if (heading) {
                return (
                  <Text
                    key={`${blockIdx}-${lineIdx}`}
                    selectable
                    style={{
                      color: theme.text,
                      fontSize: heading[1]!.length === 1 ? 16 : 14,
                      lineHeight: 22,
                      fontWeight: '700',
                    }}
                  >
                    {normalizeInlineMarkdown(heading[2]!)}
                  </Text>
                );
              }
              const bullet = /^[-*]\s+(.+)$/.exec(line);
              const numbered = /^\d+\.\s+(.+)$/.exec(line);
              if (bullet || numbered) {
                return (
                  <Text
                    key={`${blockIdx}-${lineIdx}`}
                    selectable
                    style={{ color: theme.text, fontSize: 13, lineHeight: 20 }}
                  >
                    {'• '}
                    {normalizeInlineMarkdown((bullet?.[1] ?? numbered?.[1])!)}
                  </Text>
                );
              }
              return (
                <Text
                  key={`${blockIdx}-${lineIdx}`}
                  selectable
                  style={{ color: theme.text, fontSize: 13, lineHeight: 20 }}
                >
                  {normalizeInlineMarkdown(line)}
                </Text>
              );
            })}
          </View>
        );
      })}
    </View>
  );
}
