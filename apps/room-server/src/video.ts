import { Auth } from "@vonage/auth";
import { Vonage } from "@vonage/server-sdk";

export interface VideoProvider {
  applicationId: string;
  createSession(): Promise<{ sessionId: string }>;
  generateClientToken(sessionId: string, opts: { role: string; expireTime: number; data: string }): string;
}

export function createVonageProvider(applicationId: string, privateKey: string): VideoProvider {
  const vonage = new Vonage(new Auth({ applicationId, privateKey }), { timeout: 5000 });
  return {
    applicationId,
    createSession: async () => {
      const session = await vonage.video.createSession();
      return { sessionId: session.sessionId };
    },
    generateClientToken: (sessionId, opts) => vonage.video.generateClientToken(sessionId, opts),
  };
}
