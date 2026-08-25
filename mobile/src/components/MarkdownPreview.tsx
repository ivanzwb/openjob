import { useMemo } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { visibleMarkdownBlocks } from '../lib/markdownBlocks';
import { normalizeDisplayText } from '../lib/markdownDisplay';
import { parseMarkdownTextSegments } from '@shared/lib/markdownSegments';
import { useTheme } from '../theme';

const TABLE_CELL_MIN_WIDTH = 88;
const TABLE_CELL_MAX_WIDTH = 240;

function normalizeInlineMarkdown(line: string): string {
  return line
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
}

function MarkdownTable({ rows }: { rows: string[][] }): React.JSX.Element | null {
  const theme = useTheme();
  if (rows.length === 0) return null;

  const [header, ...body] = rows;
  const colCount = header?.length ?? 0;
  if (colCount === 0) return null;

  const cellStyle = {
    minWidth: TABLE_CELL_MIN_WIDTH,
    maxWidth: TABLE_CELL_MAX_WIDTH,
    padding: 8,
    borderColor: theme.border,
  } as const;

  return (
    <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator>
      <View
        style={{
          borderWidth: 1,
          borderColor: theme.border,
          borderRadius: 8,
          overflow: 'hidden',
        }}
      >
        <View style={{ flexDirection: 'row', backgroundColor: theme.bg }}>
          {header!.map((cell, cellIdx) => (
            <Text
              key={`h-${cellIdx}`}
              selectable
              style={{
                ...cellStyle,
                color: theme.text,
                fontSize: 12,
                fontWeight: '700',
                borderRightWidth: cellIdx < colCount - 1 ? 1 : 0,
              }}
            >
              {normalizeInlineMarkdown(cell)}
            </Text>
          ))}
        </View>
        {body.map((row, rowIdx) => (
          <View
            key={`r-${rowIdx}`}
            style={{ flexDirection: 'row', borderTopWidth: 1, borderColor: theme.border }}
          >
            {row.map((cell, cellIdx) => (
              <Text
                key={`c-${rowIdx}-${cellIdx}`}
                selectable
                style={{
                  ...cellStyle,
                  color: theme.text,
                  fontSize: 12,
                  lineHeight: 18,
                  borderRightWidth: cellIdx < colCount - 1 ? 1 : 0,
                }}
              >
                {normalizeInlineMarkdown(cell)}
              </Text>
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

function MarkdownParagraph({ lines, keyPrefix }: { lines: string[]; keyPrefix: string }): React.JSX.Element {
  const theme = useTheme();
  const trimmed = lines
    .map((line) => line.trim())
    .filter(Boolean);

  return (
    <View style={{ gap: 4 }}>
      {trimmed.map((line, lineIdx) => {
        const heading = /^(#{1,3})\s+(.+)$/.exec(line);
        if (heading) {
          return (
            <Text
              key={`${keyPrefix}-${lineIdx}`}
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
              key={`${keyPrefix}-${lineIdx}`}
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
            key={`${keyPrefix}-${lineIdx}`}
            selectable
            style={{ color: theme.text, fontSize: 13, lineHeight: 20 }}
          >
            {normalizeInlineMarkdown(line)}
          </Text>
        );
      })}
    </View>
  );
}

function CodeBlockView({ label, code }: { label: string; code: string }): React.JSX.Element {
  const theme = useTheme();
  return (
    <View
      style={{
        borderRadius: 8,
        backgroundColor: theme.bg,
        borderWidth: 1,
        borderColor: theme.border,
        padding: 10,
      }}
    >
      <Text style={{ color: theme.muted, fontSize: 10, marginBottom: 4 }}>{label}</Text>
      <Text
        selectable
        style={{ color: theme.text, fontSize: 12, lineHeight: 18, fontFamily: 'monospace' }}
      >
        {code}
      </Text>
    </View>
  );
}

export function MarkdownPreview({ text }: { text: string }): React.JSX.Element {
  const theme = useTheme();
  const normalized = useMemo(() => normalizeDisplayText(text), [text]);
  const blocks = useMemo(() => visibleMarkdownBlocks(normalized), [normalized]);

  if (blocks.length === 0) {
    return <Text style={{ color: theme.muted, fontSize: 13 }}>（空）</Text>;
  }

  return (
    <View style={{ gap: 8, width: '100%' }}>
      {blocks.map((block, blockIdx) => {
        if (block.type === 'code' || block.type === 'mermaid') {
          return (
            <CodeBlockView
              key={`${block.type}-${blockIdx}`}
              label={block.type === 'mermaid' ? 'mermaid' : (block.lang ?? 'code')}
              code={block.value.trim()}
            />
          );
        }

        const segments = parseMarkdownTextSegments(block.value);
        return (
          <View key={`text-${blockIdx}`} style={{ gap: 8, width: '100%' }}>
            {segments.map((segment, segIdx) => {
              if (segment.type === 'table') {
                return <MarkdownTable key={`table-${blockIdx}-${segIdx}`} rows={segment.rows} />;
              }
              if (segment.type === 'code') {
                return (
                  <CodeBlockView
                    key={`code-${blockIdx}-${segIdx}`}
                    label="code"
                    code={segment.lines.join('\n')}
                  />
                );
              }
              return (
                <MarkdownParagraph
                  key={`para-${blockIdx}-${segIdx}`}
                  lines={segment.lines}
                  keyPrefix={`${blockIdx}-${segIdx}`}
                />
              );
            })}
          </View>
        );
      })}
    </View>
  );
}
