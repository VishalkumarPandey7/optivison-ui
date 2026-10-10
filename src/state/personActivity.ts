export type PersonActivityState = 'working' | 'idle' | 'present' | 'not_visible';

export interface PersonActivityVisit {
  id: string;
  startedAt: number;
  lastSeenAt: number;
  endedAt?: number;
  presentSeconds: number;
  workingSeconds: number;
  idleSeconds: number;
  unknownSeconds: number;
}

export interface PersonActivityRecord {
  cameraId: string;
  trackId: string;
  displayId: number;
  firstSeenAt: number;
  lastSeenAt: number;
  state: PersonActivityState;
  presentSeconds: number;
  workingSeconds: number;
  idleSeconds: number;
  unknownSeconds: number;
  visits: PersonActivityVisit[];
}

export type PersonActivityStore = Record<string, PersonActivityRecord[]>;

export interface PersonActivityDetection {
  trackId: string | number;
  trackConfirmed: boolean;
  className: string;
  task: 'detect' | 'pose';
  box: [number, number, number, number];
  zoneIds: string[];
}

export interface PersonActivityFrame {
  width: number;
  height: number;
  detections: PersonActivityDetection[];
  signals: Array<{
    kind: string;
    active: boolean;
    evidence?: Record<string, unknown>;
  }>;
  rules: Array<{ output: string; active: boolean }>;
}

export interface PersonActivityOptions {
  scopeZoneIds?: string[];
  absenceToleranceSeconds?: number;
}

const defaultAbsenceToleranceSeconds = 15;
const maxPeoplePerCamera = 200;
const maxVisitsPerPerson = 100;

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const finiteNumber = (value: unknown, fallback = 0) => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : fallback;

function normalizeVisit(value: unknown): PersonActivityVisit | null {
  if (!isRecord(value)) return null;
  const startedAt = finiteNumber(value.startedAt);
  const lastSeenAt = finiteNumber(value.lastSeenAt, startedAt);
  if (!startedAt || !lastSeenAt) return null;
  return {
    id: typeof value.id === 'string' && value.id ? value.id : `visit-${startedAt}`,
    startedAt,
    lastSeenAt,
    endedAt: typeof value.endedAt === 'number' && Number.isFinite(value.endedAt) ? Math.max(startedAt, value.endedAt) : lastSeenAt,
    presentSeconds: finiteNumber(value.presentSeconds),
    workingSeconds: finiteNumber(value.workingSeconds),
    idleSeconds: finiteNumber(value.idleSeconds),
    unknownSeconds: finiteNumber(value.unknownSeconds)
  };
}

function normalizeRecord(value: unknown, cameraId: string): PersonActivityRecord | null {
  if (!isRecord(value)) return null;
  const trackId = typeof value.trackId === 'string' || typeof value.trackId === 'number' ? String(value.trackId) : '';
  const firstSeenAt = finiteNumber(value.firstSeenAt);
  const lastSeenAt = finiteNumber(value.lastSeenAt, firstSeenAt);
  if (!trackId || !firstSeenAt || !lastSeenAt) return null;
  const visits = Array.isArray(value.visits)
    ? value.visits.map(normalizeVisit).filter((visit): visit is PersonActivityVisit => Boolean(visit)).slice(-maxVisitsPerPerson)
    : [];
  return {
    cameraId,
    trackId,
    displayId: Number.isInteger(value.displayId) && Number(value.displayId) > 0 ? Number(value.displayId) : 0,
    firstSeenAt,
    lastSeenAt,
    // Persisted records never claim somebody is currently visible until a
    // fresh analysis frame confirms that person after the app is reopened.
    state: 'not_visible',
    presentSeconds: finiteNumber(value.presentSeconds),
    workingSeconds: finiteNumber(value.workingSeconds),
    idleSeconds: finiteNumber(value.idleSeconds),
    unknownSeconds: finiteNumber(value.unknownSeconds),
    visits: visits.map((visit) => ({ ...visit, endedAt: visit.endedAt ?? visit.lastSeenAt }))
  };
}

