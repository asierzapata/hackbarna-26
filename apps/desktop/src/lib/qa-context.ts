const sensitiveKey = /^(?:.*(?:token|password|secret|credential|authorization|cookie)|api[_-]?key|.*[_-]api[_-]?key|ticket|lease|roomCode)$/i;

function redactText(text: string): string {
  return text
    .replace(/\b(?:https?|wss?):\/\/[^\s<>"']+/gi, (value) => {
      try {
        const url = new URL(value);
        url.username = "";
        url.password = "";
        url.search = "";
        url.hash = "";
        return url.toString();
      } catch { return "[REDACTED URL]"; }
    })
    .replace(/\bBearer\s+[^\s,;"']+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk-|gh[pousr]_|github_pat_)[A-Za-z0-9_-]{10,}/g, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED]")
    .replace(/((?:api[_-]?key|token|password|secret|credential|ticket|authorization)\s*[=:]\s*)[^\s,;"']+/gi, "$1[REDACTED]");
}

export function redactQaContext<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (key, item: unknown) => {
    if (sensitiveKey.test(key)) return "[REDACTED]";
    if (typeof item !== "string") return item;
    if (/^(?:data:|blob:)/i.test(item)) return "[OMITTED EMBEDDED ASSET]";
    return redactText(item);
  })) as T;
}

type Source = { read: (() => unknown) | null; last?: unknown };

export function createQaRegistry() {
  const routes = new Map<string, Map<string, Source>>();
  const captureSource = (source: Source) => {
    try {
      return { mounted: !!source.read, value: redactQaContext(source.read ? source.read() : source.last) };
    } catch (error) {
      return { error: redactText(error instanceof Error ? error.message : String(error)) };
    }
  };
  return {
    register(route: string, name: string, read: () => unknown) {
      for (const key of routes.keys()) if (key !== route) routes.delete(key);
      if (!routes.has(route)) routes.set(route, new Map());
      const sources = routes.get(route)!;
      const source: Source = { read };
      sources.set(name, source);
      return () => {
        if (sources.get(name) !== source) return;
        source.last = captureSource(source).value;
        source.read = null;
      };
    },
    capture(route: string): Record<string, unknown> {
      return Object.fromEntries([...(routes.get(route) ?? [])].map(([name, source]) => [name, captureSource(source)]));
    },
  };
}

export const qaRegistry = createQaRegistry();
