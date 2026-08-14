import { useMemo } from 'react';
import { Text, type TextStyle } from 'react-native';
import type { Annotation } from '@shared/entities';
import { MARKER_ICON, markerKinds, type InlineMarkerKind } from '@shared/inlineMarkers';
import {
  buildDisplaySegments,
  filterInlineAnnotations,
  type InlineAnnotation,
  type TextHighlight,
} from '../lib/annotationMarks';
import { highlightTextStyle } from '../lib/highlightStyle';
import { useTheme, type Palette } from '../theme';

function markerStyle(markers: InlineAnnotation[], theme: Palette): TextStyle {
  const { hasNote, hasElaboration } = markerKinds(markers);
  if (hasNote && hasElaboration) {
    return {
      fontWeight: '700',
      color: theme.tone.amber.text,
      textDecorationLine: 'underline',
      textDecorationStyle: 'dashed',
      textDecorationColor: theme.tone.sky.text,
      borderBottomWidth: 2,
      borderBottomColor: theme.tone.amber.text,
    };
  }
  if (hasNote) {
    return {
      fontWeight: '700',
      color: theme.tone.amber.text,
      textDecorationLine: 'underline',
      textDecorationStyle: 'solid',
      textDecorationColor: theme.tone.amber.text,
    };
  }
  return {
    fontWeight: '700',
    color: theme.tone.sky.text,
    textDecorationLine: 'underline',
    textDecorationStyle: 'dashed',
    textDecorationColor: theme.tone.sky.text,
  };
}

function markerGlyphStyle(kind: InlineMarkerKind, theme: Palette): TextStyle {
  if (kind === 'note') {
    return {
      fontSize: 9,
      lineHeight: 12,
      color: theme.tone.amber.text,
      textAlignVertical: 'bottom',
    };
  }
  return {
    fontSize: 9,
    lineHeight: 8,
    color: theme.tone.sky.text,
    transform: [{ translateY: -3 }],
  };
}

export function AnnotatedExplanationText({
  contentMd,
  highlights,
  annotations,
  onSegmentPress,
  focusedMarkId,
}: {
  contentMd: string;
  highlights: TextHighlight[];
  annotations: Annotation[];
  onSegmentPress?: (text: string, start: number, markers?: InlineAnnotation[]) => void;
  focusedMarkId?: string | null;
}): React.JSX.Element {
  const theme = useTheme();
  const inlineMarks = useMemo(() => filterInlineAnnotations(annotations), [annotations]);
  const segments = useMemo(
    () => buildDisplaySegments(contentMd, highlights, inlineMarks),
    [contentMd, highlights, inlineMarks],
  );

  return (
    <Text
      selectable
      style={{ color: theme.text, fontSize: 13, lineHeight: 20 }}
    >
      {segments.map((seg, i) => {
        if (seg.kind === 'plain') {
          return <Text key={i}>{seg.text}</Text>;
        }
        if (seg.kind === 'highlight') {
          const focused =
            Boolean(focusedMarkId) &&
            annotations.some(
              (a) =>
                a.id === focusedMarkId &&
                a.kind === 'highlight' &&
                a.selectedText?.trim() === seg.text.trim() &&
                (a.selectionStart == null || a.selectionStart === seg.start),
            );
          return (
            <Text
              key={i}
              style={[
                highlightTextStyle(seg.color),
                focused
                  ? { borderWidth: 1, borderColor: theme.tone.amber.text, borderRadius: 2 }
                  : null,
              ]}
              onPress={
                onSegmentPress
                  ? () => onSegmentPress(seg.text, seg.start)
                  : undefined
              }
            >
              {seg.text}
            </Text>
          );
        }
        const base = markerStyle(seg.markers, theme);
        const hl = seg.highlightColor ? highlightTextStyle(seg.highlightColor) : null;
        const { hasNote, hasElaboration } = markerKinds(seg.markers);
        const focused = Boolean(focusedMarkId) && seg.markers.some((m) => m.id === focusedMarkId);
        return (
          <Text
            key={i}
            style={[
              hl ? { ...base, backgroundColor: hl.backgroundColor, color: hl.color } : base,
              focused
                ? { borderWidth: 1, borderColor: theme.tone.amber.text, borderRadius: 2 }
                : null,
            ]}
            onPress={
              onSegmentPress
                ? () => onSegmentPress(seg.text, seg.start, seg.markers)
                : undefined
            }
          >
            {seg.text}
            {hasNote && <Text style={markerGlyphStyle('note', theme)}>{MARKER_ICON.note}</Text>}
            {hasElaboration && (
              <Text style={markerGlyphStyle('elaboration', theme)}>{MARKER_ICON.elaboration}</Text>
            )}
          </Text>
        );
      })}
    </Text>
  );
}
