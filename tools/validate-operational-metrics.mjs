import assert from 'node:assert/strict';
import {
  advanceSessionMetrics,
  createEmptySessionMetrics,
  defaultOperationalMetricConfiguration,
  migrateSessionMetrics,
  resetSessionMetrics
} from '../tmp/operational-metrics-validation/operationalMetrics.js';

const schedule = { startMinuteOfDay: 0, durationMinutes: 8 * 60 };
const configuration = defaultOperationalMetricConfiguration();
configuration.bindings.machineRunning = { source: 'rule', sourceId: 'machine-running' };

const frame = ({ working = false, idle = false, absent = false, running = false, stopped = false, output = 0 } = {}) => ({
  signals: [
    { signalId: 'person-in-operator-zone', active: working || idle, value: working || idle },
    { signalId: 'operator-absent', active: absent, value: absent },
    { signalId: 'machine-idle', active: stopped, value: stopped },
    { signalId: 'conveyor-line-crossing-count', active: output > 0, value: output, evidence: { totalCount: output } }
  ],
  rules: [
    { ruleId: 'worker-working', active: working },
    { ruleId: 'worker-idle', active: idle },
    { ruleId: 'machine-running', active: running }
  ]
});

const now = new Date(2026, 9, 8, 9, 0, 0).getTime() / 1000;
const legacy = { activeSeconds: 14, idleSeconds: 8, absentSeconds: 2, uptimeSeconds: 11, downtimeSeconds: 3, lastTimestamp: 99 };
const migrated = migrateSessionMetrics(undefined, legacy, schedule, now);
assert.equal(migrated.version, 2, 'legacy metrics must migrate to version 2');
assert.equal(migrated.activeSeconds, 14, 'legacy working time must survive migration');
assert.equal(migrated.idleSeconds, 8, 'legacy idle time must survive migration');
assert.equal(migrated.uptimeSeconds, 11, 'legacy running time must survive migration');
assert.equal(migrated.shift.activeSeconds, 0, 'legacy metrics without timestamps must not be guessed into a shift');
assert.equal(migrated.day.activeSeconds, 0, 'legacy metrics without timestamps must not be guessed into a day');
assert.equal(migrated.lastTimestamp, null, 'a refresh must not count time while the app was closed');

let metrics = createEmptySessionMetrics(configuration.shift, now);
metrics = advanceSessionMetrics(metrics, frame({ working: true, running: true, output: 10 }), configuration, now);
metrics = advanceSessionMetrics(metrics, frame({ working: true, running: true, output: 12 }), configuration, now + 1);
assert.equal(metrics.workerState, 'working');
assert.equal(metrics.machineState, 'running');
assert.equal(metrics.activeSeconds, 1, 'working time must accumulate only from explicit working evidence');
assert.equal(metrics.uptimeSeconds, 1, 'running time must accumulate only from explicit running evidence');
assert.equal(metrics.outputCount, 2, 'output count must accumulate source deltas, not repeatedly add the total');
assert.equal(metrics.shift.activeSeconds, 1, 'current shift must receive the same valid delta');
assert.equal(metrics.day.activeSeconds, 1, 'current day must receive the same valid delta');

metrics = advanceSessionMetrics(metrics, frame({ working: true, idle: true, running: true, stopped: true, output: 1 }), configuration, now + 2);
assert.equal(metrics.workerState, 'unknown', 'conflicting worker evidence must become Unknown');
assert.equal(metrics.machineState, 'unknown', 'conflicting machine evidence must become Unknown');
assert.equal(metrics.unknownWorkerSeconds, 1, 'conflicting worker time must be isolated from productivity');
assert.equal(metrics.unknownMachineSeconds, 1, 'conflicting machine time must be isolated from utilization');
assert.equal(metrics.outputCount, 2, 'a reset source counter must establish a new baseline without inventing output');

const changedOutputSource = {
  ...configuration,
  bindings: { ...configuration.bindings, outputCount: { source: 'signal', sourceId: 'objects-in-counting-zone' } }
};
const differentCounterFrame = frame();
differentCounterFrame.signals.push({ signalId: 'objects-in-counting-zone', active: true, value: 99 });
metrics = advanceSessionMetrics(metrics, differentCounterFrame, changedOutputSource, now + 3);
assert.equal(metrics.outputCount, 2, 'changing the configured output source must establish a new baseline');

const noRunningBinding = defaultOperationalMetricConfiguration();
let unknownMachine = createEmptySessionMetrics(noRunningBinding.shift, now);
unknownMachine = advanceSessionMetrics(unknownMachine, frame(), noRunningBinding, now);
unknownMachine = advanceSessionMetrics(unknownMachine, frame(), noRunningBinding, now + 1);
assert.equal(unknownMachine.machineState, 'unknown', 'inactive stopped evidence must not be treated as running');
assert.equal(unknownMachine.uptimeSeconds, 0, 'Unknown machine time must not inflate utilization');

const otherCamera = createEmptySessionMetrics(configuration.shift, now);
assert.equal(otherCamera.activeSeconds, 0, 'camera metric records must remain isolated');
assert.equal(otherCamera.outputCount, 0, 'camera counters must remain isolated');

const oneHour = { ...configuration, shift: { startMinuteOfDay: 0, durationMinutes: 60 } };
const beforeBoundary = new Date(2026, 9, 8, 9, 59, 58).getTime() / 1000;
let rollover = createEmptySessionMetrics(oneHour.shift, beforeBoundary);
rollover = advanceSessionMetrics(rollover, frame({ working: true, running: true }), oneHour, beforeBoundary);
rollover = advanceSessionMetrics(rollover, frame({ working: true, running: true }), oneHour, beforeBoundary + 1);
assert.equal(rollover.shift.activeSeconds, 1);
rollover = advanceSessionMetrics(rollover, frame({ working: true, running: true }), oneHour, beforeBoundary + 2);
assert.equal(rollover.shift.activeSeconds, 1, 'the new shift must start its own counter at the boundary');
assert.equal(rollover.activeSeconds, 2, 'session totals must continue across a shift boundary');

const beforeMidnight = new Date(2026, 9, 8, 23, 59, 58).getTime() / 1000;
let dayRollover = createEmptySessionMetrics(configuration.shift, beforeMidnight);
dayRollover = advanceSessionMetrics(dayRollover, frame({ working: true }), configuration, beforeMidnight);
dayRollover = advanceSessionMetrics(dayRollover, frame({ working: true }), configuration, beforeMidnight + 1);
dayRollover = advanceSessionMetrics(dayRollover, frame({ working: true }), configuration, beforeMidnight + 2);
assert.equal(dayRollover.day.activeSeconds, 1, 'the new calendar day must start its own counter');
assert.equal(dayRollover.activeSeconds, 2, 'session totals must continue across midnight');

const reset = resetSessionMetrics(metrics, configuration.shift, now + 10);
assert.equal(reset.activeSeconds, 0, 'reset must clear only current-session working time');
assert.equal(reset.outputCount, 0, 'reset must clear only current-session output');
assert.equal(reset.shift.activeSeconds, metrics.shift.activeSeconds, 'reset must preserve current-shift totals');
assert.equal(reset.day.activeSeconds, metrics.day.activeSeconds, 'reset must preserve current-day totals');

console.log('Operational metric validation passed: migration, Unknown states, explicit bindings, isolation, counters, and rollovers are correct.');
