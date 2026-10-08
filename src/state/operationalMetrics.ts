export type MetricSourceKind = 'signal' | 'rule';

export interface MetricSourceBinding {
  source: MetricSourceKind;
  sourceId: string;
}

export type OperationalMetricBindingKey =
  | 'workerPresent'
  | 'workerWorking'
  | 'workerIdle'
  | 'workerAbsent'
  | 'machineRunning'
  | 'machineStopped'
  | 'outputCount';

export type OperationalMetricBindings = Record<OperationalMetricBindingKey, MetricSourceBinding | null>;

export interface ShiftSchedule {
  startMinuteOfDay: number;
  durationMinutes: number;
}

export interface OperationalMetricConfiguration {
  bindings: OperationalMetricBindings;
  shift: ShiftSchedule;
}

export type WorkerOperationalState = 'working' | 'idle' | 'absent' | 'present' | 'unknown';
export type MachineOperationalState = 'running' | 'stopped' | 'unknown';

export interface MetricTotals {
  activeSeconds: number;
  idleSeconds: number;
  absentSeconds: number;
  unknownWorkerSeconds: number;
  uptimeSeconds: number;
  downtimeSeconds: number;
  unknownMachineSeconds: number;
  outputCount: number;
}

export interface MetricTimeBucket extends MetricTotals {
  key: string;
  startAt: number;
  endAt: number;
}

export interface SessionMetrics extends MetricTotals {
  version: 2;
  sessionStartedAt: number;
  lastTimestamp: number | null;
  lastOutputValue: number | null;
  lastOutputSource: string | null;
  workerState: WorkerOperationalState;
  machineState: MachineOperationalState;
  shift: MetricTimeBucket;
  day: MetricTimeBucket;
}

export interface OperationalSignalState {
  signalId: string;
  active: boolean;
  value: boolean | number;
  evidence?: Record<string, unknown>;
}

export interface OperationalRuleState {
  ruleId: string;
  active: boolean;
}

export interface OperationalFrame {
  signals: OperationalSignalState[];
  rules: OperationalRuleState[];
}

export interface ResolvedBinding {
  state: 'active' | 'inactive' | 'unknown';
  value: number | null;
}

type UnknownRecord = Record<string, unknown>;

const bindingKeys: OperationalMetricBindingKey[] = [
  'workerPresent',
  'workerWorking',
  'workerIdle',
  'workerAbsent',
  'machineRunning',
  'machineStopped',
  'outputCount'
];

const isRecord = (value: unknown): value is UnknownRecord => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const finiteNumber = (value: unknown, fallback = 0) => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : fallback;
const pad = (value: number) => String(value).padStart(2, '0');

export function defaultOperationalMetricConfiguration(): OperationalMetricConfiguration {
  return {
    bindings: {
      workerPresent: { source: 'signal', sourceId: 'person-in-operator-zone' },
      workerWorking: { source: 'rule', sourceId: 'worker-working' },
      workerIdle: { source: 'rule', sourceId: 'worker-idle' },
      workerAbsent: { source: 'signal', sourceId: 'operator-absent' },
      // A stopped signal becoming inactive is not proof that a machine is running.
      // Existing cameras therefore remain Unknown until a positive running source is selected.
      machineRunning: null,
      machineStopped: { source: 'signal', sourceId: 'machine-idle' },
      outputCount: { source: 'signal', sourceId: 'conveyor-line-crossing-count' }
    },
    shift: { startMinuteOfDay: 0, durationMinutes: 8 * 60 }
  };
}

function normalizeBinding(value: unknown): MetricSourceBinding | null {
  if (!isRecord(value)) return null;
  const source = value.source;
  const sourceId = typeof value.sourceId === 'string' ? value.sourceId.trim() : '';
  if ((source !== 'signal' && source !== 'rule') || !sourceId) return null;
  return { source, sourceId };
}

export function normalizeOperationalMetricConfiguration(value: unknown): OperationalMetricConfiguration {
  const defaults = defaultOperationalMetricConfiguration();
  if (!isRecord(value)) return defaults;
  const rawBindings = isRecord(value.bindings) ? value.bindings : {};
  const bindings = { ...defaults.bindings };
  bindingKeys.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(rawBindings, key)) bindings[key] = normalizeBinding(rawBindings[key]);
  });
  const rawShift = isRecord(value.shift) ? value.shift : {};
  return {
    bindings,
    shift: {
      startMinuteOfDay: Math.min(1439, Math.floor(finiteNumber(rawShift.startMinuteOfDay, defaults.shift.startMinuteOfDay))),
      durationMinutes: Math.min(24 * 60, Math.max(15, Math.floor(finiteNumber(rawShift.durationMinutes, defaults.shift.durationMinutes))))
    }
  };
}

