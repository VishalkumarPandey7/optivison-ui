import assert from 'node:assert/strict';
import {
  isReadableJourney,
  migrateLifecycleAutomations,
  migrateLprProcesses,
  migratePlantsAndCameras
} from '../tmp/migration-validation/migrations.js';

const legacyCameras = [
  {
    id: 'camera-1', name: 'Existing entry camera', location: 'Plant A', department: 'Assembly',
    configuration: { useCase: 'lpr', zones: [{ id: 'number-plate-zone', name: 'Plate' }], customField: { preserve: true } }
  },
  {
    id: 'camera-custom-id', name: 'Existing line camera', location: 'Plant A', department: 'Packaging',
    configuration: { useCase: 'conveyor', zones: [], rules: [{ id: 'existing-rule' }] }
  },
  {
    id: 'camera-7', name: 'Existing exit camera', location: 'Plant B', department: 'Dispatch',
    configuration: { useCase: 'lpr', zones: [] }
  }
];

const firstVisionMigration = migratePlantsAndCameras(legacyCameras, []);
const secondVisionMigration = migratePlantsAndCameras(firstVisionMigration.cameras, firstVisionMigration.plants);
assert.deepEqual(firstVisionMigration, secondVisionMigration, 'camera/plant migration must be idempotent');
assert.deepEqual(firstVisionMigration.cameras.map((camera) => camera.id), legacyCameras.map((camera) => camera.id), 'camera IDs must remain unchanged');
assert.equal(firstVisionMigration.cameras[0].configuration.customField.preserve, true, 'unknown camera configuration must survive');
assert.equal(firstVisionMigration.cameras[0].plantId, firstVisionMigration.cameras[1].plantId, 'same locations must share one plant');
assert.notEqual(firstVisionMigration.cameras[0].plantId, firstVisionMigration.cameras[2].plantId, 'different locations must remain separate plants');
assert.equal(firstVisionMigration.plants.length, 2, 'one plant should be created per unique location');
assert.equal(firstVisionMigration.cameras[0].configuration.monitoringMetrics.length, 6, 'default card metrics must be created');

const legacyProcesses = [{
  id: 'vehicle-service-flow',
  name: 'Existing process',
  stages: [
    { id: 'station-original-entry', name: 'Main Gate', type: 'entry' },
    { id: 'station-original-service', name: 'Service Bay 1', type: 'station' },
    { id: 'station-original-exit', name: 'Exit Gate', type: 'exit' }
  ]
}];
const migratedProcesses = migrateLprProcesses(legacyProcesses);
assert.deepEqual(
  migratedProcesses[0].stages.map((stage) => stage.id),
  legacyProcesses[0].stages.map((stage) => stage.id),
  'station IDs must remain unchanged'
);
assert.deepEqual(migratedProcesses[0].stages.map((stage) => stage.order), [0, 1, 2], 'station order must follow the existing sequence');

const legacyAutomations = [{
  id: 'customer-stage', name: 'Customer Stage Update', audience: 'Customer', trigger: 'Vehicle reached station',
  channels: ['Email'], stations: ['Service Bay 1', 'Station kept for review'], shareImage: true, active: true
}];
const migratedAutomations = migrateLifecycleAutomations(legacyAutomations, migratedProcesses);
assert.equal(migratedAutomations[0].id, legacyAutomations[0].id, 'automation IDs must remain unchanged');
assert.deepEqual(migratedAutomations[0].stationIds, ['station-original-service'], 'station names must resolve to stable IDs');
assert.deepEqual(migratedAutomations[0].unresolvedStationNames, ['Station kept for review'], 'unmatched names must be retained for manual review');
assert.deepEqual(
  migrateLifecycleAutomations(migratedAutomations, migratedProcesses),
  migratedAutomations,
  'automation migration must be idempotent'
);

const legacyJourney = {
  id: 'journey-1', processId: 'vehicle-service-flow', currentStageId: 'station-original-service',
  visits: [{ stageId: 'station-original-entry' }, { stageId: 'station-original-service' }], events: []
};
assert.equal(isReadableJourney(legacyJourney), true, 'existing journey references must remain readable');
assert.equal(migratedProcesses[0].stages.some((stage) => stage.id === legacyJourney.currentStageId), true, 'journey current stage must still resolve');
assert.equal(legacyJourney.visits.every((visit) => migratedProcesses[0].stages.some((stage) => stage.id === visit.stageId)), true, 'journey visit stages must still resolve');

console.log('State migration validation passed: cameras, plants, station IDs, journeys, and lifecycle automations are preserved.');
