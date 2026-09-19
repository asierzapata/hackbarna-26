import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupMockIndexedDB, clearMockIndexedDB } from "./mock-idb";
import {
  validateDisplayName,
  getInstallationProfile,
  getOrCreateInstallationProfile,
  dismissSharingHint,
} from "../src/lib/installation-profile";
import { completeOnboarding, isOnboardingComplete } from "../src/lib/onboarding";
import { getCanvasEntry } from "../src/lib/canvas-repository";

beforeEach(() => {
  setupMockIndexedDB();
});

test("display name validation and normalization", () => {
  // Whitespace only is rejected
  assert.equal(validateDisplayName("").valid, false);
  assert.equal(validateDisplayName("   ").valid, false);
  assert.equal(validateDisplayName("\t\n ").valid, false);

  // Over limit (80 chars) is rejected
  const tooLong = "a".repeat(81);
  assert.equal(validateDisplayName(tooLong).valid, false);

  // Normalization trims leading/trailing but preserves interior spacing
  const res1 = validateDisplayName("  Ada Lovelace  ");
  assert.equal(res1.valid, true);
  assert.equal(res1.normalized, "Ada Lovelace");

  // Unicode and accents supported
  const res2 = validateDisplayName("  Émile Zola  ");
  assert.equal(res2.valid, true);
  assert.equal(res2.normalized, "Émile Zola");

  const res3 = validateDisplayName("山田 太郎");
  assert.equal(res3.valid, true);
  assert.equal(res3.normalized, "山田 太郎");
});

test("installation identity is stable and generates cryptographic credentials", async () => {
  clearMockIndexedDB();
  const p1 = await getOrCreateInstallationProfile();

  // Valid UUID v4
  assert.match(p1.installationId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  // 32-byte secret encoded as 64 lowercase hex chars
  assert.match(p1.secret, /^[0-9a-f]{64}$/);
  assert.equal(p1.onboardingCompletedAt, null);

  // Idempotency: reading again returns the exact same credentials
  const p2 = await getOrCreateInstallationProfile();
  assert.equal(p2.installationId, p1.installationId);
  assert.equal(p2.secret, p1.secret);
});

test("onboarding completion is atomic and idempotent", async () => {
  clearMockIndexedDB();
  assert.equal(await isOnboardingComplete(), false);

  const result1 = await completeOnboarding("Grace Hopper");
  assert.equal(result1.profile.name, "Grace Hopper");
  assert.ok(result1.firstCanvasId);
  assert.ok(result1.profile.onboardingCompletedAt);
  assert.equal(await isOnboardingComplete(), true);

  // First canvas was durably registered in the catalog
  const canvas = await getCanvasEntry(result1.firstCanvasId);
  assert.ok(canvas);
  assert.equal(canvas.id, result1.firstCanvasId);
  assert.equal(canvas.name, "My first canvas");
  assert.equal(canvas.mode, "offline");

  // Calling completeOnboarding again reuses the reserved firstCanvasId
  const result2 = await completeOnboarding("Grace Hopper");
  assert.equal(result2.firstCanvasId, result1.firstCanvasId);
  assert.equal(result2.profile.installationId, result1.profile.installationId);
});

test("sharing hint dismissal persists independently of onboarding", async () => {
  clearMockIndexedDB();
  await completeOnboarding("Margaret Hamilton");

  let profile = await getInstallationProfile();
  assert.equal(profile?.sharingHintDismissedAt, null);

  await dismissSharingHint();
  profile = await getInstallationProfile();
  assert.ok(profile?.sharingHintDismissedAt);

  // Onboarding status is unchanged
  assert.equal(await isOnboardingComplete(), true);
});
