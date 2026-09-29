import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, ArrowLeft, ArrowRight, BarChart3, Bell, CalendarDays, Car, Check, ChevronDown, CircleDot, Clock3, Download, FileText, Image, List, Mail, MapPin, Menu, MessageCircle, MoreHorizontal, Pause, Pencil, Play, Plus, Radio, RefreshCw, Route, Search, Settings2, ScanLine, Timer, Trash2, Truck, UserRound, Users, X, Zap } from 'lucide-react';
import { useVision, type AnalysisFrame } from './vision';
import { backupStoredValue, isArray, readStoredJson, readStoredString, writeStoredJson, writeStoredString } from './state/persistence';
import { migrateLifecycleAutomations, migrateLprProcesses, type MigratedLifecycleAutomation } from './state/migrations';

type StageType = 'entry' | 'station' | 'exit';
type WorkerState = 'working' | 'idle' | 'absent';

export interface LprStage {
  id: string;
  order: number;
  name: string;
  type: StageType;
  cameraId: string;
  zoneId: string;
  trackWorker: boolean;
}

export interface LprProcess {
  id: string;
  name: string;
  plantId?: string;
  modelId: 'indian_lpr';
  active: boolean;
  flowMode: 'strict' | 'flexible';
  minimumTransitionSeconds: number;
  staleAfterMinutes: number;
  stages: LprStage[];
}

export interface LprVisit {
  stageId: string;
  enteredAt: number;
  lastSeenAt: number;
  leftAt?: number;
  workingSeconds: number;
  idleSeconds: number;
  absentSeconds: number;
}

export interface LprEvent {
  id: string;
  type: 'vehicle_entered' | 'vehicle_left' | 'work_started' | 'work_stopped' | 'work_resumed' | 'worker_absent' | 'journey_started' | 'journey_completed';
  stageId: string;
  timestamp: number;
  detail: string;
}

export interface LprJourney {
  id: string;
  plate: string;
  processId: string;
  status: 'active' | 'completed';
  startedAt: number;
  completedAt?: number;
  completionReason?: 'exit' | 'manual';
  lastActivityAt: number;
  plateImage?: string;
  plateFingerprint?: string;
  currentStageId: string;
  workerState: WorkerState;
  events: LprEvent[];
  visits: LprVisit[];
}

interface LprContextValue {
  processes: LprProcess[];
  journeys: LprJourney[];
  selectedProcessId: string;
  setSelectedProcessId: (id: string) => void;
  addProcess: () => void;
  updateProcess: (id: string, update: Partial<LprProcess>) => void;
  reorderStages: (processId: string, orderedStageIds: string[]) => void;
  removeProcess: (id: string) => void;
  recordScan: (processId: string, stageId: string, plate: string, workerState?: WorkerState, timestamp?: number) => void;
  updateJourneyPlate: (id: string, plate: string) => void;
  completeJourney: (id: string) => void;
  clearJourney: (id: string) => void;
  plateCandidates: LprCandidate[];
}

export interface LprCandidate {
  key: string;
  plate: string;
  processId: string;
  stageId: string;
  cameraId: string;
  firstSeen: number;
  lastSeen: number;
  confirmed: boolean;
  observations: number;
  votes: Record<string, number>;
  lastBox: number[];
  plateImage?: string;
  plateFingerprint?: string;
}

const LprContext = createContext<LprContextValue | null>(null);
const processStorageKey = 'optivision-lpr-processes-v2';
const processStorageBackupKey = 'optivision-lpr-processes-v2:backup:pre-ordering';
const selectedProcessStorageKey = 'optivision-lpr-selected-process-v1';
const workspaceSectionStorageKey = 'optivision-lpr-workspace-section-v1';
// v4 starts clean because earlier versions could create multiple journeys when
// the OCR text changed while the same physical plate remained in view.
const journeyStorageKey = 'optivision-lpr-journeys-v5';
const consecutiveFrameToleranceSeconds = 8;

function plateDistance(left: string, right: string) {
  const rows = left.length + 1; const columns = right.length + 1;
  const matrix = Array.from({ length: rows }, () => Array(columns).fill(0));
  for (let row = 0; row < rows; row++) matrix[row][0] = row;
  for (let column = 0; column < columns; column++) matrix[0][column] = column;
  for (let row = 1; row < rows; row++) for (let column = 1; column < columns; column++) matrix[row][column] = Math.min(matrix[row - 1][column] + 1, matrix[row][column - 1] + 1, matrix[row - 1][column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1));
  return matrix[left.length][right.length];
}

