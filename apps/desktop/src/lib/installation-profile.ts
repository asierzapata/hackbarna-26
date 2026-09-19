import { UserSchema } from "@kan/protocol";

export interface InstallationProfile {
  schemaVersion: 1;
  installationId: string;
  secret: string;
  name: string;
  createdAt: string;
  onboardingVersion: number;
  firstCanvasId: string | null;
  onboardingCompletedAt: string | null;
  sharingHintDismissedAt: string | null;
}

const DB_NAME = "kan-identity";
const DB_VERSION = 1;
const STORE_NAME = "profile";
const PROFILE_KEY = "current";

let memoryProfileCache: InstallationProfile | null = null;
let profileCreationPromise: Promise<InstallationProfile> | null = null;

function generateSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function validateDisplayName(raw: string): { valid: boolean; normalized: string; error?: string } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { valid: false, normalized: "", error: "Please enter your name" };
  }
  const result = UserSchema.shape.name.safeParse(trimmed);
  if (!result.success) {
    return {
      valid: false,
      normalized: trimmed,
      error: trimmed.length > 80 ? "Name must be 80 characters or less" : "Invalid name format",
    };
  }
  return { valid: true, normalized: result.data };
}

function openIdentityDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is not available in this environment"));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Failed to open identity database"));
  });
}

export async function getInstallationProfile(): Promise<InstallationProfile | null> {
  if (memoryProfileCache) {
    return memoryProfileCache;
  }
  try {
    const db = await openIdentityDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(PROFILE_KEY);
      req.onsuccess = () => {
        const profile = (req.result as InstallationProfile) ?? null;
        memoryProfileCache = profile;
        resolve(profile);
      };
      req.onerror = () => reject(req.error ?? new Error("Failed to get profile from storage"));
    });
  } catch (err) {
    console.warn("Could not read installation profile from IndexedDB:", err);
    return memoryProfileCache;
  }
}

export async function saveInstallationProfile(profile: InstallationProfile): Promise<InstallationProfile> {
  const db = await openIdentityDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const req = store.put(profile, PROFILE_KEY);
    req.onsuccess = () => {
      memoryProfileCache = profile;
      resolve(profile);
    };
    req.onerror = () => reject(req.error ?? new Error("Failed to save installation profile"));
  });
}

export async function getOrCreateInstallationProfile(): Promise<InstallationProfile> {
  if (profileCreationPromise) return profileCreationPromise;

  const create = async () => {
    const existing = await getInstallationProfile();
    if (existing) return existing;
    const newProfile: InstallationProfile = {
      schemaVersion: 1,
      installationId: crypto.randomUUID(),
      secret: generateSecret(),
      name: "",
      createdAt: new Date().toISOString(),
      onboardingVersion: 1,
      firstCanvasId: null,
      onboardingCompletedAt: null,
      sharingHintDismissedAt: null,
    };
    return saveInstallationProfile(newProfile);
  };

  profileCreationPromise =
    typeof navigator !== "undefined" && navigator.locks
      ? navigator.locks.request("kan-installation-profile", create)
      : create();
  try {
    return await profileCreationPromise;
  } finally {
    profileCreationPromise = null;
  }
}

export async function dismissSharingHint(): Promise<void> {
  const profile = await getInstallationProfile();
  if (!profile || profile.sharingHintDismissedAt) return;
  profile.sharingHintDismissedAt = new Date().toISOString();
  await saveInstallationProfile(profile);
}
