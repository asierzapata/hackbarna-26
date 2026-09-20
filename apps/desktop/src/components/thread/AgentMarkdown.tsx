import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const remarkPlugins = [remarkGfm];
const components: Components = {
  a: ({ children, href, title }) => href ? (
    <a href={href} title={title} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ) : <span>{children}</span>,
  img: ({ src, alt, title }) => src ? (
    <img src={src} alt={alt} title={title} loading="lazy" />
  ) : <span>{alt}</span>,
  table: ({ children }) => (
    <div className="agent-markdown__table" role="region" aria-label="Table" tabIndex={0}>
      <table>{children}</table>
    </div>
  ),
};

export function AgentMarkdown({ children }: { children: string }) {
  return (
    <div className="agent-markdown">
      <ReactMarkdown remarkPlugins={remarkPlugins} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