function normalizePlate(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function isUsablePlateRead(value: string) {
  const plate = normalizePlate(value);
  const letters = (plate.match(/[A-Z]/g) ?? []).length;
  const digits = (plate.match(/[0-9]/g) ?? []).length;
  // Accept regional Indian formats without forcing one exact state/RTO pattern,
  // while rejecting short detector noise before it can start a lifecycle.
  return plate.length >= 6 && plate.length <= 12 && letters >= 2 && digits >= 2;
}

function platesLikelyMatch(leftInput: string, rightInput: string) {
  const left = normalizePlate(leftInput);
  const right = normalizePlate(rightInput);
  if (!left || !right) return false;
  if (left === right) return true;
  // Indian plates can gain/lose a character in the middle during OCR while
  // retaining the stable state/RTO prefix and four-digit registration suffix.
  return left.length >= 8 && right.length >= 8
    && left.slice(0, 4) === right.slice(0, 4)
    && left.slice(-4) === right.slice(-4);
}

function fingerprintDistance(left?: string, right?: string) {
  if (!left || !right || left.length !== right.length) return Number.POSITIVE_INFINITY;
  let distance = 0;
  for (let index = 0; index < left.length; index++) {
    let value = Number.parseInt(left[index], 16) ^ Number.parseInt(right[index], 16);
    while (value) { distance += value & 1; value >>= 1; }
  }
  return distance;
}

function fingerprintsLikelyMatch(left?: string, right?: string) {
  return fingerprintDistance(left, right) <= 12;
}

function plateIdentityMatches(leftPlate: string, rightPlate: string, leftFingerprint?: string, rightFingerprint?: string) {
  if (platesLikelyMatch(leftPlate, rightPlate)) return true;
  // A similar crop may recover a noisy OCR character, but image similarity is
  // never allowed to merge completely unrelated plate strings.
  return fingerprintsLikelyMatch(leftFingerprint, rightFingerprint)
    && plateDistance(normalizePlate(leftPlate), normalizePlate(rightPlate)) <= 3;
}

function stored<T>(key: string): T[] {
  return readStoredJson<T[]>(key, [], isArray<T>);
}

function defaultProcess(cameraId: string, plantId: string, zoneIds: string[]): LprProcess {
  void zoneIds;
  const stations = ['Main Gate', 'Reception', 'Inspection Bay', 'Service Bay 1', 'QC', 'Washing', 'Delivery Yard', 'Exit Gate'];
  return {
    id: 'vehicle-service-flow', name: 'Vehicle Lifecycle', plantId, modelId: 'indian_lpr', active: true,
    flowMode: 'strict', minimumTransitionSeconds: 2, staleAfterMinutes: 30,
    stages: stations.map((name, index) => ({
      id: `station-${index + 1}`,
      order: index,
      name,
      type: index === 0 ? 'entry' : index === stations.length - 1 ? 'exit' : 'station',
      cameraId: index === 0 ? cameraId : '',
      zoneId: '',
      trackWorker: index > 0 && index < stations.length - 1
    }))
  };
}

function event(type: LprEvent['type'], stageId: string, timestamp: number, detail: string): LprEvent {
  return { id: `${type}-${stageId}-${timestamp}-${Math.random().toString(36).slice(2, 7)}`, type, stageId, timestamp, detail };
}

function openVisit(journey: LprJourney, stageId: string) {
  return [...journey.visits].reverse().find((visit) => visit.stageId === stageId && visit.leftAt === undefined);
}

function observeJourney(current: LprJourney[], process: LprProcess, stage: LprStage, plateInput: string, timestamp: number, workerState: WorkerState, visual?: { plateImage?: string; plateFingerprint?: string }) {
  const plate = normalizePlate(plateInput);
  if (!plate) return current;
  const matchingJourneys = current
    .map((journey, index) => ({ journey, index }))
    .filter(({ journey }) => journey.processId === process.id && journey.status === 'active' && plateIdentityMatches(journey.plate, plate, journey.plateFingerprint, visual?.plateFingerprint))
    .sort((left, right) => plateDistance(normalizePlate(left.journey.plate), plate) - plateDistance(normalizePlate(right.journey.plate), plate));
  let existingIndex = matchingJourneys[0]?.index ?? -1;
  // Only a confirmed plate/image identity may update an existing journey.
  // An unmatched plate at the entry point always creates a separate lifecycle;
  // an unmatched downstream scan is left unlinked instead of corrupting another car.
  if (existingIndex < 0 && stage.type !== 'entry') return current;
  let journey: LprJourney;
  if (existingIndex < 0) {
    journey = {
      id: `${process.id}-${plate}-${timestamp}`, plate, processId: process.id, status: 'active', startedAt: timestamp,
      lastActivityAt: timestamp, plateImage: visual?.plateImage, plateFingerprint: visual?.plateFingerprint,
      currentStageId: stage.id, workerState, visits: [{ stageId: stage.id, enteredAt: timestamp, lastSeenAt: timestamp, workingSeconds: 0, idleSeconds: 0, absentSeconds: 0 }],
      events: [event('journey_started', stage.id, timestamp, `${plate} lifecycle started`), event('vehicle_entered', stage.id, timestamp, `${plate} entered ${stage.name}`)]
    };
  } else {
    journey = structuredClone(current[existingIndex]);
    journey.lastActivityAt = timestamp;
    if (stage.type === 'entry' && journey.currentStageId === stage.id) {
      // The first valid OCR result and its crop form the vehicle identity.
      // Later noisy frames may help matching, but must not rewrite that record.
      journey.plateImage = journey.plateImage ?? visual?.plateImage;
      journey.plateFingerprint = journey.plateFingerprint ?? visual?.plateFingerprint;
    }
    const activeVisit = openVisit(journey, journey.currentStageId);
    const currentStageIndex = process.stages.findIndex((item) => item.id === journey.currentStageId);
    const observedStageIndex = process.stages.findIndex((item) => item.id === stage.id);
    // The entry-camera OCR creates the journey immediately. Once it exists,
    // the selected flow mode controls how downstream station scans advance it.
    if (observedStageIndex >= 0 && currentStageIndex >= 0 && observedStageIndex < currentStageIndex) return current;
    const mappedStages = process.stages.filter((item) => item.cameraId);
    const currentMappedIndex = mappedStages.findIndex((item) => item.id === journey.currentStageId);
    const observedMappedIndex = mappedStages.findIndex((item) => item.id === stage.id);
    if (journey.currentStageId !== stage.id && process.flowMode !== 'flexible' && observedMappedIndex !== currentMappedIndex + 1) return current;
    const lastVisit = journey.visits[journey.visits.length - 1];
    if (journey.currentStageId !== stage.id && timestamp - lastVisit.enteredAt < (process.minimumTransitionSeconds ?? 2)) return current;
    if (journey.currentStageId !== stage.id) {
      if (activeVisit) { activeVisit.leftAt = activeVisit.lastSeenAt; journey.events.push(event('vehicle_left', activeVisit.stageId, activeVisit.lastSeenAt, `${journey.plate} left previous zone`)); }
      journey.currentStageId = stage.id;
      journey.workerState = workerState;
      journey.visits.push({ stageId: stage.id, enteredAt: timestamp, lastSeenAt: timestamp, workingSeconds: 0, idleSeconds: 0, absentSeconds: 0 });
      journey.events.push(event('vehicle_entered', stage.id, timestamp, `${journey.plate} entered ${stage.name}`));
      if (stage.trackWorker) {
        const type = workerState === 'working' ? 'work_started' : workerState === 'absent' ? 'worker_absent' : 'work_stopped';
        journey.events.push(event(type, stage.id, timestamp, `Worker ${workerState} at ${stage.name}`));
      }
    } else if (!activeVisit) {
      journey.visits.push({ stageId: stage.id, enteredAt: timestamp, lastSeenAt: timestamp, workingSeconds: 0, idleSeconds: 0, absentSeconds: 0 });
      journey.events.push(event('vehicle_entered', stage.id, timestamp, `${journey.plate} returned to ${stage.name}`));
    } else {
      const delta = Math.max(0, Math.min(5, timestamp - activeVisit.lastSeenAt));
      if (journey.workerState === 'working') activeVisit.workingSeconds += delta;
      else if (journey.workerState === 'idle') activeVisit.idleSeconds += delta;
      else activeVisit.absentSeconds += delta;
      activeVisit.lastSeenAt = timestamp;
      if (stage.trackWorker && workerState !== journey.workerState) {
        const prior = journey.workerState;
        const type = workerState === 'working' ? (prior === 'idle' ? 'work_resumed' : 'work_started') : workerState === 'absent' ? 'worker_absent' : 'work_stopped';
        journey.events.push(event(type, stage.id, timestamp, `Worker ${workerState} at ${stage.name}`));
        journey.workerState = workerState;
      }
    }
  }
  if (stage.type === 'exit') {
    journey.status = 'completed'; journey.completedAt = timestamp; journey.completionReason = 'exit';
    const visit = openVisit(journey, stage.id);
    if (visit) visit.leftAt = timestamp;
    journey.events.push(event('journey_completed', stage.id, timestamp, `${journey.plate} left the process`));
  }
  if (existingIndex < 0) return [journey, ...current];
  return current.map((item, index) => index === existingIndex ? journey : item);
}

function workerStateFromFrame(frame: AnalysisFrame): WorkerState {
  if (frame.rules.some((rule) => rule.output === 'WORKER_WORKING' && rule.active)) return 'working';
  if (frame.rules.some((rule) => rule.output === 'OPERATOR_ABSENT' && rule.active)) return 'absent';
  return 'idle';
}

export function LprProvider({ children }: { children: ReactNode }) {
  const vision = useVision();
  const [processes, setProcesses] = useState<LprProcess[]>(() => {
    const raw = readStoredJson<unknown>(processStorageKey, []);
    const saved = (migrateLprProcesses(raw) as unknown as LprProcess[]).map((process) => {
      const plantId = process.plantId ?? vision.cameras.find((camera) => process.stages.some((stage) => stage.cameraId === camera.id))?.plantId ?? vision.selectedPlantId;
      const entryStage = process.stages.find((stage) => stage.type === 'entry');
      const entryCameraExists = Boolean(entryStage?.cameraId && vision.cameras.some((camera) => camera.id === entryStage.cameraId));
      const assignedCameraIds = new Set(process.stages.map((stage) => stage.cameraId).filter(Boolean));
      const fallbackEntryCamera = vision.cameras.find((camera) => camera.plantId === plantId && !assignedCameraIds.has(camera.id))
        ?? vision.cameras.find((camera) => !assignedCameraIds.has(camera.id));
      return {
        ...process,
        name: process.name === 'Riverside Workshop - Main Setup' ? 'Vehicle Lifecycle' : process.name,
        plantId,
        // Recover the legacy default mapping only when the saved Start station
        // is empty or points to a camera that no longer exists. Station IDs and
        // every valid user-selected mapping remain untouched.
        stages: !entryStage || entryCameraExists || !fallbackEntryCamera
          ? process.stages
          : process.stages.map((stage) => stage.id === entryStage.id ? { ...stage, cameraId: fallbackEntryCamera.id, zoneId: '' } : stage)
      };
    });
    if (Array.isArray(raw) && raw.length) {
      backupStoredValue(processStorageKey, processStorageBackupKey);
      writeStoredJson(processStorageKey, saved);
    }
    const firstCamera = vision.cameras[0];
    return saved.length ? saved : [defaultProcess(firstCamera.id, firstCamera.plantId, firstCamera.configuration.zones.map((zone) => zone.id))];
  });
  const [journeys, setJourneys] = useState<LprJourney[]>(() => stored<LprJourney>(journeyStorageKey));
  const [plateCandidates, setPlateCandidates] = useState<LprCandidate[]>([]);
  const [selectedProcessId, setSelectedProcessId] = useState(() => {
    const storedId = readStoredString(selectedProcessStorageKey);
    return processes.some((process) => process.id === storedId) ? storedId! : processes[0]?.id ?? '';
  });
  const seenFrames = useRef<Record<string, number>>({});
  const candidateMap = useRef<Record<string, LprCandidate>>({});

  useEffect(() => { writeStoredJson(processStorageKey, processes); }, [processes]);
  useEffect(() => { writeStoredJson(journeyStorageKey, journeys.slice(0, 500)); }, [journeys]);
  useEffect(() => { writeStoredString(selectedProcessStorageKey, selectedProcessId); }, [selectedProcessId]);
  useEffect(() => { writeStoredJson(lifecycleAutomationKey, loadLifecycleAutomations(processes)); }, []);
  useEffect(() => {
    const mappedCameraIds = new Set(
      processes
        .filter((process) => process.active)
        .flatMap((process) => process.stages.map((stage) => stage.cameraId))
        .filter(Boolean)
    );
    vision.cameras.forEach((camera) => {
      if (!mappedCameraIds.has(camera.id) || camera.configuration.selectedModelIds.includes('indian_lpr')) return;
      // A lifecycle station cannot produce plate scans unless its camera asks
      // the worker to run Indian_LPR. Keep any existing object/pose models and
      // add the required OCR model automatically when the station is mapped.
      vision.updateConfiguration(camera.id, (configuration) => ({
        ...configuration,
        selectedModelIds: [...configuration.selectedModelIds, 'indian_lpr']
      }));
    });
  }, [processes, vision.cameras, vision.updateConfiguration]);

  useEffect(() => {
    Object.entries(vision.frames).forEach(([cameraId, frame]) => {
      if (seenFrames.current[cameraId] === frame.timestamp) return;
      seenFrames.current[cameraId] = frame.timestamp;
      const plates = frame.detections.filter((detection) => detection.className === 'license_plate' && detection.plateText && isUsablePlateRead(detection.plateText));
      const workerState = workerStateFromFrame(frame);
      const matchedKeys = new Set<string>();
      const confirmed: Array<{ process: LprProcess; stage: LprStage; plate: string; plateImage?: string; plateFingerprint?: string }> = [];
      // Lifecycle recording is automatic for every mapped process. There is no
      // separate lifecycle start button: a valid entry-camera plate starts it.
      processes.forEach((process) => {
        process.stages.filter((stage) => stage.cameraId === cameraId).forEach((stage) => {
          const stagePlates = plates.filter((plate) => !stage.zoneId || plate.zoneIds.includes(stage.zoneId));
          stagePlates.forEach((plate) => {
            const normalizedPlate = normalizePlate(plate.plateText!);
            const recentCandidates = Object.values(candidateMap.current)
              .filter((candidate) => candidate.processId === process.id && candidate.stageId === stage.id && candidate.cameraId === cameraId && frame.timestamp - candidate.lastSeen <= consecutiveFrameToleranceSeconds)
              .sort((left, right) => right.lastSeen - left.lastSeen);
            const related = recentCandidates.find((candidate) => plateIdentityMatches(candidate.plate, normalizedPlate, candidate.plateFingerprint, plate.plateFingerprint));
            const key = related?.key ?? `${process.id}:${stage.id}:${normalizedPlate}`;
            matchedKeys.add(key);
            const previous = related ?? candidateMap.current[key];
            const continuous = previous && frame.timestamp - previous.lastSeen <= consecutiveFrameToleranceSeconds;
            const votes = continuous ? { ...previous.votes, [normalizedPlate]: (previous.votes[normalizedPlate] ?? 0) + 1 } : { [normalizedPlate]: 1 };
            const consensusPlate = Object.entries(votes).sort((left, right) => right[1] - left[1])[0][0];
            const observations = continuous ? previous.observations + 1 : 1;
            const candidate: LprCandidate = {
              key, plate: consensusPlate, processId: process.id, stageId: stage.id, cameraId,
              firstSeen: continuous ? previous.firstSeen : frame.timestamp,
              lastSeen: frame.timestamp,
              // The worker has already detected the plate, cropped it and run the
              // LPR recognizer on that captured image. One valid OCR result is
              // therefore enough to start the lifecycle; later frames only vote
              // for matching and do not gate the initial record.
              confirmed: true,
              observations,
              votes,
              lastBox: plate.box,
              plateImage: plate.plateImage ?? previous?.plateImage,
              plateFingerprint: plate.plateFingerprint ?? previous?.plateFingerprint
            };
            candidateMap.current[key] = candidate;
            // Record the temporal majority-vote value, not the latest noisy OCR frame.
            if (candidate.confirmed) confirmed.push({ process, stage, plate: candidate.plate, plateImage: candidate.plateImage, plateFingerprint: candidate.plateFingerprint });
          });
        });
      });
      const expiredCandidates: LprCandidate[] = [];
      Object.entries(candidateMap.current).forEach(([key, candidate]) => {
        if (candidate.cameraId === cameraId && !matchedKeys.has(key) && frame.timestamp - candidate.lastSeen > consecutiveFrameToleranceSeconds) {
          expiredCandidates.push(candidate);
          delete candidateMap.current[key];
        }
      });
      setPlateCandidates(Object.values(candidateMap.current));
      if (confirmed.length || expiredCandidates.length) setJourneys((current) => {
        let next = confirmed.reduce((items, item) => observeJourney(items, item.process, item.stage, item.plate, frame.timestamp, workerState, item), current);
        expiredCandidates.forEach((candidate) => {
          next = next.map((journey) => {
            if (journey.status !== 'active' || journey.processId !== candidate.processId || journey.currentStageId !== candidate.stageId) return journey;
            if (!plateIdentityMatches(journey.plate, candidate.plate, journey.plateFingerprint, candidate.plateFingerprint)) return journey;
            const copy = structuredClone(journey);
            const visit = openVisit(copy, candidate.stageId);
            if (!visit) return journey;
            visit.leftAt = candidate.lastSeen;
            visit.lastSeenAt = candidate.lastSeen;
            const stage = processes.find((process) => process.id === candidate.processId)?.stages.find((item) => item.id === candidate.stageId);
            copy.events.push(event('vehicle_left', candidate.stageId, candidate.lastSeen, `${copy.plate} left ${stage?.name ?? 'station'}`));
            return copy;
          });
        });
        return next;
      });
    });
  }, [vision.frames, processes]);

  const value = useMemo<LprContextValue>(() => ({
    processes, journeys, plateCandidates, selectedProcessId, setSelectedProcessId,
    addProcess: () => {
      const camera = vision.getCamera();
      const process = { ...defaultProcess(camera.id, camera.plantId, camera.configuration.zones.map((zone) => zone.id)), id: `process-${Date.now()}`, name: `Vehicle Process ${processes.length + 1}` };
      setProcesses((current) => [...current, process]); setSelectedProcessId(process.id);
    },
    updateProcess: (id, update) => setProcesses((current) => current.map((process) => {
      if (process.id !== id) return process;
      const next = { ...process, ...update };
      return { ...next, stages: next.stages.map((stage, index) => ({ ...stage, order: index })) };
    })),
    reorderStages: (processId, orderedStageIds) => setProcesses((current) => current.map((process) => {
      if (process.id !== processId) return process;
      const byId = new Map(process.stages.map((stage) => [stage.id, stage]));
      const reordered = orderedStageIds.map((id) => byId.get(id)).filter((stage): stage is LprStage => Boolean(stage));
      process.stages.forEach((stage) => { if (!orderedStageIds.includes(stage.id)) reordered.push(stage); });
      return { ...process, stages: reordered.map((stage, index) => ({ ...stage, order: index })) };
    })),
    removeProcess: (id) => setProcesses((current) => current.filter((process) => process.id !== id)),
    recordScan: (processId, stageId, plate, workerState = 'idle', timestamp = Date.now() / 1000) => {
      const process = processes.find((item) => item.id === processId); const stage = process?.stages.find((item) => item.id === stageId);
      if (process && stage) setJourneys((current) => observeJourney(current, process, stage, plate, timestamp, workerState));
    },
    updateJourneyPlate: (id, plateInput) => {
      const plate = normalizePlate(plateInput);
      if (plate) setJourneys((current) => current.map((journey) => journey.id === id ? { ...journey, plate } : journey));
    },
    completeJourney: (id) => setJourneys((current) => current.map((journey) => {
      if (journey.id !== id || journey.status === 'completed') return journey;
      const timestamp = Date.now() / 1000;
      const copy = structuredClone(journey);
      copy.status = 'completed'; copy.completedAt = timestamp; copy.completionReason = 'manual'; copy.lastActivityAt = timestamp;
      const visit = openVisit(copy, copy.currentStageId);
      if (visit) { visit.leftAt = timestamp; visit.lastSeenAt = timestamp; }
      copy.events.push(event('journey_completed', copy.currentStageId, timestamp, `${copy.plate} journey completed manually`));
      return copy;
    })),
    clearJourney: (id) => setJourneys((current) => current.filter((journey) => journey.id !== id))
  }), [processes, journeys, plateCandidates, selectedProcessId, vision]);
  return <LprContext.Provider value={value}>{children}</LprContext.Provider>;
}

export function useLpr() {
  const context = useContext(LprContext);
  if (!context) throw new Error('useLpr must be used inside LprProvider');
  return context;
}

function duration(seconds: number) {
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 3600)}h ${Math.floor(total % 3600 / 60)}m ${total % 60}s`;
}

function stageDuration(visit: LprVisit) { return (visit.leftAt ?? visit.lastSeenAt) - visit.enteredAt; }

export function LegacyLprPage() {
  const vision = useVision();
  const lpr = useLpr();
  const [tab, setTab] = useState<'process' | 'live' | 'history'>('process');
  const [plate, setPlate] = useState('MH12AB1234');
  const [testStageId, setTestStageId] = useState('');
  const [testWorker, setTestWorker] = useState<WorkerState>('idle');
  const [selectedJourneyId, setSelectedJourneyId] = useState('');
  const process = lpr.processes.find((item) => item.id === lpr.selectedProcessId) ?? lpr.processes[0];
  const selectedJourney = lpr.journeys.find((item) => item.id === selectedJourneyId) ?? lpr.journeys[0];

  function updateStages(stages: LprStage[]) { if (process) lpr.updateProcess(process.id, { stages }); }
  function updateStage(id: string, update: Partial<LprStage>) { if (process) updateStages(process.stages.map((stage) => stage.id === id ? { ...stage, ...update } : stage)); }
  function addStage() { if (!process) return; const camera = vision.getCamera(); updateStages([...process.stages, { id: `stage-${Date.now()}`, order: process.stages.length, name: `Station ${process.stages.length}`, type: 'station', cameraId: camera.id, zoneId: camera.configuration.zones[0]?.id ?? '', trackWorker: true }]); }

  const processJourneys = lpr.journeys.filter((journey) => !process || journey.processId === process.id);
  const activeJourneys = processJourneys.filter((journey) => journey.status === 'active');
  const completedJourneys = processJourneys.filter((journey) => journey.status === 'completed');
  return <div className="page-stack lpr-page">
    <div className="page-title"><div><span className="eyebrow">VEHICLE INTELLIGENCE / LPR</span><h2>Number plate lifecycle</h2><p>The first valid plate detection is cropped, recognized and stored immediately; later frames are used only to keep tracking it.</p></div><div className="definition-actions"><select value={lpr.selectedProcessId} onChange={(e) => lpr.setSelectedProcessId(e.target.value)}>{lpr.processes.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select><button className="primary" type="button" onClick={lpr.addProcess}><Plus size={16} /> New process</button></div></div>
    <section className="lpr-kpis"><article className="panel"><Truck /><span><small>Active vehicles</small><strong>{activeJourneys.length}</strong></span></article><article className="panel"><Check /><span><small>Completed journeys</small><strong>{completedJourneys.length}</strong></span></article><article className="panel"><Route /><span><small>Process stages</small><strong>{process?.stages.length ?? 0}</strong></span></article><article className="panel"><ScanLine /><span><small>LPR model</small><strong>{vision.models.some((model) => model.id === 'indian_lpr' && model.installed) ? 'Ready' : 'Unavailable'}</strong></span></article></section>
    <div className="panel-tabs lpr-tabs"><button className={tab === 'process' ? 'active' : ''} type="button" onClick={() => setTab('process')}>Process master</button><button className={tab === 'live' ? 'active' : ''} type="button" onClick={() => setTab('live')}>Live lifecycle</button><button className={tab === 'history' ? 'active' : ''} type="button" onClick={() => setTab('history')}>Journey history</button></div>
    {tab === 'process' && process ? <>
      <section className="panel lpr-process-head"><div className="form-grid"><label className="field"><span>Process name</span><input value={process.name} onChange={(e) => lpr.updateProcess(process.id, { name: e.target.value })} /></label><label className="field"><span>Recognition model</span><select value={process.modelId} disabled><option value="indian_lpr">Indian Number Plate Detection + OCR</option></select></label></div><button className="secondary" type="button" onClick={() => lpr.updateProcess(process.id, { active: !process.active })}>{process.active ? <Pause size={15} /> : <Play size={15} />}{process.active ? 'Pause process' : 'Activate process'}</button></section>
      <section className="panel lpr-flow"><div className="section-heading"><div><span className="eyebrow">PROCESS FLOW</span><h2>Camera and zone sequence</h2><p>The first valid plate crop at the entry stage starts its lifecycle immediately. A zone is optional when one camera represents one checkpoint.</p></div><button className="secondary" type="button" onClick={addStage}><Plus size={15} /> Add station</button></div><div className="lpr-stage-flow">{process.stages.map((stage, index) => { const camera = vision.getCamera(stage.cameraId); return <div className="lpr-stage-wrap" key={stage.id}><article className={`lpr-stage ${stage.type}`}><header><span>{index + 1}</span><select value={stage.type} onChange={(e) => updateStage(stage.id, { type: e.target.value as StageType })}><option value="entry">Entry point</option><option value="station">Work station</option><option value="exit">Exit point</option></select><button title="Remove stage" disabled={process.stages.length <= 2} type="button" onClick={() => updateStages(process.stages.filter((item) => item.id !== stage.id))}><Trash2 size={14} /></button></header><label><small>Stage name</small><input value={stage.name} onChange={(e) => updateStage(stage.id, { name: e.target.value })} /></label><label><small>Camera</small><select value={stage.cameraId} onChange={(e) => { const nextCamera = vision.getCamera(e.target.value); updateStage(stage.id, { cameraId: e.target.value, zoneId: '' }); }}>{vision.cameras.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label><label><small>Plate ROI / zone (optional)</small><select value={stage.zoneId} onChange={(e) => updateStage(stage.id, { zoneId: e.target.value })}><option value="">Whole camera frame</option>{camera.configuration.zones.map((zone) => <option value={zone.id} key={zone.id}>{zone.name}</option>)}</select></label><label className="lpr-check"><input type="checkbox" checked={stage.trackWorker} onChange={(e) => updateStage(stage.id, { trackWorker: e.target.checked })} /> Track worker start / stop</label></article>{index < process.stages.length - 1 ? <ArrowRight className="lpr-arrow" size={20} /> : null}</div>; })}</div></section>
      <section className="panel lpr-test"><div><span className="eyebrow">TEST THE FLOW</span><h3>Record a simulated scan</h3><p>Use this before connecting cameras to verify lifecycle timing and summaries.</p></div><input aria-label="Test number plate" value={plate} onChange={(e) => setPlate(e.target.value.toUpperCase())} /><select value={testStageId || process.stages[0]?.id} onChange={(e) => setTestStageId(e.target.value)}>{process.stages.map((stage) => <option value={stage.id} key={stage.id}>{stage.name}</option>)}</select><select value={testWorker} onChange={(e) => setTestWorker(e.target.value as WorkerState)}><option value="working">Worker working</option><option value="idle">Worker stopped / idle</option><option value="absent">Worker absent</option></select><button className="primary" type="button" onClick={() => { lpr.recordScan(process.id, testStageId || process.stages[0]?.id, plate, testWorker); setTab('live'); }}><ScanLine size={15} /> Record scan</button></section>
    </> : null}
    {tab === 'live' ? <><section className="panel lpr-verification"><div className="section-heading"><div><span className="eyebrow">PLATE CAPTURE</span><h2>Immediate snapshot recognition</h2><p>The strongest valid plate crop is saved immediately and reused as the vehicle identity.</p></div></div>{lpr.plateCandidates.filter((item) => !process || item.processId === process.id).map((candidate) => { const stage = process?.stages.find((item) => item.id === candidate.stageId); return <article key={candidate.key}>{candidate.plateImage ? <img className="lm-candidate-image" src={candidate.plateImage} alt={candidate.plate} /> : <span className="plate-badge">{candidate.plate}</span>}<span><strong>Captured and recorded</strong><small>{stage?.name ?? candidate.stageId} · OCR {candidate.plate}</small><i><b style={{ width: '100%' }} /></i></span></article>; })}{!lpr.plateCandidates.some((item) => !process || item.processId === process.id) ? <div className="timeline-empty">Waiting for a number plate detection from a running LPR camera.</div> : null}</section><section className="panel lpr-journeys"><div className="section-heading"><div><span className="eyebrow">ACTIVE LIFECYCLES</span><h2>Vehicles currently in process</h2></div></div>{activeJourneys.length ? activeJourneys.map((journey) => { const stage = process?.stages.find((item) => item.id === journey.currentStageId); return <button type="button" key={journey.id} onClick={() => { setSelectedJourneyId(journey.id); setTab('history'); }}><span className="plate-badge">{journey.plate}</span><span><strong>{stage?.name ?? journey.currentStageId}</strong><small>Captured {new Date(journey.startedAt * 1000).toLocaleTimeString()}</small></span><span><small>Elapsed</small><strong>{duration(Date.now() / 1000 - journey.startedAt)}</strong></span><ArrowRight size={16} /></button>; }) : <div className="timeline-empty">No vehicle captured yet. Start the mapped entry camera and show a readable number plate.</div>}</section></> : null}
    {tab === 'history' ? <section className="lpr-history-layout"><div className="panel lpr-history-list"><div className="section-heading"><div><span className="eyebrow">JOURNEYS</span><h2>Plate history</h2></div></div>{processJourneys.map((journey) => <button className={selectedJourney?.id === journey.id ? 'active' : ''} type="button" key={journey.id} onClick={() => setSelectedJourneyId(journey.id)}><span className="plate-badge">{journey.plate}</span><span><strong>{journey.status}</strong><small>{new Date(journey.startedAt * 1000).toLocaleString()}</small></span></button>)}</div>{selectedJourney ? <div className="panel lpr-summary"><header><div><span className="plate-badge large">{selectedJourney.plate}</span><h2>Lifecycle summary</h2><p>Total {duration((selectedJourney.completedAt ?? Date.now() / 1000) - selectedJourney.startedAt)}</p></div><span className={`pill ${selectedJourney.status === 'completed' ? 'green' : 'orange'}`}>{selectedJourney.status}</span></header><div className="lpr-visit-grid">{selectedJourney.visits.map((visit, index) => { const stage = process?.stages.find((item) => item.id === visit.stageId); const previous = selectedJourney.visits[index - 1]; const travel = previous ? visit.enteredAt - (previous.leftAt ?? previous.lastSeenAt) : 0; return <article key={`${visit.stageId}-${visit.enteredAt}`}><span>{index + 1}</span><strong>{stage?.name ?? visit.stageId}</strong><small>At station: {duration(stageDuration(visit))}</small><small>Working: {duration(visit.workingSeconds)}</small><small>Stopped/idle: {duration(visit.idleSeconds)}</small><small>Worker absent: {duration(visit.absentSeconds)}</small>{previous ? <em>Between zones: {duration(travel)}</em> : null}</article>; })}</div><div className="lpr-event-list">{selectedJourney.events.slice().reverse().map((item) => <div key={item.id}><time>{new Date(item.timestamp * 1000).toLocaleTimeString()}</time><i /><span><strong>{item.detail}</strong><small>{item.type.replaceAll('_', ' ')}</small></span></div>)}</div></div> : <div className="panel timeline-empty">Select a journey to view the station and worker-time summary.</div>}</section> : null}
  </div>;
}

type LifecycleAutomation = MigratedLifecycleAutomation;
const legacyLifecycleAutomationKey = 'optivision-lifecycle-automations-v1';
const lifecycleAutomationKey = 'optivision-lifecycle-automations-v2';

function defaultLifecycleAutomations(process?: LprProcess): LifecycleAutomation[] {
  if (!process) return [];
  const stationIds = process.stages.filter((stage) => stage.type === 'station').map((stage) => stage.id);
  return [
    { id: 'customer-stage', name: 'Customer Stage Update', audience: 'Customer', trigger: 'Vehicle reached station', channels: ['WhatsApp', 'Email'], processId: process.id, stationIds, unresolvedStationNames: [], shareImage: true, active: true },
    { id: 'admin-summary', name: 'Admin Stage Summary', audience: 'Admin / Workshop Manager', trigger: 'Vehicle left station', channels: ['WhatsApp', 'Email'], processId: process.id, stationIds: [], unresolvedStationNames: [], shareImage: true, active: true },
    { id: 'delay-alert', name: 'Vehicle Delay Alert', audience: 'Customer', trigger: 'Vehicle delayed', channels: ['WhatsApp'], processId: process.id, stationIds: [], unresolvedStationNames: [], shareImage: false, active: true },
    { id: 'process-complete', name: 'End of Process Notification', audience: 'Customer', trigger: 'Vehicle exited end station', channels: ['Email'], processId: process.id, stationIds: [], unresolvedStationNames: [], shareImage: false, active: false }
  ];
}

function loadLifecycleAutomations(processes: LprProcess[]) {
  const current = readStoredJson<unknown>(lifecycleAutomationKey, null);
  if (Array.isArray(current)) return migrateLifecycleAutomations(current, processes);
  const legacy = readStoredJson<unknown>(legacyLifecycleAutomationKey, null);
  const migrated = Array.isArray(legacy)
    ? migrateLifecycleAutomations(legacy, processes)
    : defaultLifecycleAutomations(processes[0]);
  writeStoredJson(lifecycleAutomationKey, migrated);
  return migrated;
}

function shortDuration(seconds: number) {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total}s`;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total % 3600 / 60);
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function journeyTotal(journey: LprJourney) { return (journey.completedAt ?? Date.now() / 1000) - journey.startedAt; }
function journeyProcessing(journey: LprJourney) { return journey.visits.reduce((sum, visit) => sum + (visit.leftAt ? stageDuration(visit) : Math.max(0, Date.now() / 1000 - visit.enteredAt)), 0); }
function journeyWaiting(journey: LprJourney) { return journey.visits.reduce((sum, visit, index) => index ? sum + Math.max(0, visit.enteredAt - (journey.visits[index - 1].leftAt ?? journey.visits[index - 1].lastSeenAt)) : sum, 0); }
function journeyWorker(journey: LprJourney, key: 'workingSeconds' | 'idleSeconds' | 'absentSeconds') { return journey.visits.reduce((sum, visit) => sum + visit[key], 0); }

