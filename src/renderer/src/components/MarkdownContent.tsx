import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { highlightToHtml } from '../lib/highlight';

export interface CodeLocation {
  filePath: string;
  startLine: number;
  endLine?: number;
}

const FENCED_BLOCK = /```(\w[\w+-]*)?\n([\s\S]*?)```/g;
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

/** shiki 语言别名归一，模型写 `js` / `sh` 也能命中 */
const LANG_ALIAS: Record<string, string> = {
  js: 'javascript',
  ts: 'typescript',
  py: 'python',
  rb: 'ruby',
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  yml: 'yaml',
  'c++': 'cpp',
  'c#': 'csharp',
  cs: 'csharp',
  golang: 'go',
  rs: 'rust',
  kt: 'kotlin',
};

function CodeBlock({ lang, code }: { lang: string | null; code: string }): React.JSX.Element {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const normalized = lang ? (LANG_ALIAS[lang.toLowerCase()] ?? lang.toLowerCase()) : null;
    void highlightToHtml(code, normalized, 1).then((res) => {
      if (!cancelled) setHtml(res);
    });
    return () => {
      cancelled = true;
    };
  }, [lang, code]);

  if (html) {
    return (
      <div
        className="shiki-host my-3 overflow-x-auto rounded bg-black/20 p-3 font-mono text-xs leading-5"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }

  return (
    <pre className="my-3 overflow-x-auto rounded bg-black/20 p-3 font-mono text-xs leading-5">
      {code}
    </pre>
  );
}

export function MarkdownContent({
  text,
  onCodeClick,
}: {
  text: string;
  onCodeClick?: (loc: CodeLocation) => void;
}): React.JSX.Element {
  const parts = useMemo(() => {
    const blocks: Array<{ type: 'text' | 'mermaid' | 'code'; value: string; lang?: string }> = [];
    let last = 0;
    let match: RegExpExecArray | null;
    const re = new RegExp(FENCED_BLOCK.source, 'g');

    while ((match = re.exec(text)) !== null) {
      if (match.index > last) {
        blocks.push({ type: 'text', value: text.slice(last, match.index) });
      }
      const lang = match[1];
      const body = match[2] ?? '';
      if (lang === 'mermaid') {
        blocks.push({ type: 'mermaid', value: body });
      } else {
        blocks.push({ type: 'code', value: body, ...(lang ? { lang } : {}) });
      }
      last = match.index + match[0].length;
    }
    if (last < text.length) blocks.push({ type: 'text', value: text.slice(last) });
    if (blocks.length === 0) blocks.push({ type: 'text', value: text });
    return blocks;
  }, [text]);

  return (
    <div className="space-y-1 text-sm leading-relaxed">
      {parts.map((part, i) => {
        if (part.type === 'mermaid') return <MermaidBlock key={`m-${i}`} chart={part.value} />;
        if (part.type === 'code') {
          return <CodeBlock key={`c-${i}`} lang={part.lang ?? null} code={part.value} />;
        }
        return (
          <div key={`t-${i}`} className="whitespace-pre-wrap">
            {renderTextWithRefs(part.value, onCodeClick)}
          </div>
        );
      })}
    </div>
  );
}
