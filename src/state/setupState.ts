import { readStoredJson, readStoredString, writeStoredJson } from './persistence';
import type { SetupDraftRecord } from './migrations';

const setupDraftStorageKey = 'optivision-setup-drafts-v1';
const currentSetupFlowVersion = 3;

function migrateSetupStep(flowVersion: number | undefined, currentStep: number) {
  if (flowVersion === currentSetupFlowVersion) return currentStep;
  // v2 introduced the plant/camera-first flow. v3 adds Monitoring Metrics
  // immediately after Display Parameters, so only later saved steps move.
  if (flowVersion === 2) return currentStep >= 6 ? currentStep + 1 : currentStep;
  const phaseTwoStep = currentStep + 1;
  return phaseTwoStep >= 6 ? phaseTwoStep + 1 : phaseTwoStep;
}

function readAllDrafts() {
  return readStoredJson<Record<string, SetupDraftRecord>>(setupDraftStorageKey, {});
}

export function readSetupDraft(cameraId: string, legacyStepKey: string, maximumStep: number): SetupDraftRecord {
  const saved = readAllDrafts()[cameraId];
  if (saved?.cameraId === cameraId) {
    const currentStep = Number.isInteger(saved.currentStep) ? saved.currentStep : 0;
    const migratedStep = migrateSetupStep(saved.flowVersion, currentStep);
    const migrated = {
      ...saved,
      flowVersion: currentSetupFlowVersion,
      currentStep: Math.max(0, Math.min(maximumStep, migratedStep)),
      updatedAt: Date.now()
    };
    if (saved.flowVersion !== currentSetupFlowVersion) writeSetupDraft(migrated);
    return migrated;
  }

  const legacyStep = Number(readStoredString(legacyStepKey));
  const currentStep = Number.isInteger(legacyStep) ? Math.max(0, Math.min(maximumStep, legacyStep + 2)) : 0;
  const migrated = { flowVersion: currentSetupFlowVersion, cameraId, currentStep, updatedAt: Date.now() };
  writeSetupDraft(migrated);
  return migrated;
}

export function writeSetupDraft(draft: SetupDraftRecord) {
  const drafts = readAllDrafts();
  return writeStoredJson(setupDraftStorageKey, { ...drafts, [draft.cameraId]: draft });
}

export { setupDraftStorageKey };