function LifecycleMapping({ process }: { process: LprProcess }) {
  const vision = useVision();
  const lpr = useLpr();
  const [notice, setNotice] = useState('');
  const updateStage = (stageId: string, update: Partial<LprStage>) => lpr.updateProcess(process.id, { stages: process.stages.map((stage) => stage.id === stageId ? { ...stage, ...update } : stage) });
  const setBoundary = (stageId: string, type: 'entry' | 'exit') => lpr.updateProcess(process.id, { stages: process.stages.map((stage) => ({ ...stage, type: stage.id === stageId ? type : stage.type === type ? 'station' : stage.type })) });
  async function activateAndStartMappedCameras() {
    lpr.updateProcess(process.id, { active: true });
    const cameraIds = [...new Set(process.stages.map((stage) => stage.cameraId).filter(Boolean))];
    const unavailable: string[] = [];
    for (const cameraId of cameraIds) {
      const camera = vision.cameras.find((item) => item.id === cameraId);
      if (!camera || camera.sourceStatus !== 'ready') { unavailable.push(camera?.name ?? cameraId); continue; }
      if (!camera.configuration.selectedModelIds.includes('indian_lpr')) {
        vision.updateConfiguration(cameraId, (configuration) => ({ ...configuration, selectedModelIds: [...configuration.selectedModelIds, 'indian_lpr'] }));
      }
      if (!vision.running[cameraId]) {
        try { await vision.toggleEngine(cameraId); } catch { unavailable.push(camera.name); }
      }
    }
    setNotice(unavailable.length ? `Mapping activated. Connect or configure: ${unavailable.join(', ')}` : `Mapping activated and ${cameraIds.length} mapped camera engine${cameraIds.length === 1 ? '' : 's'} started`);
  }
  return <div className="lm-stack"><div className="lm-page-head"><div><span>LPR Cycle <ArrowRight size={12} /> Station Mapping</span><h2>Lifecycle Station Mapping</h2><p>Map existing cameras to stations. A valid plate at the start station automatically creates its journey.</p></div><div><button className="lm-secondary" onClick={() => setNotice('Mapping saved. Lifecycle will start automatically when an entry plate is identified.')} type="button"><FileText size={15} />Save Mapping</button><button className="lm-primary" onClick={() => void activateAndStartMappedCameras()} type="button"><Play size={15} />Save &amp; Start Mapped Cameras</button></div></div>{notice ? <div className="lm-toast"><Check size={14} />{notice}</div> : null}<section className="lm-card lm-config"><h3><FileText size={18} />Configuration Details</h3><div><label><span>Configuration Name *</span><input value={process.name} onChange={(event) => lpr.updateProcess(process.id, { name: event.target.value })} /></label><label><span>Workshop *</span><select><option>Riverside Automotive Workshop</option></select></label><aside><AlertTriangle size={17} />Only one start station and one end station allowed.</aside></div><div className="lm-flow-settings"><label><span>Station flow</span><select value={process.flowMode ?? 'strict'} onChange={(event) => lpr.updateProcess(process.id, { flowMode: event.target.value as LprProcess['flowMode'] })}><option value="strict">Strict mapped order</option><option value="flexible">Allow station skipping</option></select></label><label><span>Minimum transition</span><div><input min="0" max="300" type="number" value={process.minimumTransitionSeconds ?? 2} onChange={(event) => lpr.updateProcess(process.id, { minimumTransitionSeconds: Math.max(0, Number(event.target.value)) })} /><small>seconds</small></div></label><label><span>Missing-exit review</span><div><input min="1" max="1440" type="number" value={process.staleAfterMinutes ?? 30} onChange={(event) => lpr.updateProcess(process.id, { staleAfterMinutes: Math.max(1, Number(event.target.value)) })} /><small>minutes</small></div></label></div></section><section className="lm-card lm-mapping"><header><MapPin size={20} /><div><h3>Station Mapping</h3><p>Assign cameras to each station. Vehicles will be tracked automatically based on the order of station entries.</p></div></header><div className="lm-table-wrap"><table><thead><tr><th>#</th><th>Station Name</th><th>Assigned Camera</th><th>Zone</th><th>Track Worker Activity</th><th>Start Station</th><th>End Station</th><th>Status</th></tr></thead><tbody>{process.stages.map((stage, index) => { const camera = vision.cameras.find((item) => item.id === stage.cameraId); const isRunning = Boolean(stage.cameraId && vision.running[stage.cameraId]); return <tr key={stage.id}><td>{index + 1}</td><td><input value={stage.name} onChange={(event) => updateStage(stage.id, { name: event.target.value })} /></td><td><select value={stage.cameraId} onChange={(event) => updateStage(stage.id, { cameraId: event.target.value, zoneId: '' })}><option value="">Select camera</option>{vision.cameras.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></td><td><select disabled={!camera} value={stage.zoneId} onChange={(event) => updateStage(stage.id, { zoneId: event.target.value })}><option value="">Whole camera frame</option>{camera?.configuration.zones.map((zone) => <option value={zone.id} key={zone.id}>{zone.name}</option>)}</select></td><td><button aria-label={`Track worker at ${stage.name}`} className={`lm-toggle ${stage.trackWorker ? 'on' : ''}`} onClick={() => updateStage(stage.id, { trackWorker: !stage.trackWorker })} type="button"><i /></button></td><td><button aria-label={`${stage.name} start station`} className={`lm-radio ${stage.type === 'entry' ? 'on' : ''}`} onClick={() => setBoundary(stage.id, 'entry')} type="button"><i /></button></td><td><button aria-label={`${stage.name} end station`} className={`lm-radio ${stage.type === 'exit' ? 'on' : ''}`} onClick={() => setBoundary(stage.id, 'exit')} type="button"><i /></button></td><td><span className={`lm-status ${isRunning ? 'green' : 'gray'}`}><i />{!stage.cameraId ? 'Unmapped' : isRunning ? 'Running' : camera?.sourceStatus === 'ready' ? 'Paused' : 'Not connected'}</span></td></tr>; })}</tbody></table></div><div className="lm-logic"><Settings2 size={22} /><span><strong>Automatic journey logic</strong><small>A valid plate at the mapped start camera immediately starts a separate lifecycle. Later mapped-station detections move only that matching vehicle forward.</small></span></div></section></div>;
}