export function migratePersonActivityStore(value: unknown): PersonActivityStore {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([cameraId, records]) => [
    cameraId,
    Array.isArray(records) ? assignDisplayIds(
      records.map((record) => normalizeRecord(record, cameraId)).filter((record): record is PersonActivityRecord => Boolean(record)).slice(-maxPeoplePerCamera)
    ) : []
  ]));
}

function assignDisplayIds(records: PersonActivityRecord[]) {
  const used = new Set<number>();
  let next = 1;
  const byFirstSeen = [...records].sort((left, right) => left.firstSeenAt - right.firstSeenAt || left.trackId.localeCompare(right.trackId));
  const displayIds = new Map<string, number>();
  byFirstSeen.forEach((record) => {
    let displayId = Number.isInteger(record.displayId) && record.displayId > 0 && !used.has(record.displayId)
      ? record.displayId
      : 0;
    while (!displayId || used.has(displayId)) {
      while (used.has(next)) next += 1;
      displayId = next;
    }
    used.add(displayId);
    next = Math.max(next, displayId + 1);
    displayIds.set(record.trackId, displayId);
  });
  return records.map((record) => ({ ...record, displayId: displayIds.get(record.trackId)! }));
}

function intersectionOverUnion(left: number[], right: number[]) {
  const intersectionWidth = Math.max(0, Math.min(left[2], right[2]) - Math.max(left[0], right[0]));
  const intersectionHeight = Math.max(0, Math.min(left[3], right[3]) - Math.max(left[1], right[1]));
  const intersection = intersectionWidth * intersectionHeight;
  const leftArea = Math.max(0, left[2] - left[0]) * Math.max(0, left[3] - left[1]);
  const rightArea = Math.max(0, right[2] - right[0]) * Math.max(0, right[3] - right[1]);
  const union = leftArea + rightArea - intersection;
  return union > 0 ? intersection / union : 0;
}

function movingDetectTrackIds(frame: PersonActivityFrame, detections: PersonActivityDetection[]) {
  const movingPoseIds = new Set(frame.signals
    .filter((signal) => signal.kind === 'pose_moving' && signal.active)
    .map((signal) => signal.evidence?.trackId)
    .filter((trackId): trackId is string | number => typeof trackId === 'string' || typeof trackId === 'number')
    .map(String));
  if (!movingPoseIds.size) return new Set<string>();
  const movingPoseDetections = frame.detections.filter((detection) => detection.task === 'pose' && movingPoseIds.has(String(detection.trackId)));
  return new Set(detections
    .filter((detection) => movingPoseDetections.some((pose) => intersectionOverUnion(detection.box, pose.box) >= .08))
    .map((detection) => String(detection.trackId)));
}

function incrementVisit(visit: PersonActivityVisit, state: PersonActivityState, delta: number, timestamp: number) {
  return {
    ...visit,
    lastSeenAt: timestamp,
    endedAt: undefined,
    presentSeconds: visit.presentSeconds + delta,
    workingSeconds: visit.workingSeconds + (state === 'working' ? delta : 0),
    idleSeconds: visit.idleSeconds + (state === 'idle' ? delta : 0),
    unknownSeconds: visit.unknownSeconds + (state === 'present' ? delta : 0)
  };
}

