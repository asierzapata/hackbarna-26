import { z } from "zod";

/**
 * Vite injects `""` for a key that is present but blank in `.env.local`, and
 * `.min(1).optional()` rejects that: a blank line crashed the whole app on
 * boot. Both keys are documented as optional with runtime fallbacks (MapLibre
 * demo tiles, a favicon), so blank means absent.
 */
const optionalKey = z
  .string()
  .optional()
  .transform((value) => (value?.trim() ? value : undefined));

const env = z.object({
  VITE_MAPTILER_KEY: optionalKey,
  VITE_BRANDFETCH_CLIENT_ID: optionalKey,
}).parse(import.meta.env);

export const config = {
  maptilerKey: env.VITE_MAPTILER_KEY,
  brandfetchClientId: env.VITE_BRANDFETCH_CLIENT_ID,
};
