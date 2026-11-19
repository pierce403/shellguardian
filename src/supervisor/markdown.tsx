// A small, safe renderer for agent replies. It builds React elements only
// (never HTML strings), understands the handful of Markdown forms agents use,
// and shows everything else, including links, as plain text.
import type { ReactNode } from 'react';

type Block =
  | { kind: 'code'; text: string }
  | { kind: 'list'; ordered: boolean; start: number; items: string[] }
  | { kind: 'heading'; text: string }
  | { kind: 'paragraph'; text: string };

export function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ kind: 'paragraph', text: paragraph.join('\n') });
    paragraph = [];
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*```/.test(line)) {
      flush();
      const body: string[] = [];
      index += 1;
      // An unclosed fence (a reply still streaming) runs to the end.
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      blocks.push({ kind: 'code', text: body.join('\n') });
      continue;
    }
    const item = /^\s*(?:[-*•]|(\d{1,3})[.)])\s+(.*)$/.exec(line);
    if (item) {
      flush();
      const ordered = item[1] !== undefined;
      const last = blocks[blocks.length - 1];
      if (last?.kind === 'list' && last.ordered === ordered) last.items.push(item[2]);
      // A numbered list keeps the number it was written with, so a list that
      // resumes after a paragraph or a code block does not restart at 1.
      else blocks.push({ kind: 'list', ordered, start: Number(item[1] ?? 1), items: [item[2]] });
      continue;
    }
    const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: 'heading', text: heading[1] });
      continue;
    }
    if (line.trim() === '') {
      flush();
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return blocks;
}

/** Inline `code` and **bold**; everything else is text. */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  text.split(/(`[^`\n]+`)/g).forEach((part, i) => {
    if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) {
      out.push(<code key={i}>{part.slice(1, -1)}</code>);
      return;
    }
    part.split(/(\*\*[^*\n]+\*\*)/g).forEach((piece, j) => {
      if (piece.length > 4 && piece.startsWith('**') && piece.endsWith('**'))
        out.push(<strong key={`${i}-${j}`}>{piece.slice(2, -2)}</strong>);
      else if (piece) out.push(piece);
    });
  });
  return out;
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      {parseBlocks(text).map((block, index) => {
        if (block.kind === 'code')
          return (
            <pre key={index}>
              <code>{block.text}</code>
            </pre>
          );
        if (block.kind === 'heading') return <h4 key={index}>{inline(block.text)}</h4>;
        if (block.kind === 'list') {
          const items = block.items.map((item, i) => <li key={i}>{inline(item)}</li>);
          return block.ordered ? (
            <ol key={index} start={block.start}>
              {items}
            </ol>
          ) : (
            <ul key={index}>{items}</ul>
          );
        }
        return <p key={index}>{inline(block.text)}</p>;
      })}
    </div>
  );
}
