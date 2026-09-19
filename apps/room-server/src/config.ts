import { createVonageProvider, type VideoProvider } from "./video";
import { JevClassifier, type Classifier } from "./classifier";
import { DEFAULT_ORIGINS } from "./server";

export interface ServerConfig {
  port: number;
  dbPath: string;
  allowedOrigins: string[];
  classifier: Classifier | null;
  video: VideoProvider | null;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const origins = env.KAN_ALLOWED_ORIGINS?.split(",").map((s) => s.trim()) ?? DEFAULT_ORIGINS;
  const mode = env.KAN_CLASSIFIER ?? (env.AI_GATEWAY_API_KEY ? "jev" : "disabled");
  if (mode !== "disabled" && mode !== "jev") throw new Error("invalid KAN_CLASSIFIER");
  if (mode === "jev" && !env.AI_GATEWAY_API_KEY) throw new Error("jev requires AI_GATEWAY_API_KEY");
  const port = Number(env.PORT ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid PORT");
  if (!origins.length || origins.some((origin) => {
    try { const url = new URL(origin); return !["http:", "https:", "tauri:"].includes(url.protocol) || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" || origin !== `${url.protocol}//${url.host}`; } catch { return true; }
  })) throw new Error("invalid KAN_ALLOWED_ORIGINS");
  if (!!env.VONAGE_APPLICATION_ID !== !!env.VONAGE_PRIVATE_KEY) throw new Error("incomplete Vonage configuration");
  const classifier = mode === "disabled" ? null : new JevClassifier();
  const video =
    env.VONAGE_APPLICATION_ID && env.VONAGE_PRIVATE_KEY
      ? createVonageProvider(env.VONAGE_APPLICATION_ID, env.VONAGE_PRIVATE_KEY, env.VONAGE_CAPTION_LANGUAGE || "en-US")
      : null;
  return {
    port,
    dbPath: env.KAN_DATA_DIR ? `${env.KAN_DATA_DIR}/kan.sqlite` : "./data/kan.sqlite",
    allowedOrigins: origins,
    classifier,
    video,
  };
}
