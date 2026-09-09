import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

type SafeMarkdownProps = {
  content: string;
};

function isSafeExternalLink(href: string | undefined): boolean {
  return Boolean(href && (/^(https?:|mailto:|tel:)/i.test(href) || href.startsWith('#')));
}

const COMPONENTS: Components = {
  a: ({ href, children }) => isSafeExternalLink(href) ? (
    <a
      href={href}
      className="text-blue-600 underline-offset-2 hover:underline dark:text-blue-400"
      target={href?.startsWith('#') ? undefined : '_blank'}
      rel="noopener noreferrer"
    >
      {children}
    </a>
  ) : <span>{children}</span>,
  // Public snapshots never load remote images: even an ordinary <img> can be
  // a tracking pixel, and workspace-relative paths must not reach this page.
  img: ({ alt }) => <span className="text-muted-foreground">[Image omitted{alt ? `: ${alt}` : ''}]</span>,
  pre: ({ children }) => (
    <pre className="my-3 overflow-x-auto rounded-xl border border-border bg-muted/60 p-4 text-sm">
      {children}
    </pre>
  ),
  code: ({ children, className }) => (
    <code className={className || 'rounded bg-muted px-1.5 py-0.5 font-mono text-[0.9em]'}>
      {children}
    </code>
  ),
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto rounded-lg border border-border">
      <table className="min-w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border-b border-border bg-muted/60 px-3 py-2 text-left">{children}</th>,
  td: ({ children }) => <td className="border-b border-border/60 px-3 py-2 align-top">{children}</td>,
};

/** Used by ProjectGuide and PublicShareViewer to render Markdown without raw HTML, local links or remote images. */
export default function SafeMarkdown({ content }: SafeMarkdownProps) {
  return (
    <ReactMarkdown skipHtml remarkPlugins={[remarkGfm]} components={COMPONENTS}>
      {content}
    </ReactMarkdown>
  );
}
