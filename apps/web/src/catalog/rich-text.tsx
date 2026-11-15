import type { ReactNode } from 'react';

/**
 * Rich text (D13): a Markdown subset rendered as React elements, never as HTML, so nothing in the
 * text can run or style the page. Paragraphs, "- " lists, **bold**, *italic*, `code`, and
 * [links](https://…) with http or https only.
 */
export function RichText({ text }: { text: string }) {
  const blocks = text.replace(/\r\n?/g, '\n').split(/\n{2,}/);
  return (
    <div className="rich-text">
      {blocks.map((block, i) => {
        const lines = block.split('\n');
        if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
          return (
            <ul key={i}>
              {lines.map((l, j) => (
                <li key={j}>{inline(l.replace(/^\s*[-*]\s+/, ''))}</li>
              ))}
            </ul>
          );
        }
        return (
          <p key={i}>
            {lines.map((l, j) => (
              <span key={j}>
                {j > 0 ? <br /> : null}
                {inline(l)}
              </span>
            ))}
          </p>
        );
      })}
    </div>
  );
}

const TOKEN = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g;

function inline(text: string): ReactNode[] {
  return text.split(TOKEN).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4)
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2)
      return <code key={i}>{part.slice(1, -1)}</code>;
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2)
      return <em key={i}>{part.slice(1, -1)}</em>;
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part);
    if (link) {
      const href = link[2]!;
      return /^https?:\/\//i.test(href) ? (
        <a key={i} href={href} target="_blank" rel="noopener noreferrer nofollow">
          {link[1]}
        </a>
      ) : (
        link[1]
      );
    }
    return part;
  });
}
