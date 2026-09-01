import { Fragment, useMemo } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { visibleMarkdownBlocks } from '../lib/markdownBlocks';
import { normalizeDisplayText } from '../lib/markdownDisplay';
import { groupParagraphRuns } from '../lib/markdownRuns';
import {
  parseMarkdownLine,
  parseMarkdownTextSegments,
  type MarkdownLine,
} from '@shared/lib/markdownSegments';
import { parseInlineMarkdown } from '@shared/lib/markdownInline';
import { useTheme } from '../theme';

const TABLE_CELL_MIN_WIDTH = 88;
const TABLE_CELL_MAX_WIDTH = 240;

/** 行内标记在 RN 里只能靠嵌套 Text 表达，样式与桌面端保持同一套语义 */
function InlineText({ source }: { source: string }): React.JSX.Element {
  const theme = useTheme();
  return (
    <>
      {parseInlineMarkdown(source).map((token, i) => {
        if (token.kind === 'bold') {
          return (
            <Text key={i} style={{ fontWeight: '700' }}>
              {token.text}
            </Text>
          );
        }
        if (token.kind === 'italic') {
          return (
            <Text key={i} style={{ fontStyle: 'italic' }}>
              {token.text}
            </Text>
          );
        }
        if (token.kind === 'code') {
          return (
            <Text key={i} style={{ fontFamily: 'monospace', color: theme.accent }}>
              {token.text}
            </Text>
          );
        }
        if (token.kind === 'link') {
          return (
            <Text key={i} style={{ color: theme.accent, textDecorationLine: 'underline' }}>
              {token.text}
            </Text>
          );
        }
        return <Text key={i}>{token.text}</Text>;
      })}
    </>
  );
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
              <InlineText source={cell} />
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
                <InlineText source={cell} />
              </Text>
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

/** 行首标记：项目符号统一成 •，有序列表保留模型给的编号 */
function lineMarker(line: string, parsed: MarkdownLine): string {
  if (parsed.kind === 'bullet') return '• ';
  if (parsed.kind === 'numbered') return line.slice(0, parsed.contentStart);
  return '';
}

function MarkdownParagraph({ lines, keyPrefix }: { lines: string[]; keyPrefix: string }): React.JSX.Element {
  const theme = useTheme();
  const trimmed = lines
    .map((line) => line.trim())
    .filter(Boolean);
  const runs = groupParagraphRuns(trimmed);

  return (
    <View style={{ gap: 4 }}>
      {runs.map((run, runIdx) => {
        const key = `${keyPrefix}-${runIdx}`;

        if (run.kind === 'quote') {
          return (
            <Text
              key={key}
              selectable
              style={{
                color: theme.muted,
                fontSize: 13,
                lineHeight: 20,
                borderLeftWidth: 2,
                borderLeftColor: theme.border,
                paddingLeft: 8,
              }}
            >
              <InlineText source={parseMarkdownLine(run.line).text} />
            </Text>
          );
        }

        return (
          <Text key={key} selectable style={{ color: theme.text, fontSize: 13, lineHeight: 20 }}>
            {run.lines.map((line, lineIdx) => {
              const parsed = parseMarkdownLine(line);
              return (
                <Fragment key={lineIdx}>
                  {/* 换行放在嵌套 Text 外面，免得它跟着标题的字号一起变高 */}
                  {lineIdx > 0 ? '\n' : null}
                  {parsed.kind === 'heading' ? (
                    <Text style={{ fontSize: parsed.level === 1 ? 16 : 14, fontWeight: '700' }}>
                      <InlineText source={parsed.text} />
                    </Text>
                  ) : (
                    <Text>
                      {lineMarker(line, parsed)}
                      <InlineText source={parsed.text} />
                    </Text>
                  )}
                </Fragment>
              );
            })}
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