export function advancePersonActivity(
  records: PersonActivityRecord[],
  cameraId: string,
  frame: PersonActivityFrame,
  timestamp: number,
  options: PersonActivityOptions = {}
) {
  const tolerance = options.absenceToleranceSeconds ?? defaultAbsenceToleranceSeconds;
  const scopeZoneIds = new Set(options.scopeZoneIds ?? []);
  const detectedPeople = frame.detections.filter((detection) => (
    detection.className === 'person'
    && detection.task === 'detect'
    && detection.trackConfirmed
    && !String(detection.trackId).startsWith('pending-')
    && (!scopeZoneIds.size || detection.zoneIds.some((zoneId) => scopeZoneIds.has(zoneId)))
  ));
  const uniquePeople = [...new Map(detectedPeople.map((detection) => [String(detection.trackId), detection])).values()];
  const movingIds = movingDetectTrackIds(frame, uniquePeople);
  const idleActive = frame.rules.some((rule) => rule.output === 'WORKER_IDLE' && rule.active);
  const workingActive = frame.rules.some((rule) => rule.output === 'WORKER_WORKING' && rule.active);
  const seenIds = new Set(uniquePeople.map((detection) => String(detection.trackId)));
  const byId = new Map(records.map((record) => [record.trackId, record]));
  let nextDisplayId = records.reduce((maximum, record) => Math.max(maximum, record.displayId), 0) + 1;

  uniquePeople.forEach((detection) => {
    const trackId = String(detection.trackId);
    const prior = byId.get(trackId);
    const state: PersonActivityState = movingIds.has(trackId)
      ? 'working'
      : idleActive
        ? 'idle'
        : workingActive && movingIds.size === 0
          ? 'working'
          : 'present';
    const continuing = Boolean(prior && prior.state !== 'not_visible' && timestamp - prior.lastSeenAt <= tolerance);
    const delta = continuing && prior ? Math.min(tolerance, Math.max(0, timestamp - prior.lastSeenAt)) : 0;
    const visits = prior ? [...prior.visits] : [];
    if (!continuing) {
      visits.push({
        id: `${cameraId}:${trackId}:${timestamp}`,
        startedAt: timestamp,
        lastSeenAt: timestamp,
        presentSeconds: 0,
        workingSeconds: 0,
        idleSeconds: 0,
        unknownSeconds: 0
      });
    } else if (visits.length) {
      visits[visits.length - 1] = incrementVisit(visits[visits.length - 1], prior!.state, delta, timestamp);
    }
    byId.set(trackId, {
      cameraId,
      trackId,
      displayId: prior?.displayId ?? nextDisplayId++,
      firstSeenAt: prior?.firstSeenAt ?? timestamp,
      lastSeenAt: timestamp,
      state,
      presentSeconds: (prior?.presentSeconds ?? 0) + delta,
      workingSeconds: (prior?.workingSeconds ?? 0) + (prior?.state === 'working' ? delta : 0),
      idleSeconds: (prior?.idleSeconds ?? 0) + (prior?.state === 'idle' ? delta : 0),
      unknownSeconds: (prior?.unknownSeconds ?? 0) + (prior?.state === 'present' ? delta : 0),
      visits: visits.slice(-maxVisitsPerPerson)
    });
  });

  records.forEach((record) => {
    if (seenIds.has(record.trackId) || record.state === 'not_visible' || timestamp - record.lastSeenAt <= tolerance) return;
    const visits = record.visits.map((visit, index) => index === record.visits.length - 1 && visit.endedAt === undefined
      ? { ...visit, endedAt: visit.lastSeenAt }
      : visit);
    byId.set(record.trackId, { ...record, state: 'not_visible', visits });
  });

  return [...byId.values()]
    .sort((left, right) => right.lastSeenAt - left.lastSeenAt)
    .slice(0, maxPeoplePerCamera);
}

export function expirePersonActivity(records: PersonActivityRecord[], timestamp: number, absenceToleranceSeconds = defaultAbsenceToleranceSeconds) {
  let changed = false;
  const next = records.map((record) => {
    if (record.state === 'not_visible' || timestamp - record.lastSeenAt <= absenceToleranceSeconds) return record;
    changed = true;
    return {
      ...record,
      state: 'not_visible' as const,
      visits: record.visits.map((visit, index) => index === record.visits.length - 1 && visit.endedAt === undefined
        ? { ...visit, endedAt: visit.lastSeenAt }
        : visit)
    };
  });
  return changed ? next : records;
}

export function summarizePersonActivity(records: PersonActivityRecord[]) {
  const visible = records.filter((record) => record.state !== 'not_visible');
  return {
    visible: visible.length,
    working: visible.filter((record) => record.state === 'working').length,
    idle: visible.filter((record) => record.state === 'idle').length,
    present: visible.filter((record) => record.state === 'present').length
  };
}
