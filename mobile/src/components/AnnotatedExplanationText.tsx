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
import { theme } from '../theme';

function markerStyle(markers: InlineAnnotation[]): TextStyle {
  const { hasNote, hasElaboration } = markerKinds(markers);
  if (hasNote && hasElaboration) {
    return {
      fontWeight: '700',
      color: '#fcd34d',
      textDecorationLine: 'underline',
      textDecorationStyle: 'dashed',
      textDecorationColor: '#38bdf8',
      borderBottomWidth: 2,
      borderBottomColor: '#fbbf24',
    };
  }
  if (hasNote) {
    return {
      fontWeight: '700',
      color: '#fcd34d',
      textDecorationLine: 'underline',
      textDecorationStyle: 'solid',
      textDecorationColor: '#fbbf24',
    };
  }
  return {
    fontWeight: '700',
    color: '#7dd3fc',
    textDecorationLine: 'underline',
    textDecorationStyle: 'dashed',
    textDecorationColor: '#38bdf8',
  };
}

function markerGlyphStyle(kind: InlineMarkerKind): TextStyle {
  if (kind === 'note') {
    return {
      fontSize: 9,
      lineHeight: 12,
      color: '#fbbf24',
      textAlignVertical: 'bottom',
    };
  }
  return {
    fontSize: 9,
    lineHeight: 8,
    color: '#38bdf8',
    transform: [{ translateY: -3 }],
  };
}

export function AnnotatedExplanationText({
  contentMd,
  highlights,
  annotations,
  onSegmentPress,
}: {
  contentMd: string;
  highlights: TextHighlight[];
  annotations: Annotation[];
  onSegmentPress?: (text: string, start: number, markers?: InlineAnnotation[]) => void;
}): React.JSX.Element {
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
          return (
            <Text
              key={i}
              style={highlightTextStyle(seg.color)}
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
        const base = markerStyle(seg.markers);
        const hl = seg.highlightColor ? highlightTextStyle(seg.highlightColor) : null;
        const { hasNote, hasElaboration } = markerKinds(seg.markers);
        return (
          <Text
            key={i}
            style={hl ? { ...base, backgroundColor: hl.backgroundColor, color: hl.color } : base}
            onPress={
              onSegmentPress
                ? () => onSegmentPress(seg.text, seg.start, seg.markers)
                : undefined
            }
          >
            {seg.text}
            {hasNote && <Text style={markerGlyphStyle('note')}>{MARKER_ICON.note}</Text>}
            {hasElaboration && (
              <Text style={markerGlyphStyle('elaboration')}>{MARKER_ICON.elaboration}</Text>
            )}
          </Text>
        );
      })}
    </Text>
  );
}
