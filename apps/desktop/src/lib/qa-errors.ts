import { redactQaContext } from "./qa-context";

const errors: { at: string; message: string; stack?: string }[] = [];

export function recordQaError(error: unknown) {
  errors.push(redactQaContext({
    at: new Date().toISOString(),
    message: (error instanceof Error ? error.message : String(error)).slice(0, 4000),
    stack: error instanceof Error ? error.stack?.slice(0, 8000) : undefined,
  }));
  if (errors.length > 50) errors.shift();
}

export function getQaErrors() { return [...errors]; }
