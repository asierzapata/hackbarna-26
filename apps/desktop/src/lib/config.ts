import { z } from "zod";

const env = z.object({
  VITE_MAPTILER_KEY: z.string().min(1).optional(),
  VITE_BRANDFETCH_CLIENT_ID: z.string().min(1).optional(),
}).parse(import.meta.env);

export const config = {
  maptilerKey: env.VITE_MAPTILER_KEY,
  brandfetchClientId: env.VITE_BRANDFETCH_CLIENT_ID,
};
