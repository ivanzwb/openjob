import { useEffect, useId, useMemo, useRef } from 'react';

export interface CodeLocation {
  filePath: string;
  startLine: number;
  endLine?: number;
}

const MERMAID_BLOCK = /```mermaid\n([\s\S]*?)```/g;
const FILE_REF =
  /(?<![/\w])((?:[\w.-]+\/)+[\w.-]+\.\w+|(?:[\w.-]+\.\w+)):(\d+)(?:-(\d+))?/g;

function renderTextWithRefs(
  text: string,
  onCodeClick?: (loc: CodeLocation) => void,
): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  const re = new RegExp(FILE_REF.source, 'g');

  while ((match = re.exec(text)) !== null) {
    if (match.index > last) {
      nodes.push(text.slice(last, match.index));
    }
    const filePath = match[1]!;
    const startLine = Number(match[2]);
    const endLine = match[3] ? Number(match[3]) : undefined;
    const label = `${filePath}:${startLine}${endLine ? `-${endLine}` : ''}`;
    nodes.push(
      onCodeClick ? (
        <button
          key={`${match.index}-${label}`}
          type="button"
          onClick={() => onCodeClick({ filePath, startLine, endLine })}
          className="font-mono text-emerald-400 hover:underline"
        >
          {label}
        </button>
      ) : (
        <span key={`${match.index}-${label}`} className="font-mono text-emerald-400">
          {label}
        </span>
      ),
    );
    last = match.index + match[0].length;
  }

  if (last < text.length) nodes.push(text.slice(last));
  return nodes.length ? nodes : [text];
}

function MermaidBlock({ chart }: { chart: string }): React.JSX.Element {
  const id = useId().replace(/:/g, '');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const mermaid = (await import('mermaid')).default;
      mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'loose' });
      if (cancelled || !ref.current) return;
      try {
        const { svg } = await mermaid.render(`mmd-${id}`, chart.trim());
        if (!cancelled && ref.current) ref.current.innerHTML = svg;
      } catch {
        if (!cancelled && ref.current) {
          ref.current.textContent = chart;
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [chart, id]);

  return <div ref={ref} className="my-3 overflow-x-auto rounded bg-black/20 p-3" />;
}

export function MarkdownContent({
  text,
  onCodeClick,
}: {
  text: string;
  onCodeClick?: (loc: CodeLocation) => void;
}): React.JSX.Element {
  const parts = useMemo(() => {
    const blocks: Array<{ type: 'text' | 'mermaid'; value: string }> = [];
    let last = 0;
    let match: RegExpExecArray | null;
    const re = new RegExp(MERMAID_BLOCK.source, 'g');

    while ((match = re.exec(text)) !== null) {
      if (match.index > last) {
        blocks.push({ type: 'text', value: text.slice(last, match.index) });
      }
      blocks.push({ type: 'mermaid', value: match[1]! });
      last = match.index + match[0].length;
    }
    if (last < text.length) blocks.push({ type: 'text', value: text.slice(last) });
    if (blocks.length === 0) blocks.push({ type: 'text', value: text });
    return blocks;
  }, [text]);

  return (
    <div className="space-y-1 text-sm leading-relaxed">
      {parts.map((part, i) =>
        part.type === 'mermaid' ? (
          <MermaidBlock key={`m-${i}`} chart={part.value} />
        ) : (
          <div key={`t-${i}`} className="whitespace-pre-wrap">
            {renderTextWithRefs(part.value, onCodeClick)}
          </div>
        ),
      )}
    </div>
  );
}
