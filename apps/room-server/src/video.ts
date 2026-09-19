import { existsSync, readFileSync } from "node:fs";

import { Auth } from "@vonage/auth";
import { Vonage } from "@vonage/server-sdk";

export interface VideoProvider {
  applicationId: string;
  createSession(): Promise<{ sessionId: string }>;
  generateClientToken(sessionId: string, opts: { role: string; expireTime: number; data: string }): string;
}

const PEM_HEADER = "-----BEGIN";

/**
 * Accepts the PEM itself, a path to it, a base64 blob, or a PEM whose newlines
 * were escaped as `\n`. A multi-line PEM does not survive a hosted env-var
 * field, so the deployed server is given the base64 form; a path is the
 * convenient local one.
 */
export function normalizePrivateKey(raw: string): string {
  const value = raw.trim();
  if (!value) throw new Error("empty Vonage private key");
  if (existsSync(value)) return readFileSync(value, "utf8");
  if (value.includes(PEM_HEADER)) return value.includes("\\n") ? value.replace(/\\n/g, "\n") : value;
  const decoded = Buffer.from(value, "base64").toString("utf8");
  if (!decoded.includes(PEM_HEADER)) throw new Error("VONAGE_PRIVATE_KEY is neither a PEM, a path to one, nor base64 of one");
  return decoded;
}

export function createVonageProvider(applicationId: string, privateKey: string): VideoProvider {
  const vonage = new Vonage(new Auth({ applicationId, privateKey: normalizePrivateKey(privateKey) }), { timeout: 5000 });
  return {
    applicationId,
    createSession: async () => {
      const session = await vonage.video.createSession();
      return { sessionId: session.sessionId };
    },
    generateClientToken: (sessionId, opts) => vonage.video.generateClientToken(sessionId, opts),
  };
}
