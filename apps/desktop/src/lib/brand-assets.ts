import { config } from "./config";

const knownBrands = [
  { match: "vonage", domain: "vonage.com", name: "Vonage" },
  { match: "cognition", domain: "cognition.ai", name: "Cognition" },
  { match: "nebius", domain: "nebius.ai", name: "Nebius" },
  { match: "preply", domain: "preply.com", name: "Preply" },
  { match: "glovo", domain: "glovoapp.com", name: "Glovo" },
  { match: "norrsken", domain: "norrsken.org", name: "Norrsken" },
] as const;

export function brandForText(value: string) {
  const normalized = value.trim().toLowerCase();
  return knownBrands.find(({ match }) => normalized.includes(match)) ?? null;
}

export function brandfetchImageUrl(domain: string) {
  return config.brandfetchClientId
    ? `https://cdn.brandfetch.io/domain/${domain}/w/512/h/512/fallback/lettermark?c=${encodeURIComponent(config.brandfetchClientId)}`
    : null;
}

export function faviconImageUrl(domain: string) {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`;
}

export function brandInitials(name: string) {
  return name.replace(/[^a-z0-9]/gi, "").slice(0, 2).toUpperCase();
}