export function LifecycleStationSetup({ plantId }: { plantId: string }) {
  const vision = useVision();
  const lpr = useLpr();
  const [notice, setNotice] = useState('');
  const [noticeTone, setNoticeTone] = useState<'success' | 'info'>('success');
  const [newStationName, setNewStationName] = useState('');
  const [newStationCameraId, setNewStationCameraId] = useState('');
  const [newStationType, setNewStationType] = useState<StageType>('station');
  const process = lpr.processes.find((item) => item.id === lpr.selectedProcessId) ?? lpr.processes[0];
  if (!process) return <div className="lm-empty">No lifecycle process is configured.</div>;

  const availableCameras = vision.cameras;
  const mappedCameraIds = new Set(process.stages.map((stage) => stage.cameraId).filter(Boolean));
  const lprModel = vision.models.find((model) => model.id === 'indian_lpr');
  const updateStages = (stages: LprStage[]) => lpr.updateProcess(process.id, { stages });
  const updateStage = (stageId: string, update: Partial<LprStage>) => updateStages(process.stages.map((stage) => stage.id === stageId ? { ...stage, ...update } : stage));
  const setBoundary = (stageId: string, type: 'entry' | 'exit') => {
    const selected = process.stages.find((stage) => stage.id === stageId);
    if (!selected || selected.type === type) return;
    // Swapping entry and exit directly must never leave the lifecycle without
    // one of its required boundaries.
    const priorType = selected.type;
    updateStages(process.stages.map((stage) => {
      if (stage.id === stageId) return { ...stage, type };
      if (stage.type !== type) return stage;
      return { ...stage, type: priorType === 'entry' || priorType === 'exit' ? priorType : 'station' };
    }));
  };
  const moveStage = (stageId: string, direction: -1 | 1) => {
    const index = process.stages.findIndex((stage) => stage.id === stageId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= process.stages.length) return;
    const ids = process.stages.map((stage) => stage.id);
    [ids[index], ids[target]] = [ids[target], ids[index]];
    lpr.reorderStages(process.id, ids);
  };
  const addStation = () => {
    const name = newStationName.trim();
    if (!name) {
      setNoticeTone('info');
      setNotice('Enter a name for the custom station.');
      return;
    }
    if (newStationCameraId && mappedCameraIds.has(newStationCameraId)) {
      setNoticeTone('info');
      setNotice('That camera is already assigned to another station. Select a different camera.');
      return;
    }
    const exitIndex = process.stages.findIndex((stage) => stage.type === 'exit');
    const insertAt = newStationType === 'entry' ? 0 : newStationType === 'exit' ? process.stages.length : exitIndex >= 0 ? exitIndex : process.stages.length;
    const stages = process.stages.map((stage) => stage.type === newStationType && newStationType !== 'station' ? { ...stage, type: 'station' as const } : stage);
    stages.splice(insertAt, 0, {
      id: `stage-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      order: insertAt,
      name,
      type: newStationType, cameraId: newStationCameraId, zoneId: '', trackWorker: newStationType === 'station'
    });
    updateStages(stages);
    const cameraName = vision.cameras.find((camera) => camera.id === newStationCameraId)?.name;
    setNoticeTone('success');
    setNotice(cameraName ? `${name} was added and mapped to ${cameraName}.` : `${name} was added. You can assign its camera from the station row.`);
    setNewStationName('');
    setNewStationCameraId('');
    setNewStationType('station');
  };
  const deleteStation = (stage: LprStage) => {
    if (process.stages.length <= 2 || !window.confirm(`Delete ${stage.name}? Existing journey history will keep its station ID reference.`)) return;
    const remaining = process.stages.filter((item) => item.id !== stage.id);
    if (stage.type === 'entry') remaining[0] = { ...remaining[0], type: 'entry' };
    if (stage.type === 'exit') remaining[remaining.length - 1] = { ...remaining[remaining.length - 1], type: 'exit' };
    updateStages(remaining);
  };
  const saveAndStart = async () => {
    const entryStage = process.stages.find((stage) => stage.type === 'entry');
    if (!entryStage?.cameraId) {
      setNoticeTone('info');
      setNotice('Select a camera for the Start station. Plate detections cannot create a lifecycle until that camera is mapped.');
      return;
    }
    lpr.updateProcess(process.id, { active: true, plantId });
    const unavailable: string[] = [];
    for (const cameraId of mappedCameraIds) {
      const camera = vision.cameras.find((item) => item.id === cameraId);
      if (!camera || camera.sourceStatus !== 'ready') { unavailable.push(camera?.name ?? cameraId); continue; }
      if (!camera.configuration.selectedModelIds.includes('indian_lpr')) vision.updateConfiguration(cameraId, (configuration) => ({ ...configuration, selectedModelIds: [...configuration.selectedModelIds, 'indian_lpr'] }));
      if (!vision.running[cameraId]) try { await vision.toggleEngine(cameraId); } catch { unavailable.push(camera.name); }
    }
    setNoticeTone(unavailable.length ? 'info' : 'success');
    setNotice(unavailable.length ? `Mapping saved. Connect or configure: ${unavailable.join(', ')}` : 'Station mapping saved and mapped cameras started.');
  };

  return <div className="lm-stack setup-lifecycle-step">
    <div className="lm-page-head"><div><span>Setup <ArrowRight size={12} /> Station Mapping</span><h2>Build the vehicle journey</h2><p>Add, rename, reorder, map or remove stations manually. Existing station IDs remain stable.</p></div><button className="lm-primary" type="button" onClick={() => void saveAndStart()}><Play size={15} />Save mapping</button></div>
    {notice ? <div className={`inline-status ${noticeTone}`}>{noticeTone === 'success' ? <Check size={15} /> : <AlertTriangle size={15} />}<span><strong>{noticeTone === 'success' ? 'Lifecycle setup saved' : 'Lifecycle setup needs attention'}</strong><small>{notice}</small></span></div> : null}
    {!lprModel?.installed ? <div className="inline-status info"><AlertTriangle size={16} /><span><strong>Indian LPR is unavailable</strong><small>The worker does not have the external Indian_LPR checkout and required weights. A visible plate box without recognized OCR text cannot create a vehicle lifecycle.</small></span></div> : null}
    <section className="lm-card lm-add-station">
      <header><div><h3>Add station</h3><p>Create a station, choose its camera feed, and decide whether it starts or ends the lifecycle.</p></div><span>{availableCameras.length} cameras available</span></header>
      <div><label><span>Station name *</span><input placeholder="Example: Paint Booth" value={newStationName} onChange={(event) => setNewStationName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') addStation(); }} /></label><label><span>Camera feed</span><select value={newStationCameraId} onChange={(event) => setNewStationCameraId(event.target.value)}><option value="">Assign camera later</option>{availableCameras.map((camera) => { const assignedStage = process.stages.find((stage) => stage.cameraId === camera.id); const plant = vision.plants.find((candidate) => candidate.id === camera.plantId); const cameraName = camera.name.trim() || camera.id; return <option disabled={Boolean(assignedStage)} key={camera.id} value={camera.id}>{cameraName}{assignedStage ? ` · assigned to ${assignedStage.name}` : plant ? ` · ${plant.name}` : ''}</option>; })}</select></label><label><span>Station role</span><select value={newStationType} onChange={(event) => setNewStationType(event.target.value as StageType)}><option value="station">Normal station</option><option value="entry">Start station</option><option value="exit">End station</option></select></label><button className="lm-primary" onClick={addStation} type="button"><Plus size={15} />Add station</button></div>
      <small>Only one Start and one End station are active. Choosing either role here changes the previous boundary station back to a normal station.</small>
    </section>
    <section className="lm-card lm-mapping"><header><Route size={20} /><div><h3>Ordered stations</h3><p>Choose one start and one end station. Each camera can be used once; its plant is shown so entry and exit cameras can be mapped across sites.</p></div></header><div className="lm-table-wrap"><table><thead><tr><th>Order</th><th>Station name</th><th>Camera</th><th>Zone</th><th>Worker activity</th><th>Start</th><th>End</th><th>Actions</th></tr></thead><tbody>{process.stages.map((stage, index) => { const camera = vision.cameras.find((item) => item.id === stage.cameraId); return <tr key={stage.id}><td><div className="lm-order-actions"><button disabled={index === 0} aria-label={`Move ${stage.name} earlier`} onClick={() => moveStage(stage.id, -1)} type="button"><ArrowLeft size={13} /></button><strong>{index + 1}</strong><button disabled={index === process.stages.length - 1} aria-label={`Move ${stage.name} later`} onClick={() => moveStage(stage.id, 1)} type="button"><ArrowRight size={13} /></button></div></td><td><input aria-label={`Station ${index + 1} name`} value={stage.name} onChange={(event) => updateStage(stage.id, { name: event.target.value })} /></td><td><select aria-label={`${stage.name} camera`} value={stage.cameraId} onChange={(event) => updateStage(stage.id, { cameraId: event.target.value, zoneId: '' })}><option value="">Select camera</option>{availableCameras.map((item) => { const assignedStage = process.stages.find((other) => other.id !== stage.id && other.cameraId === item.id); const plant = vision.plants.find((candidate) => candidate.id === item.plantId); const cameraName = item.name.trim() || item.id; return <option disabled={Boolean(assignedStage)} key={item.id} value={item.id}>{cameraName}{assignedStage ? ` · assigned to ${assignedStage.name}` : plant ? ` · ${plant.name}` : ''}</option>; })}</select></td><td><select aria-label={`${stage.name} zone`} disabled={!camera} value={stage.zoneId} onChange={(event) => updateStage(stage.id, { zoneId: event.target.value })}><option value="">Whole frame</option>{camera?.configuration.zones.map((zone) => <option key={zone.id} value={zone.id}>{zone.name}</option>)}</select></td><td><button className={`lm-toggle ${stage.trackWorker ? 'on' : ''}`} aria-label={`Track worker at ${stage.name}`} onClick={() => updateStage(stage.id, { trackWorker: !stage.trackWorker })} type="button"><i /></button></td><td><label className="lm-radio-choice"><input aria-label={`${stage.name} start station`} checked={stage.type === 'entry'} name={`lpr-start-${process.id}`} onChange={() => setBoundary(stage.id, 'entry')} type="radio" /><i /></label></td><td><label className="lm-radio-choice"><input aria-label={`${stage.name} end station`} checked={stage.type === 'exit'} name={`lpr-end-${process.id}`} onChange={() => setBoundary(stage.id, 'exit')} type="radio" /><i /></label></td><td><button className="lm-delete-station" disabled={process.stages.length <= 2} aria-label={`Delete ${stage.name}`} onClick={() => deleteStation(stage)} type="button"><Trash2 size={14} /></button></td></tr>; })}</tbody></table></div></section>
  </div>;
}

function LifecycleTracking({ process, openSummary }: { process: LprProcess; openSummary: (journey: LprJourney) => void }) {
  const lpr = useLpr();
  const [query, setQuery] = useState('');
  const [station, setStation] = useState('');
  const [status, setStatus] = useState('');
  const journeys = lpr.journeys.filter((journey) => journey.processId === process.id);
  const visible = journeys.filter((journey) => journey.plate.includes(query.toUpperCase()) && (!station || journey.currentStageId === station) && (!status || journey.status === status));
  const completed = journeys.filter((journey) => journey.status === 'completed');
  const active = journeys.filter((journey) => journey.status === 'active');
  const avg = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  const totalWorker = journeys.reduce((sum, item) => sum + journeyWorker(item, 'workingSeconds') + journeyWorker(item, 'idleSeconds'), 0);
  const activeWorker = journeys.reduce((sum, item) => sum + journeyWorker(item, 'workingSeconds'), 0);
  const correctPlate = (journey: LprJourney) => {
    const next = window.prompt('Correct vehicle number', journey.plate);
    if (next && normalizePlate(next)) lpr.updateJourneyPlate(journey.id, next);
  };
  const deleteJourney = (journey: LprJourney) => {
    if (window.confirm(`Delete ${journey.plate} and all of its lifecycle events?`)) lpr.clearJourney(journey.id);
  };
  const completeJourney = (journey: LprJourney) => {
    if (window.confirm(`Complete ${journey.plate} manually? Use this when the exit scan was missed.`)) lpr.completeJourney(journey.id);
  };
  return <div className="lm-stack"><div className="lm-page-head"><div><span>Lifecycle Management <ArrowRight size={12} /> Lifecycle Tracking</span><h2>Lifecycle Tracking</h2><p>Monitor detected vehicles, live station status, and reconstructed journeys.</p></div></div><section className="lm-card lm-filters"><label><span>Search Vehicles</span><div><Search size={15} /><input placeholder="Search by vehicle number..." value={query} onChange={(event) => setQuery(event.target.value)} /></div></label><label><span>Date Range</span><div><CalendarDays size={15} /><input readOnly value={new Date().toLocaleDateString()} /></div></label><label><span>Current Station</span><select value={station} onChange={(event) => setStation(event.target.value)}><option value="">All Stations</option>{process.stages.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label><label><span>Status</span><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">All Status</option><option value="active">In Progress</option><option value="completed">Completed</option></select></label><button className="lm-primary" type="button"><RefreshCw size={15} />Refresh</button></section><section className="lm-tracking-kpis"><article><Car /><span><small>Vehicles Today</small><strong>{journeys.length}</strong><em>Live captured data</em></span></article><article><Clock3 /><span><small>In Progress</small><strong>{active.length}</strong><em>Currently tracked</em></span></article><article><Check /><span><small>Completed</small><strong>{completed.length}</strong><em>Exited end station</em></span></article><article><AlertTriangle /><span><small>Delayed</small><strong>{active.filter((item) => journeyTotal(item) > 7200).length}</strong><em>Over two hours</em></span></article></section><div className="lm-tracking-grid"><section className="lm-card lm-entries"><header><List size={19} /><div><h3>Detected Vehicle Entries</h3><p>Click a row to open the complete vehicle journey summary.</p></div></header><div className="lm-table-wrap"><table><thead><tr><th>Vehicle Number</th><th>First Seen</th><th>Current Station</th><th>Last Captured Station</th><th>Total Elapsed</th><th>Status</th><th>Live Status</th><th>Last Seen</th><th>Actions</th></tr></thead><tbody>{visible.map((journey) => { const stage = process.stages.find((item) => item.id === journey.currentStageId); const lastVisit = journey.visits[journey.visits.length - 1]; const stale = journey.status === 'active' && Date.now() / 1000 - (journey.lastActivityAt ?? lastVisit.lastSeenAt) > (process.staleAfterMinutes ?? 30) * 60; return <tr key={journey.id} onClick={() => openSummary(journey)}><td><strong>{journey.plate}</strong></td><td>{new Date(journey.startedAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</td><td>{stage?.name ?? 'Unknown'}</td><td>{stage?.name ?? 'Unknown'}</td><td>{shortDuration(journeyTotal(journey))}</td><td><span className={`lm-badge ${stale ? 'stale' : journey.status}`}>{stale ? 'Needs Review' : journey.status === 'active' ? 'In Progress' : 'Completed'}</span></td><td><span className={`lm-live ${stale ? 'orange' : journey.status === 'active' ? 'green' : 'gray'}`}><i />{stale ? 'Exit missed' : journey.status === 'active' ? 'Live' : 'Exited'}</span></td><td>{new Date(lastVisit.lastSeenAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</td><td><div className="lm-row-actions">{journey.status === 'active' ? <button title="Complete journey manually" type="button" onClick={(event) => { event.stopPropagation(); completeJourney(journey); }}><Check size={14} /></button> : null}<button title="Correct plate number" type="button" onClick={(event) => { event.stopPropagation(); correctPlate(journey); }}><Pencil size={14} /></button><button title="Delete vehicle record" type="button" onClick={(event) => { event.stopPropagation(); deleteJourney(journey); }}><Trash2 size={14} /></button></div></td></tr>; })}{!visible.length ? <tr><td colSpan={9} className="lm-empty">No confirmed vehicle journeys yet. Start a mapped LPR camera to begin tracking.</td></tr> : null}</tbody></table></div></section><aside className="lm-card lm-live-panel"><header><Radio size={19} /><div><h3>Live Status</h3><p>Currently tracked vehicles in the workshop.</p></div></header>{active.slice(0, 8).map((journey) => <button key={journey.id} onClick={() => openSummary(journey)} type="button"><i /><span><strong>{journey.plate}</strong><small>At {process.stages.find((item) => item.id === journey.currentStageId)?.name}</small></span><em>{shortDuration(journeyTotal(journey))}</em></button>)}{!active.length ? <div className="lm-empty">No active vehicles</div> : null}</aside></div><section className="lm-card lm-performance"><header><BarChart3 size={19} /><h3>Workshop Performance (Today)</h3></header><div><article><Clock3 /><span><small>Avg Journey Time</small><strong>{shortDuration(avg(journeys.map(journeyTotal)))}</strong></span></article><article><Timer /><span><small>Avg Waiting Time</small><strong>{shortDuration(avg(journeys.map(journeyWaiting)))}</strong></span></article><article><UserRound /><span><small>Worker Active Time</small><strong>{totalWorker ? Math.round(activeWorker / totalWorker * 100) : 0}%</strong></span></article><article><Pause /><span><small>Worker Idle Time</small><strong>{totalWorker ? Math.round((totalWorker - activeWorker) / totalWorker * 100) : 0}%</strong></span></article></div></section></div>;
}

function LifecycleSummary({ process, journey, back }: { process: LprProcess; journey?: LprJourney; back: () => void }) {
  const lpr = useLpr();
  if (!journey) return <div className="lm-card lm-empty lm-summary-empty"><Car size={34} /><h2>No journey selected</h2><p>Open Lifecycle Tracking and select a vehicle.</p><button className="lm-primary" onClick={back} type="button">Back to Tracking</button></div>;
  const total = journeyTotal(journey); const processing = journeyProcessing(journey); const waiting = journeyWaiting(journey); const working = journeyWorker(journey, 'workingSeconds'); const idle = journeyWorker(journey, 'idleSeconds');
  const correctPlate = () => {
    const next = window.prompt('Correct vehicle number', journey.plate);
    if (next && normalizePlate(next)) lpr.updateJourneyPlate(journey.id, next);
  };
  const deleteRecord = () => {
    if (window.confirm(`Delete ${journey.plate} and all of its lifecycle events?`)) { lpr.clearJourney(journey.id); back(); }
  };
  const completeRecord = () => {
    if (window.confirm(`Complete ${journey.plate} manually? Use this only when the exit scan was missed.`)) lpr.completeJourney(journey.id);
  };
  return <div className="lm-stack"><div className="lm-page-head"><div><span>Lifecycle Management <ArrowRight size={12} /> Lifecycle Tracking <ArrowRight size={12} /> Vehicle Journey Summary</span><h2>Vehicle Journey Summary</h2><p>Journey reconstructed from actual station scans and worker events.</p></div><div><button className="lm-secondary" onClick={back} type="button"><ArrowLeft size={15} />Back to Tracking</button>{journey.status === 'active' ? <button className="lm-primary" onClick={completeRecord} type="button"><Check size={15} />Complete Journey</button> : null}<button className="lm-secondary" onClick={correctPlate} type="button"><Pencil size={15} />Correct Plate</button><button className="lm-danger" onClick={deleteRecord} type="button"><Trash2 size={15} />Delete Record</button><button className="lm-secondary" onClick={() => window.print()} type="button"><Download size={15} />Export PDF</button><button className="lm-primary" onClick={() => window.print()} type="button"><BarChart3 size={15} />Generate Report</button></div></div><section className="lm-card lm-journey-meta"><article>{journey.plateImage ? <img className="lm-journey-plate-image" src={journey.plateImage} alt={journey.plate} /> : <Car />}<span><small>Vehicle Number</small><strong>{journey.plate}</strong></span></article><article><CalendarDays /><span><small>Date</small><strong>{new Date(journey.startedAt * 1000).toLocaleDateString()}</strong></span></article><article><Check /><span><small>Overall Status</small><strong className={`lm-badge ${journey.status}`}>{journey.status === 'completed' ? 'Completed' : 'In Progress'}</strong></span></article><article><Clock3 /><span><small>Start Time</small><strong>{new Date(journey.startedAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</strong></span></article><article><CircleDot /><span><small>End Time</small><strong>{journey.completedAt ? new Date(journey.completedAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'}</strong></span></article></section><section className="lm-summary-kpis"><article><Clock3 /><span><small>Total Journey Time</small><strong>{shortDuration(total)}</strong></span></article><article><Settings2 /><span><small>Processing Time</small><strong>{shortDuration(processing)}</strong><em>{total ? Math.round(processing / total * 100) : 0}% of total time</em></span></article><article><Timer /><span><small>Waiting Between Stations</small><strong>{shortDuration(waiting)}</strong><em>{total ? Math.round(waiting / total * 100) : 0}% of total time</em></span></article><article><UserRound /><span><small>Worker Active Time</small><strong>{shortDuration(working)}</strong></span></article><article><Pause /><span><small>Worker Idle Time</small><strong>{shortDuration(idle)}</strong></span></article></section><section className="lm-card lm-sequence"><header><List size={18} /><div><h3>Actual captured station sequence</h3><p>Only visited stations are shown.</p></div></header><div>{journey.visits.map((visit, index) => { const stage = process.stages.find((item) => item.id === visit.stageId); return <article key={`${visit.stageId}-${visit.enteredAt}`}><i>{index + 1}</i><strong>{stage?.name ?? visit.stageId}</strong><small>{new Date(visit.enteredAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} → {visit.leftAt ? new Date(visit.leftAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Now'}</small><span>{shortDuration(stageDuration(visit))}</span><em>{stage?.type === 'entry' ? 'Entry' : stage?.type === 'exit' ? 'Exit' : 'Visited'}</em></article>; })}</div></section><div className="lm-summary-grid"><section className="lm-card lm-station-summary"><header><List size={18} /><div><h3>Station Summary</h3><p>Timing breakdown for each visited station.</p></div></header><div className="lm-table-wrap"><table><thead><tr><th>Station</th><th>Entry</th><th>Exit</th><th>Total Time</th><th>Waiting</th><th>Worker Active</th><th>Worker Idle</th></tr></thead><tbody>{journey.visits.map((visit, index) => <tr key={`${visit.stageId}-row`}><td>{process.stages.find((item) => item.id === visit.stageId)?.name}</td><td>{new Date(visit.enteredAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</td><td>{visit.leftAt ? new Date(visit.leftAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'}</td><td><strong>{shortDuration(stageDuration(visit))}</strong></td><td>{index ? shortDuration(Math.max(0, visit.enteredAt - (journey.visits[index - 1].leftAt ?? journey.visits[index - 1].lastSeenAt))) : '—'}</td><td>{shortDuration(visit.workingSeconds)}</td><td>{shortDuration(visit.idleSeconds)}</td></tr>)}</tbody></table></div></section><section className="lm-card lm-captured-log"><header><FileText size={18} /><div><h3>Captured Event Log</h3><p>Chronological list of key system events.</p></div></header>{journey.events.slice().reverse().map((item) => <div key={item.id}><i /><time>{new Date(item.timestamp * 1000).toLocaleTimeString()}</time><strong>{item.type.replaceAll('_', ' ')}</strong><span>{item.detail}</span></div>)}</section></div></div>;
}

function LifecycleAutomations({ process }: { process: LprProcess }) {
  const lpr = useLpr();
  const [automations, setAutomations] = useState<LifecycleAutomation[]>(() => loadLifecycleAutomations(lpr.processes));
  const [trigger, setTrigger] = useState('Vehicle reached station'); const [audience, setAudience] = useState('Customer'); const [channel, setChannel] = useState('WhatsApp');
  useEffect(() => { writeStoredJson(lifecycleAutomationKey, automations); }, [automations]);
  const update = (id: string, value: Partial<LifecycleAutomation>) => setAutomations((items) => items.map((item) => item.id === id ? { ...item, ...value } : item));
  const processAutomations = automations.filter((item) => item.processId === process.id);
  const stationNames = (item: LifecycleAutomation) => {
    const resolved = item.stationIds.map((id) => process.stages.find((stage) => stage.id === id)?.name ?? id);
    return [...resolved, ...item.unresolvedStationNames];
  };
  return <div className="lm-stack"><div className="lm-page-head"><div><span>Lifecycle Management <ArrowRight size={12} /> Automations</span><h2>Lifecycle Automations</h2><p>Send real-time updates to customers and admins based on captured station events.</p></div></div><section className="lm-card lm-automation-create"><label><span>Trigger Event *</span><select value={trigger} onChange={(event) => setTrigger(event.target.value)}><option>Vehicle reached station</option><option>Vehicle left station</option><option>Worker idle too long</option><option>Vehicle delayed</option><option>Vehicle exited end station</option></select></label><label><span>Recipients *</span><select value={audience} onChange={(event) => setAudience(event.target.value)}><option>Customer</option><option>Admin / Workshop Manager</option></select></label><label><span>Channel *</span><select value={channel} onChange={(event) => setChannel(event.target.value)}><option>WhatsApp</option><option>Email</option></select></label><button className="lm-primary" onClick={() => setAutomations((items) => [...items, { id: `automation-${Date.now()}`, name: `${trigger} Update`, audience, trigger, channels: [channel], processId: process.id, stationIds: [], unresolvedStationNames: [], shareImage: false, active: true }])} type="button"><Plus size={17} />Create Automation</button></section><div className="lm-automation-cards">{processAutomations.slice(0, 2).map((item, index) => <section className="lm-card" key={item.id}><header><div className={index ? 'orange' : 'green'}><Users size={20} /></div><span><h3>{item.name}</h3><p>{index ? 'Notify admins when a vehicle leaves a station or on stage completion.' : 'Notify customers when their vehicle reaches a station.'}</p></span><button className={`lm-toggle ${item.active ? 'on' : ''}`} onClick={() => update(item.id, { active: !item.active })} type="button"><i /></button><MoreHorizontal size={17} /></header><div className="lm-auto-grid"><label><span><Zap size={14} />Trigger Event</span><select value={item.trigger} onChange={(event) => update(item.id, { trigger: event.target.value })}><option>Vehicle reached station</option><option>Vehicle left station</option><option>Vehicle delayed</option><option>Vehicle exited end station</option></select></label><label><span><UserRound size={14} />Recipients</span><select value={item.audience} onChange={(event) => update(item.id, { audience: event.target.value })}><option>Customer</option><option>Admin / Workshop Manager</option></select></label><label><span><List size={14} />Stations / Events</span><div className="lm-tags">{(stationNames(item).length ? stationNames(item) : process.stages.slice(1, 5).map((stage) => stage.name)).map((name) => <i key={name}>{name}</i>)}</div></label><label><span>Channels</span><div className="lm-channel"><MessageCircle size={16} />WhatsApp<button className={`lm-toggle ${item.channels.includes('WhatsApp') ? 'on' : ''}`} onClick={() => update(item.id, { channels: item.channels.includes('WhatsApp') ? item.channels.filter((value) => value !== 'WhatsApp') : [...item.channels, 'WhatsApp'] })} type="button"><i /></button></div><div className="lm-channel"><Mail size={16} />Email<button className={`lm-toggle ${item.channels.includes('Email') ? 'on' : ''}`} onClick={() => update(item.id, { channels: item.channels.includes('Email') ? item.channels.filter((value) => value !== 'Email') : [...item.channels, 'Email'] })} type="button"><i /></button></div></label></div><label className="lm-share"><Image size={15} />Share station image<button className={`lm-toggle ${item.shareImage ? 'on' : ''}`} onClick={() => update(item.id, { shareImage: !item.shareImage })} type="button"><i /></button></label><div className="lm-message"><MessageCircle size={15} /><span><small>Message Preview</small><strong>{item.audience === 'Customer' ? 'Your vehicle MH12AB1234 has reached Inspection.' : 'Vehicle MH12AB1234 completed Inspection. Stage time: 48 min.'}</strong></span></div></section>)}</div><div className="lm-automation-bottom"><section className="lm-card lm-active-automations"><header><List size={18} /><div><h3>Active Automations</h3><p>Manage your configured automations for lifecycle notifications.</p></div></header><div className="lm-table-wrap"><table><thead><tr><th>Automation Name</th><th>Audience</th><th>Channels</th><th>Share Image</th><th>Status</th><th>Actions</th></tr></thead><tbody>{processAutomations.map((item) => <tr key={item.id}><td>{item.name}</td><td>{item.audience}</td><td>{item.channels.join(' · ')}</td><td>{item.shareImage ? 'Yes' : 'No'}</td><td><span className={`lm-status ${item.active ? 'green' : 'gray'}`}><i />{item.active ? 'Active' : 'Inactive'}</span></td><td><button type="button"><Pencil size={14} /></button><button type="button"><MoreHorizontal size={14} /></button></td></tr>)}</tbody></table></div></section><aside className="lm-card lm-triggers"><header><Settings2 size={18} /><div><h3>Available Triggers</h3><p>Events that can start an automation.</p></div></header>{['Vehicle Entered Start Station', 'Vehicle Reached Station', 'Worker Idle Too Long', 'Vehicle Delayed', 'Vehicle Exited End Station'].map((item) => <button type="button" key={item}><Zap size={14} />{item}<ArrowRight size={14} /></button>)}</aside></div></div>;
}

export function LifecycleAutomationSetup() {
  const lpr = useLpr();
  const process = lpr.processes.find((item) => item.id === lpr.selectedProcessId) ?? lpr.processes[0];
  const [automations, setAutomations] = useState<LifecycleAutomation[]>(() => loadLifecycleAutomations(lpr.processes));
  useEffect(() => { writeStoredJson(lifecycleAutomationKey, automations); }, [automations]);
  if (!process) return <div className="lm-empty">Configure a lifecycle process before creating lifecycle automations.</div>;
  const processAutomations = automations.filter((item) => item.processId === process.id);
  const update = (id: string, value: Partial<LifecycleAutomation>) => setAutomations((items) => items.map((item) => item.id === id ? { ...item, ...value } : item));
  const createAutomation = () => setAutomations((items) => [...items, {
    id: `automation-${Date.now()}`,
    name: 'New lifecycle update', audience: 'Customer', trigger: 'Vehicle reached station', channels: ['Email'],
    processId: process.id, stationIds: [], unresolvedStationNames: [], shareImage: false, active: true
  }]);
  const toggleStation = (automation: LifecycleAutomation, stationId: string) => update(automation.id, {
    stationIds: automation.stationIds.includes(stationId)
      ? automation.stationIds.filter((id) => id !== stationId)
      : [...automation.stationIds, stationId]
  });
  return <div className="lm-stack setup-lifecycle-step">
    <div className="lm-page-head"><div><span>Setup <ArrowRight size={12} /> Automations</span><h2>Lifecycle automations</h2><p>Configure notifications from the stations in {process.name}. General detection and business-rule automations remain separate.</p></div><button className="lm-primary" type="button" onClick={createAutomation}><Plus size={16} />Create automation</button></div>
    <section className="lm-card lifecycle-process-picker"><label><span>Lifecycle process</span><select value={process.id} onChange={(event) => lpr.setSelectedProcessId(event.target.value)}>{lpr.processes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><p>Station selections below are stored by stable station ID, so renaming a station will not disconnect an automation.</p></section>
    <div className="setup-automation-list">{processAutomations.map((item) => <section className="lm-card setup-automation-card" key={item.id}><header><div><Zap size={18} /></div><input aria-label="Automation name" value={item.name} onChange={(event) => update(item.id, { name: event.target.value })} /><button className={`lm-toggle ${item.active ? 'on' : ''}`} aria-label={`Toggle ${item.name}`} onClick={() => update(item.id, { active: !item.active })} type="button"><i /></button></header><div className="setup-automation-fields"><label><span>Trigger</span><select value={item.trigger} onChange={(event) => update(item.id, { trigger: event.target.value })}><option>Vehicle entered start station</option><option>Vehicle reached station</option><option>Vehicle left station</option><option>Worker idle too long</option><option>Vehicle delayed</option><option>Vehicle exited end station</option></select></label><label><span>Recipients</span><select value={item.audience} onChange={(event) => update(item.id, { audience: event.target.value })}><option>Customer</option><option>Admin / Workshop Manager</option></select></label><label><span>Channels</span><div className="automation-channel-options">{['Email', 'WhatsApp'].map((channel) => <button className={item.channels.includes(channel) ? 'selected' : ''} key={channel} onClick={() => update(item.id, { channels: item.channels.includes(channel) ? item.channels.filter((value) => value !== channel) : [...item.channels, channel] })} type="button">{channel}</button>)}</div></label></div><div className="automation-station-picker"><strong>Stations</strong><p>Select the configured stations that can trigger this automation.</p><div>{process.stages.map((stage) => <label className={item.stationIds.includes(stage.id) ? 'selected' : ''} key={stage.id}><input checked={item.stationIds.includes(stage.id)} onChange={() => toggleStation(item, stage.id)} type="checkbox" /><span>{stage.name}<small>{stage.type} · ID {stage.id}</small></span></label>)}</div>{item.unresolvedStationNames.length ? <aside className="automation-unresolved"><AlertTriangle size={15} /><span><strong>Legacy stations need review</strong><small>{item.unresolvedStationNames.join(' · ')}</small></span></aside> : null}</div><footer><label><input checked={item.shareImage} onChange={(event) => update(item.id, { shareImage: event.target.checked })} type="checkbox" /> Include station image</label><button className="lm-danger" type="button" onClick={() => setAutomations((items) => items.filter((automation) => automation.id !== item.id))}><Trash2 size={14} />Delete</button></footer></section>)}{!processAutomations.length ? <div className="panel setup-empty-state"><Zap size={25} /><strong>No lifecycle automations for this process</strong><p>Create one after your station mapping is ready.</p></div> : null}</div>
  </div>;
}

function LifecyclePlateStatus({ process }: { process: LprProcess }) {
  const lpr = useLpr();
  const candidates = lpr.plateCandidates.filter((candidate) => candidate.processId === process.id);
  if (!candidates.length) return null;
  return <section className="lm-card lm-plate-readings"><header><ScanLine size={18} /><div><h3>Live Plate Recognition</h3><p>The first valid entry-camera detection is cropped, recognized and stored. Later mapped-camera readings and the saved image keep the same vehicle linked.</p></div></header><div>{candidates.map((candidate) => { const stage = process.stages.find((item) => item.id === candidate.stageId); return <article key={candidate.key}>{candidate.plateImage ? <img className="lm-candidate-image" src={candidate.plateImage} alt={candidate.plate} /> : <span className="plate-badge">{candidate.plate}</span>}<span><strong>Captured and stored</strong><small>{stage?.name ?? 'Unmapped station'} · OCR {candidate.plate} · {candidate.observations} linked reading{candidate.observations === 1 ? '' : 's'}</small><i><b style={{ width: '100%' }} /></i></span></article>; })}</div></section>;
}

type LifecycleWorkspaceSection = 'tracking' | 'mapping' | 'automations';

export function LprTrackingPage({ initialSection = 'tracking' }: { initialSection?: LifecycleWorkspaceSection }) {
  const vision = useVision();
  const lpr = useLpr();
  void initialSection;
  const section: LifecycleWorkspaceSection = 'tracking';
  const [selectedJourneyId, setSelectedJourneyId] = useState('');
  const [showSummary, setShowSummary] = useState(false);
  const [previewImage, setPreviewImage] = useState<{ src: string; plate: string } | null>(null);
  useEffect(() => { writeStoredString(workspaceSectionStorageKey, section); }, [section]);
  useEffect(() => {
    if (!previewImage) return;
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPreviewImage(null);
    };
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [previewImage]);
  const process = lpr.processes.find((item) => item.id === lpr.selectedProcessId) ?? lpr.processes[0];
  const journey = lpr.journeys.find((item) => item.id === selectedJourneyId) ?? lpr.journeys.find((item) => item.processId === process?.id);
  if (!process) return <div className="lm-empty">No lifecycle process is configured.</div>;
  const entryStage = process.stages.find((stage) => stage.type === 'entry');
  const entryCamera = vision.cameras.find((camera) => camera.id === entryStage?.cameraId);
  const lprModel = vision.models.find((model) => model.id === 'indian_lpr');
  const lifecycleBlocker = vision.workerStatus !== 'online'
    ? 'The AI worker is offline.'
    : !lprModel?.installed
      ? 'Indian LPR is not installed in this worker. The external checkout and both LPR weights are required for OCR.'
      : !entryStage?.cameraId
        ? 'No camera is mapped to the start station.'
        : !entryCamera
          ? 'The start-station camera no longer exists.'
          : entryCamera.sourceStatus !== 'ready'
            ? `${entryCamera.name} has no connected feed.`
            : !entryCamera.configuration.selectedModelIds.includes('indian_lpr')
              ? `${entryCamera.name} is not configured to use Indian LPR.`
              : !vision.running[entryCamera.id]
                ? `${entryCamera.name} is mapped but its engine is paused.`
                : '';
  const openSummary = (item: LprJourney) => { setSelectedJourneyId(item.id); setShowSummary(true); };
  return <div className="lifecycle-module" onClick={(event) => { const target = event.target; if (target instanceof HTMLImageElement && (target.classList.contains('lm-candidate-image') || target.classList.contains('lm-journey-plate-image'))) setPreviewImage({ src: target.src, plate: target.alt }); }}>
    <div className="lifecycle-operation-context"><Route size={17} /><span><strong>Operational tracking</strong><small>Station mapping and notification setup are managed in Setup.</small></span></div>
    {lifecycleBlocker ? <div className="inline-status info"><AlertTriangle size={16} /><span><strong>Lifecycle capture is not ready</strong><small>{lifecycleBlocker} A journey is registered only after the mapped entry camera returns valid OCR text containing 6–12 characters, at least two letters, and at least two digits.</small></span></div> : null}
    {section === 'tracking' ? <><LifecyclePlateStatus process={process} />{showSummary ? <LifecycleSummary process={process} journey={journey} back={() => setShowSummary(false)} /> : <LifecycleTracking process={process} openSummary={openSummary} />}</> : null}
    {previewImage ? <div className="plate-preview-backdrop" role="presentation" onClick={() => setPreviewImage(null)}><section aria-label={`Plate preview ${previewImage.plate}`} aria-modal="true" className="plate-preview-modal" role="dialog" onClick={(event) => event.stopPropagation()}><header><span><small>NUMBER PLATE PREVIEW</small><strong>{previewImage.plate}</strong></span><button aria-label="Close plate preview" autoFocus onClick={() => setPreviewImage(null)} title="Close preview" type="button"><X size={22} /></button></header><div className="plate-preview-image-stage"><img alt={`Detected number plate ${previewImage.plate}`} src={previewImage.src} /></div><footer><span>Detected vehicle number</span><strong>{previewImage.plate}</strong><small>Click outside, press Escape, or use the close button to return.</small></footer></section></div> : null}
  </div>;
}
