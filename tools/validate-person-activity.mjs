import assert from 'node:assert/strict';
import {
  advancePersonActivity,
  expirePersonActivity,
  migratePersonActivityStore,
  summarizePersonActivity
} from '../tmp/person-activity-validation/personActivity.js';

const person = (trackId, box, zoneIds = ['operator-zone']) => ({
  trackId,
  trackConfirmed: true,
  className: 'person',
  task: 'detect',
  box,
  zoneIds
});

const pose = (trackId, box) => ({
  trackId,
  trackConfirmed: true,
  className: 'person',
  task: 'pose',
  box,
  zoneIds: ['operator-zone']
});

const frame = (detections, movingPoseId = null, output = '') => ({
  width: 1000,
  height: 600,
  detections,
  signals: movingPoseId === null ? [] : [{ kind: 'pose_moving', active: true, evidence: { trackId: movingPoseId } }],
  rules: output ? [{ output, active: true }] : []
});

const options = { scopeZoneIds: ['operator-zone'], absenceToleranceSeconds: 15 };
let records = advancePersonActivity([], 'camera-1', frame([
  person(12, [100, 100, 200, 400]),
  person(8, [300, 100, 400, 400]),
  person(11, [500, 100, 600, 400]),
  pose(101, [500, 100, 600, 400])
], 101, 'WORKER_WORKING'), 100, options);

assert.deepEqual(summarizePersonActivity(records), { visible: 3, working: 1, idle: 0, present: 2 }, 'all confirmed people must be counted while movement is assigned only to the spatially matching person');
assert.deepEqual(records.map((record) => record.displayId).sort((left, right) => left - right), [1, 2, 3], 'user-facing person IDs must start at 1 and remain sequential even when raw tracker IDs start at 8, 11, and 12');

records = advancePersonActivity(records, 'camera-1', frame([
  person(12, [100, 100, 200, 400]),
  person(8, [300, 100, 400, 400]),
  person(11, [500, 100, 600, 400]),
  pose(101, [500, 100, 600, 400])
], 101, 'WORKER_WORKING'), 110, options);

const movingPerson = records.find((record) => record.trackId === '11');
assert.equal(movingPerson.workingSeconds, 10, 'per-person working duration must accumulate between confirmed observations');
assert.equal(movingPerson.visits.length, 1, 'continuous visibility must remain one visit');

records = expirePersonActivity(records, 130, 15);
assert.equal(summarizePersonActivity(records).visible, 0, 'people must become not visible after the continuity tolerance');
assert.ok(records.every((record) => record.visits[0].endedAt === 110), 'the visit must close at the last confirmed observation');

records = advancePersonActivity(records, 'camera-1', frame([person(11, [500, 100, 600, 400])]), 140, options);
assert.equal(records.find((record) => record.trackId === '11').visits.length, 2, 'a person that reappears after absence must start a separate visit');
records = advancePersonActivity(records, 'camera-1', frame([person(11, [500, 100, 600, 400])], null, 'WORKER_IDLE'), 150, options);
records = advancePersonActivity(records, 'camera-1', frame([person(11, [500, 100, 600, 400])], null, 'WORKER_IDLE'), 160, options);
assert.equal(records.find((record) => record.trackId === '11').idleSeconds, 10, 'idle duration must be kept separately from working duration');

const migrated = migratePersonActivityStore({ 'camera-1': records });
assert.equal(migrated['camera-1'].find((record) => record.trackId === '11').state, 'not_visible', 'persisted identities must require a fresh frame before becoming visible after reload');
assert.equal(migrated['camera-1'].find((record) => record.trackId === '11').visits.length, 2, 'persisted visit history must survive migration');
assert.equal(migrated['camera-1'].find((record) => record.trackId === '11').displayId, records.find((record) => record.trackId === '11').displayId, 'user-facing person IDs must remain stable after reload');

const legacyWithoutDisplayIds = JSON.parse(JSON.stringify({ 'camera-1': records }));
legacyWithoutDisplayIds['camera-1'].forEach((record) => delete record.displayId);
const migratedLegacyIds = migratePersonActivityStore(legacyWithoutDisplayIds)['camera-1'].map((record) => record.displayId).sort((left, right) => left - right);
assert.deepEqual(migratedLegacyIds, [1, 2, 3], 'old activity records must safely receive clean sequential user-facing IDs');

console.log('Person activity validation passed: multi-person count, ID continuity, absence, reappearance, working/idle time, and persistence are correct.');
