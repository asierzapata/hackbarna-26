import {
  getInstallationProfile,
  getOrCreateInstallationProfile,
  saveInstallationProfile,
  validateDisplayName,
  type InstallationProfile,
} from "./installation-profile";
import { createOfflineCanvas, getCanvasEntry } from "./canvas-repository";

export interface OnboardingResult {
  profile: InstallationProfile;
  firstCanvasId: string;
}

export async function isOnboardingComplete(): Promise<boolean> {
  const profile = await getInstallationProfile();
  return Boolean(
    profile &&
    profile.onboardingCompletedAt &&
    profile.name &&
    profile.onboardingVersion >= 2,
  );
}

export async function completeOnboarding(
  displayName: string,
): Promise<OnboardingResult> {
  const validation = validateDisplayName(displayName);
  if (!validation.valid) {
    throw new Error(validation.error ?? "Invalid display name");
  }

  const profile = await getOrCreateInstallationProfile();
  profile.name = validation.normalized;

  // Atomicity: reserve firstCanvasId if not already set, before creating catalog entry
  if (!profile.firstCanvasId) {
    profile.firstCanvasId = crypto.randomUUID();
    await saveInstallationProfile(profile);
  }

  const firstCanvasId = profile.firstCanvasId;

  // Durably initialize the first offline canvas if not already in catalog
  const existingCanvas = await getCanvasEntry(firstCanvasId);
  if (!existingCanvas) {
    await createOfflineCanvas({
      id: firstCanvasId,
      name: "My first canvas",
    });
  }

  // Mark onboarding complete only after document catalog entry exists
  profile.onboardingCompletedAt = new Date().toISOString();
  profile.onboardingVersion = 2;
  await saveInstallationProfile(profile);

  return {
    profile,
    firstCanvasId,
  };
}