export function emptyMetricTotals(): MetricTotals {
  return {
    activeSeconds: 0,
    idleSeconds: 0,
    absentSeconds: 0,
    unknownWorkerSeconds: 0,
    uptimeSeconds: 0,
    downtimeSeconds: 0,
    unknownMachineSeconds: 0,
    outputCount: 0
  };
}

function localDayWindow(timestamp: number) {
  const date = new Date(timestamp * 1000);
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() / 1000;
  const end = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime() / 1000;
  return { key: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`, startAt: start, endAt: end };
}

function localShiftWindow(timestamp: number, schedule: ShiftSchedule) {
  const date = new Date(timestamp * 1000);
  const midnight = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() / 1000;
  const durationSeconds = schedule.durationMinutes * 60;
  let startAt = midnight + schedule.startMinuteOfDay * 60;
  while (timestamp < startAt) startAt -= durationSeconds;
  while (timestamp >= startAt + durationSeconds) startAt += durationSeconds;
  const start = new Date(startAt * 1000);
  return {
    key: `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}T${pad(start.getHours())}:${pad(start.getMinutes())}`,
    startAt,
    endAt: startAt + durationSeconds
  };
}

function createBucket(window: { key: string; startAt: number; endAt: number }): MetricTimeBucket {
  return { ...emptyMetricTotals(), ...window };
}

export function createEmptySessionMetrics(schedule: ShiftSchedule, timestamp = Date.now() / 1000): SessionMetrics {
  return {
    version: 2,
    ...emptyMetricTotals(),
    sessionStartedAt: timestamp,
    lastTimestamp: null,
    lastOutputValue: null,
    lastOutputSource: null,
    workerState: 'unknown',
    machineState: 'unknown',
    shift: createBucket(localShiftWindow(timestamp, schedule)),
    day: createBucket(localDayWindow(timestamp))
  };
}

function normalizeTotals(value: unknown): MetricTotals {
  const raw = isRecord(value) ? value : {};
  return {
    activeSeconds: finiteNumber(raw.activeSeconds),
    idleSeconds: finiteNumber(raw.idleSeconds),
    absentSeconds: finiteNumber(raw.absentSeconds),
    unknownWorkerSeconds: finiteNumber(raw.unknownWorkerSeconds),
    uptimeSeconds: finiteNumber(raw.uptimeSeconds),
    downtimeSeconds: finiteNumber(raw.downtimeSeconds),
    unknownMachineSeconds: finiteNumber(raw.unknownMachineSeconds),
    outputCount: finiteNumber(raw.outputCount)
  };
}

function normalizeBucket(value: unknown, fallback: MetricTimeBucket): MetricTimeBucket {
  if (!isRecord(value) || typeof value.key !== 'string') return fallback;
  return {
    ...normalizeTotals(value),
    key: value.key,
    startAt: finiteNumber(value.startAt, fallback.startAt),
    endAt: finiteNumber(value.endAt, fallback.endAt)
  };
}

export function migrateSessionMetrics(value: unknown, legacyValue: unknown, schedule: ShiftSchedule, timestamp = Date.now() / 1000): SessionMetrics {
  const empty = createEmptySessionMetrics(schedule, timestamp);
  if (isRecord(value) && value.version === 2) {
    const workerState = ['working', 'idle', 'absent', 'present', 'unknown'].includes(String(value.workerState))
      ? value.workerState as WorkerOperationalState
      : 'unknown';
    const machineState = ['running', 'stopped', 'unknown'].includes(String(value.machineState))
      ? value.machineState as MachineOperationalState
      : 'unknown';
    return {
      ...empty,
      ...normalizeTotals(value),
      sessionStartedAt: finiteNumber(value.sessionStartedAt, timestamp),
      lastTimestamp: null,
      lastOutputValue: typeof value.lastOutputValue === 'number' && Number.isFinite(value.lastOutputValue) ? Math.max(0, value.lastOutputValue) : null,
      lastOutputSource: typeof value.lastOutputSource === 'string' ? value.lastOutputSource : null,
      workerState,
      machineState,
      shift: normalizeBucket(value.shift, empty.shift),
      day: normalizeBucket(value.day, empty.day)
    };
  }

  // V1 stored only current-session totals. Keep every available total in the
  // new session while starting shift/day buckets cleanly because V1 had no
  // reliable bucket timestamps.
  return { ...empty, ...normalizeTotals(legacyValue) };
}

export function resolveMetricBinding(binding: MetricSourceBinding | null, frame: OperationalFrame): ResolvedBinding {
  if (!binding) return { state: 'unknown', value: null };
  if (binding.source === 'rule') {
    const rule = frame.rules.find((item) => item.ruleId === binding.sourceId);
    return rule ? { state: rule.active ? 'active' : 'inactive', value: rule.active ? 1 : 0 } : { state: 'unknown', value: null };
  }
  const signal = frame.signals.find((item) => item.signalId === binding.sourceId);
  if (!signal) return { state: 'unknown', value: null };
  const evidenceTotal = signal.evidence?.totalCount;
  const value = typeof evidenceTotal === 'number' && Number.isFinite(evidenceTotal)
    ? evidenceTotal
    : typeof signal.value === 'number' && Number.isFinite(signal.value)
      ? signal.value
      : signal.active ? 1 : 0;
  return { state: signal.active ? 'active' : 'inactive', value };
}

export function deriveOperationalStates(frame: OperationalFrame, bindings: OperationalMetricBindings) {
  const working = resolveMetricBinding(bindings.workerWorking, frame);
  const idle = resolveMetricBinding(bindings.workerIdle, frame);
  const absent = resolveMetricBinding(bindings.workerAbsent, frame);
  const present = resolveMetricBinding(bindings.workerPresent, frame);
  const activeWorkerStates = [working.state === 'active' ? 'working' : null, idle.state === 'active' ? 'idle' : null, absent.state === 'active' ? 'absent' : null].filter(Boolean);
  const workerState: WorkerOperationalState = activeWorkerStates.length > 1
    ? 'unknown'
    : activeWorkerStates[0] as WorkerOperationalState | undefined
      ?? (present.state === 'active' ? 'present' : 'unknown');

  const running = resolveMetricBinding(bindings.machineRunning, frame);
  const stopped = resolveMetricBinding(bindings.machineStopped, frame);
  const machineState: MachineOperationalState = running.state === 'active' && stopped.state === 'active'
    ? 'unknown'
    : running.state === 'active'
      ? 'running'
      : stopped.state === 'active'
        ? 'stopped'
        : 'unknown';

  return { workerState, machineState, present, working, idle, absent, running, stopped };
}

function applyDelta(totals: MetricTotals, workerState: WorkerOperationalState, machineState: MachineOperationalState, seconds: number, outputDelta: number): MetricTotals {
  return {
    activeSeconds: totals.activeSeconds + (workerState === 'working' ? seconds : 0),
    idleSeconds: totals.idleSeconds + (workerState === 'idle' ? seconds : 0),
    absentSeconds: totals.absentSeconds + (workerState === 'absent' ? seconds : 0),
    unknownWorkerSeconds: totals.unknownWorkerSeconds + (['unknown', 'present'].includes(workerState) ? seconds : 0),
    uptimeSeconds: totals.uptimeSeconds + (machineState === 'running' ? seconds : 0),
    downtimeSeconds: totals.downtimeSeconds + (machineState === 'stopped' ? seconds : 0),
    unknownMachineSeconds: totals.unknownMachineSeconds + (machineState === 'unknown' ? seconds : 0),
    outputCount: totals.outputCount + outputDelta
  };
}

export function advanceSessionMetrics(current: SessionMetrics, frame: OperationalFrame, configuration: OperationalMetricConfiguration, timestamp: number): SessionMetrics {
  const shiftWindow = localShiftWindow(timestamp, configuration.shift);
  const dayWindow = localDayWindow(timestamp);
  const shift = current.shift.key === shiftWindow.key ? current.shift : createBucket(shiftWindow);
  const day = current.day.key === dayWindow.key ? current.day : createBucket(dayWindow);
  const states = deriveOperationalStates(frame, configuration.bindings);
  const elapsed = current.lastTimestamp === null ? 0 : Math.min(2, Math.max(0, timestamp - current.lastTimestamp));
  const outputBinding = configuration.bindings.outputCount;
  const outputSource = outputBinding ? `${outputBinding.source}:${outputBinding.sourceId}` : null;
  const output = resolveMetricBinding(configuration.bindings.outputCount, frame).value;
  const outputDelta = output === null || current.lastOutputValue === null || current.lastOutputSource !== outputSource || output < current.lastOutputValue
    ? 0
    : Math.max(0, output - current.lastOutputValue);
  const sessionTotals = applyDelta(current, states.workerState, states.machineState, elapsed, outputDelta);
  const shiftTotals = applyDelta(shift, states.workerState, states.machineState, elapsed, outputDelta);
  const dayTotals = applyDelta(day, states.workerState, states.machineState, elapsed, outputDelta);

  return {
    ...current,
    ...sessionTotals,
    lastTimestamp: timestamp,
    lastOutputValue: output,
    lastOutputSource: outputSource,
    workerState: states.workerState,
    machineState: states.machineState,
    shift: { ...shift, ...shiftTotals },
    day: { ...day, ...dayTotals }
  };
}

export function resetSessionMetrics(current: SessionMetrics, schedule: ShiftSchedule, timestamp = Date.now() / 1000): SessionMetrics {
  const empty = createEmptySessionMetrics(schedule, timestamp);
  return { ...empty, shift: current.shift, day: current.day };
}
