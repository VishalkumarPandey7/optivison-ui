import Hls from 'hls.js';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react';

export const workerUrl = 'http://127.0.0.1:8770';

export type SourceType = 'browser' | 'uploaded' | 'usb' | 'http' | 'rtsp' | 'onvif' | 'nvr';
export type SourceStatus = 'empty' | 'starting' | 'ready' | 'error';
export type SignalKind =
  | 'object_detected'
  | 'object_in_roi'
  | 'object_absent_from_roi'
  | 'object_count'
  | 'object_entered_roi'
  | 'line_crossing_count'
  | 'objects_near'
  | 'pose_moving'
  | 'zone_motion'
  | 'zone_idle'
  | 'line_crossing_rate'
  | 'roi_color_match'
  | 'object_orientation_match'
  | 'object_size_check';
export type RuleOperator = 'IS_ACTIVE' | 'IS_NOT_ACTIVE' | 'GREATER_THAN' | 'LESS_THAN' | 'EQUALS' | 'STATE_CHANGE';

export interface ModelInfo {
  id: string;
  name: string;
  task: 'detect' | 'pose';
  classes: string[];
  installed: boolean;
  downloadable: boolean;
}

export interface Zone {
  id: string;
  name: string;
  kind: 'operator' | 'machine' | 'restricted' | 'counting' | 'number_plate' | 'custom';
  x: number;
  y: number;
  width: number;
  height: number;
  coordinateSpace: 'percent';
  color: string;
}

export interface CountingLine {
  id: string;
  name: string;
  zoneId: string;
  start: { x: number; y: number };
  end: { x: number; y: number };
  coordinateSpace: 'percent';
}

export interface SignalDefinition {
  id: string;
  name: string;
  kind: SignalKind;
  className: string;
  secondaryClass?: string;
  sourceTask: 'detect' | 'pose';
  confidence: number;
  zoneId?: string;
  lineId?: string;
  motionThreshold?: number;
  countThreshold?: number;
  maxDistancePercent?: number;
  holdSeconds?: number;
  targetColor?: string;
  colorTolerance?: number;
  expectedOrientation?: 'portrait' | 'landscape' | 'square';
  minAreaPercent?: number;
  maxAreaPercent?: number;
  controlledCondition?: boolean;
  capabilityNote?: string;
}

export interface RuleCondition {
  id: string;
  signalId: string;
  operator: RuleOperator;
  value?: number;
}

export interface RuleDefinition {
  id: string;
  name: string;
  output: string;
  combinator: 'AND' | 'OR' | 'SEQUENCE';
  forSeconds: number;
  withinSeconds?: number;
  conditions: RuleCondition[];
}

export type BusinessMetricKey =
  | 'active_seconds'
  | 'presence_seconds'
  | 'running_seconds'
  | 'observed_seconds'
  | 'output_count'
  | 'idle_seconds'
  | 'absent_seconds';

export interface BusinessRuleDefinition {
  id: string;
  name: string;
  numerator: BusinessMetricKey;
  denominator?: BusinessMetricKey;
  operation: 'VALUE' | 'DIVIDE_PERCENT';
  unit: 'percent' | 'duration' | 'count';
}

export interface DisplayConfiguration {
  boundingBoxes: boolean;
  trackIds: boolean;
  labels: boolean;
  confidence: boolean;
  trackingTrails: boolean;
  zoneOverlays: boolean;
  heatmap: boolean;
  detectionColor: string;
  boxThickness: number;
}

export interface Detection {
  id: string;
  trackId: string | number;
  trackConfirmed: boolean;
  className: string;
  plateText?: string;
  plateImage?: string;
  plateFingerprint?: string;
  confidence: number;
  box: [number, number, number, number];
  modelId: string;
  task: 'detect' | 'pose';
  zoneIds: string[];
}

export interface SignalState {
  signalId: string;
  name: string;
  kind: SignalKind;
  active: boolean;
  stateChanged: boolean;
  value: boolean | number;
  confidence: number;
  evidence: {
    summary?: string;
    trackIds?: string[];
    count?: number;
    inboundCount?: number;
    outboundCount?: number;
    totalCount?: number;
    ratePerMinute?: number;
    lastDirection?: 'inbound' | 'outbound';
    foregroundPercent?: number;
    liveTracks?: Array<{ trackId: string | number; counted: boolean }>;
    crossings?: CrossingEvent[];
    motionMask?: string;
    [key: string]: unknown;
  };
}

export interface RuleState {
  ruleId: string;
  name: string;
  output: string;
  active: boolean;
  matched: boolean;
  elapsedSeconds: number;
  forSeconds: number;
}

export interface CrossingEvent {
  id: string;
  timestamp: number;
  direction: 'inbound' | 'outbound';
  trackId: string | number;
  passNumber: number;
}

export interface AnalysisFrame {
  ok: boolean;
  frame: number;
  timestamp: number;
  width: number;
  height: number;
  pipeline: Record<string, string>;
  detections: Detection[];
  signals: SignalState[];
  rules: RuleState[];
  outputs: string[];
  modelErrors: Array<{ modelId: string; error: string }>;
  error?: string;
}

export interface CameraConfiguration {
  selectedModelIds: string[];
  confidence: number;
  zones: Zone[];
  countingLines: CountingLine[];
  signals: SignalDefinition[];
  rules: RuleDefinition[];
  businessRules: BusinessRuleDefinition[];
  display: DisplayConfiguration;
  analysisRoiIds: string[];
  minimumRoiOverlap: number;
  useCase: 'worker' | 'machine' | 'conveyor' | 'quality' | 'safety' | 'lpr';
}

export interface CameraRecord {
  id: string;
  name: string;
  location: string;
  department: string;
  productionLine: string;
  sourceType: SourceType;
  sourceStatus: SourceStatus;
  sourceUrl: string;
  sourceLabel: string;
  error: string;
  configuration: CameraConfiguration;
}

export interface RuntimeEvent {
  id: string;
  cameraId: string;
  timestamp: number;
  type: 'detection' | 'signal' | 'rule' | 'count' | 'error';
  title: string;
  detail: string;
}

export interface SessionMetrics {
  activeSeconds: number;
  idleSeconds: number;
  absentSeconds: number;
  uptimeSeconds: number;
  downtimeSeconds: number;
  lastTimestamp: number | null;
}

type Update<T> = T | ((current: T) => T);

interface VisionContextValue {
  workerStatus: 'checking' | 'online' | 'offline';
  workerDetail: string;
  models: ModelInfo[];
  cameras: CameraRecord[];
  activeCameraId: string;
  frames: Record<string, AnalysisFrame>;
  running: Record<string, boolean>;
  events: RuntimeEvent[];
  metrics: Record<string, SessionMetrics>;
  setActiveCameraId: (cameraId: string) => void;
  getCamera: (cameraId?: string) => CameraRecord;
  updateCamera: (cameraId: string, update: Partial<CameraRecord>) => void;
  updateConfiguration: (cameraId: string, update: Update<CameraConfiguration>) => void;
  addCamera: () => string | null;
  removeCamera: (cameraId: string) => void;
  setVideoElement: (cameraId: string, node: HTMLVideoElement | null) => void;
  connectBrowserCamera: (cameraId: string, deviceId?: string) => Promise<void>;
  connectUploadedVideo: (cameraId: string, file: File) => Promise<void>;
  connectExternalVideo: (cameraId: string, url: string, sourceType: SourceType) => Promise<void>;
  disconnectCamera: (cameraId: string) => void;
  toggleEngine: (cameraId: string) => Promise<void>;
  resetCamera: (cameraId: string) => Promise<void>;
  refreshModels: () => Promise<void>;
}

const defaultZones = (): Zone[] => [
  { id: 'operator-zone', name: 'Worker Zone', kind: 'operator', x: 0, y: 0, width: 0, height: 0, coordinateSpace: 'percent', color: '#ff6b00' },
  { id: 'machine-zone', name: 'Machine Zone', kind: 'machine', x: 0, y: 0, width: 0, height: 0, coordinateSpace: 'percent', color: '#7c3aed' },
  { id: 'restricted-zone', name: 'Restricted Zone', kind: 'restricted', x: 0, y: 0, width: 0, height: 0, coordinateSpace: 'percent', color: '#dc3c42' },
  { id: 'counting-zone', name: 'Counting Zone', kind: 'counting', x: 0, y: 0, width: 0, height: 0, coordinateSpace: 'percent', color: '#1d9bf0' },
  { id: 'number-plate-zone', name: 'Number Plate Zone', kind: 'number_plate', x: 0, y: 0, width: 0, height: 0, coordinateSpace: 'percent', color: '#eab308' }
];

const defaultSignals = (): SignalDefinition[] => [
  { id: 'person-in-operator-zone', name: 'Worker Present', kind: 'object_in_roi', className: 'person', sourceTask: 'detect', confidence: 0.35, zoneId: 'operator-zone', holdSeconds: 0.6 },
  { id: 'body-moving', name: 'Worker Moving', kind: 'pose_moving', className: 'person', sourceTask: 'pose', confidence: 0.3, zoneId: 'operator-zone', motionThreshold: 0.18, holdSeconds: 0.8 },
  { id: 'operator-absent', name: 'Worker Absent', kind: 'object_absent_from_roi', className: 'person', sourceTask: 'detect', confidence: 0.35, zoneId: 'operator-zone' },
  { id: 'machine-idle', name: 'Machine Stationary', kind: 'zone_idle', className: 'machine', sourceTask: 'detect', confidence: 0.35, zoneId: 'machine-zone', motionThreshold: 2 },
  { id: 'phone-near-person', name: 'Phone Near Worker', kind: 'objects_near', className: 'person', secondaryClass: 'cell phone', sourceTask: 'detect', confidence: 0.25, zoneId: 'restricted-zone', maxDistancePercent: 18, holdSeconds: 0.6 },
  { id: 'objects-in-counting-zone', name: 'Objects In Counting Zone', kind: 'object_count', className: 'person', sourceTask: 'detect', confidence: 0.35, zoneId: 'counting-zone', countThreshold: 1 },
  { id: 'conveyor-line-crossing-count', name: 'Direct Motion Passes', kind: 'line_crossing_count', className: 'object', sourceTask: 'detect', confidence: 0.2, zoneId: 'counting-zone', lineId: 'conveyor-line' }
];

const defaultRules = (): RuleDefinition[] => [
  { id: 'worker-working', name: 'Worker Working', output: 'WORKER_WORKING', combinator: 'AND', forSeconds: 2, conditions: [{ id: 'worker-present', signalId: 'person-in-operator-zone', operator: 'IS_ACTIVE' }, { id: 'worker-moving', signalId: 'body-moving', operator: 'IS_ACTIVE' }] },
  { id: 'worker-idle', name: 'Worker Idle', output: 'WORKER_IDLE', combinator: 'AND', forSeconds: 60, conditions: [{ id: 'present-idle', signalId: 'person-in-operator-zone', operator: 'IS_ACTIVE' }, { id: 'not-moving', signalId: 'body-moving', operator: 'IS_NOT_ACTIVE' }] },
  { id: 'operator-absent-rule', name: 'Operator Absent', output: 'OPERATOR_ABSENT', combinator: 'AND', forSeconds: 3, conditions: [{ id: 'absent-condition', signalId: 'operator-absent', operator: 'IS_ACTIVE' }] },
  { id: 'machine-idle-worker-absent', name: 'Machine Idle Without Operator', output: 'MACHINE_IDLE_OPERATOR_ABSENT', combinator: 'AND', forSeconds: 5, conditions: [{ id: 'machine-idle-condition', signalId: 'machine-idle', operator: 'IS_ACTIVE' }, { id: 'machine-absent-condition', signalId: 'operator-absent', operator: 'IS_ACTIVE' }] },
  { id: 'restricted-mobile-use', name: 'Restricted Mobile Use', output: 'RESTRICTED_MOBILE_USE', combinator: 'AND', forSeconds: 1, conditions: [{ id: 'mobile-condition', signalId: 'phone-near-person', operator: 'IS_ACTIVE' }] },
  { id: 'count-target', name: 'Counting Target Reached', output: 'COUNT_TARGET_REACHED', combinator: 'AND', forSeconds: 0, conditions: [{ id: 'count-condition', signalId: 'conveyor-line-crossing-count', operator: 'GREATER_THAN', value: 9 }] }
];

const defaultBusinessRules = (): BusinessRuleDefinition[] => [
  { id: 'worker-productivity', name: 'Worker Productivity', numerator: 'active_seconds', denominator: 'presence_seconds', operation: 'DIVIDE_PERCENT', unit: 'percent' },
  { id: 'machine-utilization', name: 'Machine Utilization', numerator: 'running_seconds', denominator: 'observed_seconds', operation: 'DIVIDE_PERCENT', unit: 'percent' },
  { id: 'working-time', name: 'Working Time', numerator: 'active_seconds', operation: 'VALUE', unit: 'duration' },
  { id: 'output-count', name: 'Output Count', numerator: 'output_count', operation: 'VALUE', unit: 'count' }
];

const defaultDisplay = (): DisplayConfiguration => ({
  boundingBoxes: true,
  trackIds: true,
  labels: true,
  confidence: true,
  trackingTrails: false,
  zoneOverlays: true,
  heatmap: false,
  detectionColor: '#ff6b00',
  boxThickness: 3
});

const defaultConfiguration = (useCase: CameraConfiguration['useCase'] = 'worker'): CameraConfiguration => ({
  selectedModelIds: useCase === 'conveyor' ? [] : ['yolo11n', 'yolo11n_pose'],
  confidence: 0.35,
  zones: defaultZones(),
  countingLines: [{ id: 'conveyor-line', name: 'Conveyor Counting Line', zoneId: 'counting-zone', start: { x: 0, y: 0 }, end: { x: 0, y: 0 }, coordinateSpace: 'percent' }],
  signals: defaultSignals(),
  rules: defaultRules(),
  businessRules: defaultBusinessRules(),
  display: defaultDisplay(),
  analysisRoiIds: [],
  minimumRoiOverlap: 0.5,
  useCase
});

function defaultCamera(index: number, useCase: CameraConfiguration['useCase'] = 'worker'): CameraRecord {
  const names = ['Assembly Line 01', 'Packaging Line 02', 'Machine Cell 03'];
  const departments = ['Assembly', 'Packaging', 'Machining'];
  return {
    id: `camera-${index}`,
    name: names[index - 1] ?? `Camera ${index}`,
    location: index === 3 ? 'Plant B' : 'Plant A',
    department: departments[index - 1] ?? 'Operations',
    productionLine: `Line ${String(index).padStart(2, '0')}`,
    sourceType: 'browser',
    sourceStatus: 'empty',
    sourceUrl: '',
    sourceLabel: '',
    error: '',
    configuration: defaultConfiguration(useCase)
  };
}

const storageKey = 'optivision-approved-ui-engine-v1';
const emptyMetrics: SessionMetrics = { activeSeconds: 0, idleSeconds: 0, absentSeconds: 0, uptimeSeconds: 0, downtimeSeconds: 0, lastTimestamp: null };

function loadCameras(): CameraRecord[] {
  try {
    const stored = window.localStorage.getItem(storageKey);
    if (!stored) return [defaultCamera(1, 'worker'), defaultCamera(2, 'worker'), defaultCamera(3, 'conveyor')];
    const parsed = JSON.parse(stored) as CameraRecord[];
    return parsed.map((camera) => {
      const defaults = defaultConfiguration(camera.configuration?.useCase ?? 'worker');
      const savedZones = camera.configuration?.zones ?? [];
      const zones = [...savedZones, ...defaults.zones.filter((zone) => !savedZones.some((saved) => saved.id === zone.id))];
      return {
        ...camera,
        sourceStatus: 'empty' as const,
        sourceUrl: '',
        error: '',
        configuration: {
          ...defaults,
          ...camera.configuration,
          zones,
          businessRules: camera.configuration?.businessRules ?? defaultBusinessRules(),
          display: { ...defaultDisplay(), ...(camera.configuration?.display ?? {}) }
        }
      };
    });
  } catch {
    return [defaultCamera(1, 'worker'), defaultCamera(2, 'worker'), defaultCamera(3, 'conveyor')];
  }
}

function requiredClasses(signals: SignalDefinition[]) {
  const noClass = new Set<SignalKind>(['zone_motion', 'zone_idle', 'roi_color_match', 'line_crossing_count', 'line_crossing_rate']);
  const classes = new Set<string>();
  signals.forEach((signal) => {
    if (noClass.has(signal.kind)) return;
    if (signal.className.trim()) classes.add(signal.className.trim().toLowerCase());
    if (signal.kind === 'objects_near' && signal.secondaryClass?.trim()) classes.add(signal.secondaryClass.trim().toLowerCase());
  });
  return [...classes];
}

function isZoneDrawn(zone: Zone) {
  return zone.width > 0.5 && zone.height > 0.5;
}

function lineIsDrawn(line: CountingLine) {
  return Math.abs(line.start.x - line.end.x) + Math.abs(line.start.y - line.end.y) > 0.5;
}

function plateVisualEvidence(source: HTMLCanvasElement, box: [number, number, number, number]) {
  const [rawLeft, rawTop, rawRight, rawBottom] = box;
  const left = Math.max(0, Math.floor(rawLeft));
  const top = Math.max(0, Math.floor(rawTop));
  const width = Math.max(1, Math.min(source.width - left, Math.ceil(rawRight - rawLeft)));
  const height = Math.max(1, Math.min(source.height - top, Math.ceil(rawBottom - rawTop)));
  const hashCanvas = document.createElement('canvas');
  hashCanvas.width = 9; hashCanvas.height = 8;
  const hashContext = hashCanvas.getContext('2d', { willReadFrequently: true });
  const imageCanvas = document.createElement('canvas');
  imageCanvas.width = 188; imageCanvas.height = 48;
  const imageContext = imageCanvas.getContext('2d');
  if (!hashContext || !imageContext) return {};
  hashContext.drawImage(source, left, top, width, height, 0, 0, 9, 8);
  imageContext.drawImage(source, left, top, width, height, 0, 0, 188, 48);
  const pixels = hashContext.getImageData(0, 0, 9, 8).data;
  let bits = '';
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const offset = (y * 9 + x) * 4;
    const next = offset + 4;
    const grey = pixels[offset] * .299 + pixels[offset + 1] * .587 + pixels[offset + 2] * .114;
    const nextGrey = pixels[next] * .299 + pixels[next + 1] * .587 + pixels[next + 2] * .114;
    bits += grey > nextGrey ? '1' : '0';
  }
  let fingerprint = '';
  for (let index = 0; index < bits.length; index += 4) fingerprint += Number.parseInt(bits.slice(index, index + 4), 2).toString(16);
  return { plateFingerprint: fingerprint, plateImage: imageCanvas.toDataURL('image/jpeg', .72) };
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${workerUrl}${path}`, init);
  const payload = await response.json() as T & { ok?: boolean; error?: string };
  if (!response.ok || payload.ok === false) throw new Error(payload.error || `Worker returned ${response.status}`);
  return payload;
}

const VisionContext = createContext<VisionContextValue | null>(null);

export function VisionProvider({ children }: { children: ReactNode }) {
  const [workerStatus, setWorkerStatus] = useState<'checking' | 'online' | 'offline'>('checking');
  const [workerDetail, setWorkerDetail] = useState('Checking Ultralytics + Supervision worker');
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [cameras, setCameras] = useState<CameraRecord[]>(loadCameras);
  const [activeCameraId, setActiveCameraId] = useState('camera-1');
  const [frames, setFrames] = useState<Record<string, AnalysisFrame>>({});
  const [running, setRunning] = useState<Record<string, boolean>>({});
  const [events, setEvents] = useState<RuntimeEvent[]>([]);
  const [metrics, setMetrics] = useState<Record<string, SessionMetrics>>({});
  const cameraRef = useRef(cameras);
  const videoRefs = useRef<Record<string, HTMLVideoElement | null>>({});
  const streamRefs = useRef<Record<string, MediaStream | null>>({});
  const uploadUrlRefs = useRef<Record<string, string>>({});
  const hlsRefs = useRef<Record<string, Hls | null>>({});
  const canvasRefs = useRef<Record<string, HTMLCanvasElement>>({});
  const playbackTimes = useRef<Record<string, number>>({});
  const frameNumbers = useRef<Record<string, number>>({});
  const analyzing = useRef<Record<string, boolean>>({});
  const lastOutputs = useRef<Record<string, string[]>>({});

  useEffect(() => { cameraRef.current = cameras; }, [cameras]);
  useEffect(() => {
    const persistable = cameras.map((camera) => ({ ...camera, sourceStatus: 'empty', sourceUrl: '', sourceLabel: '', error: '' }));
    window.localStorage.setItem(storageKey, JSON.stringify(persistable));
  }, [cameras]);

  const refreshModels = useCallback(async () => {
    try {
      const health = await requestJson<{ ok: boolean; engine: string; models: ModelInfo[]; versions?: Record<string, string> }>('/health');
      setWorkerStatus('online');
      setModels(health.models ?? []);
      setWorkerDetail(`${health.engine}${health.versions?.supervision ? ` · Supervision ${health.versions.supervision}` : ''}`);
    } catch (error) {
      setWorkerStatus('offline');
      setWorkerDetail(error instanceof Error ? error.message : 'Signal worker offline');
    }
  }, []);

  useEffect(() => {
    void refreshModels();
    const timer = window.setInterval(() => void refreshModels(), 10000);
    return () => window.clearInterval(timer);
  }, [refreshModels]);

  const updateCamera = useCallback((cameraId: string, update: Partial<CameraRecord>) => {
    setCameras((current) => current.map((camera) => camera.id === cameraId ? { ...camera, ...update } : camera));
  }, []);

  const updateConfiguration = useCallback((cameraId: string, update: Update<CameraConfiguration>) => {
    setCameras((current) => current.map((camera) => camera.id !== cameraId ? camera : {
      ...camera,
      configuration: typeof update === 'function' ? update(camera.configuration) : update
    }));
  }, []);

  const stopSource = useCallback((cameraId: string) => {
    streamRefs.current[cameraId]?.getTracks().forEach((track) => track.stop());
    streamRefs.current[cameraId] = null;
    hlsRefs.current[cameraId]?.destroy();
    hlsRefs.current[cameraId] = null;
    if (uploadUrlRefs.current[cameraId]) URL.revokeObjectURL(uploadUrlRefs.current[cameraId]);
    uploadUrlRefs.current[cameraId] = '';
    playbackTimes.current[cameraId] = 0;
    const video = videoRefs.current[cameraId];
    if (video) {
      video.pause();
      video.srcObject = null;
      video.removeAttribute('src');
      video.load();
    }
  }, []);

  const attachSource = useCallback((camera: CameraRecord, node: HTMLVideoElement) => {
    const stream = streamRefs.current[camera.id];
    if (stream) {
      if (node.srcObject !== stream) node.srcObject = stream;
      void node.play().catch(() => undefined);
      return;
    }
    if (!camera.sourceUrl) return;
    if (camera.sourceUrl.toLowerCase().includes('.m3u8') && Hls.isSupported()) {
      if (hlsRefs.current[camera.id]) return;
      hlsRefs.current[camera.id]?.destroy();
      const hls = new Hls({ lowLatencyMode: true });
      hlsRefs.current[camera.id] = hls;
      hls.loadSource(camera.sourceUrl);
      hls.attachMedia(node);
      hls.on(Hls.Events.MANIFEST_PARSED, () => void node.play().catch(() => undefined));
    } else {
      if (node.src !== camera.sourceUrl) node.src = camera.sourceUrl;
      void node.play().catch(() => undefined);
    }
  }, []);

  const setVideoElement = useCallback((cameraId: string, node: HTMLVideoElement | null) => {
    if (videoRefs.current[cameraId] === node) return;
    const previousNode = videoRefs.current[cameraId];
    if (previousNode && Number.isFinite(previousNode.currentTime) && previousNode.currentTime > 0) playbackTimes.current[cameraId] = previousNode.currentTime;
    videoRefs.current[cameraId] = node;
    if (!node) return;
    const camera = cameraRef.current.find((item) => item.id === cameraId);
    if (camera) {
      attachSource(camera, node);
      const resumeAt = playbackTimes.current[cameraId] ?? 0;
      if (camera.sourceType === 'uploaded' && resumeAt > 0) {
        const restore = () => {
          if (Number.isFinite(node.duration) && resumeAt < node.duration - 0.25) node.currentTime = resumeAt;
        };
        if (node.readyState >= 1) restore(); else node.addEventListener('loadedmetadata', restore, { once: true });
      }
      node.addEventListener('timeupdate', () => { playbackTimes.current[cameraId] = node.currentTime; });
    }
  }, [attachSource]);

  const connectBrowserCamera = useCallback(async (cameraId: string, deviceId?: string) => {
    stopSource(cameraId);
    updateCamera(cameraId, { sourceType: deviceId ? 'usb' : 'browser', sourceStatus: 'starting', error: '' });
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera access is not available in this browser.');
      const stream = await navigator.mediaDevices.getUserMedia({ video: deviceId ? { deviceId: { exact: deviceId } } : true, audio: false });
      streamRefs.current[cameraId] = stream;
      const node = videoRefs.current[cameraId];
      if (node) { node.srcObject = stream; await node.play(); }
      const label = stream.getVideoTracks()[0]?.label || (deviceId ? 'USB Camera' : 'Browser Camera');
      updateCamera(cameraId, { sourceStatus: 'ready', sourceLabel: label, sourceUrl: '', error: '' });
    } catch (error) {
      updateCamera(cameraId, { sourceStatus: 'error', error: error instanceof Error ? error.message : 'Camera connection failed.' });
      throw error;
    }
  }, [stopSource, updateCamera]);

  const connectUploadedVideo = useCallback(async (cameraId: string, file: File) => {
    stopSource(cameraId);
    playbackTimes.current[cameraId] = 0;
    const url = URL.createObjectURL(file);
    uploadUrlRefs.current[cameraId] = url;
    updateCamera(cameraId, { sourceType: 'uploaded', sourceStatus: 'ready', sourceUrl: url, sourceLabel: file.name, error: '' });
    const node = videoRefs.current[cameraId];
    if (node) { node.src = url; node.loop = true; await node.play().catch(() => undefined); }
  }, [stopSource, updateCamera]);

  const connectExternalVideo = useCallback(async (cameraId: string, url: string, sourceType: SourceType) => {
    if (!url.trim()) throw new Error('Enter a browser-playable stream URL.');
    if (url.trim().toLowerCase().startsWith('rtsp://')) throw new Error('Browsers cannot play raw RTSP. Enter an HLS, WebRTC, or HTTP bridge URL from the camera gateway or NVR.');
    stopSource(cameraId);
    const sourceUrl = url.trim();
    updateCamera(cameraId, { sourceType, sourceStatus: 'ready', sourceUrl, sourceLabel: `${sourceType.toUpperCase()} stream`, error: '' });
    const node = videoRefs.current[cameraId];
    const camera = cameraRef.current.find((item) => item.id === cameraId);
    if (node && camera) attachSource({ ...camera, sourceType, sourceStatus: 'ready', sourceUrl }, node);
  }, [attachSource, stopSource, updateCamera]);

  const disconnectCamera = useCallback((cameraId: string) => {
    stopSource(cameraId);
    setRunning((current) => ({ ...current, [cameraId]: false }));
    setFrames((current) => { const next = { ...current }; delete next[cameraId]; return next; });
    updateCamera(cameraId, { sourceStatus: 'empty', sourceUrl: '', sourceLabel: '', error: '' });
  }, [stopSource, updateCamera]);

  const toggleEngine = useCallback(async (cameraId: string) => {
    const camera = cameraRef.current.find((item) => item.id === cameraId);
    if (!camera) return;
    if (running[cameraId]) {
      setRunning((current) => ({ ...current, [cameraId]: false }));
      return;
    }
    if (workerStatus !== 'online') throw new Error('Signal worker is offline.');
    if (camera.sourceStatus !== 'ready') throw new Error('Connect the camera or video first.');
    const drawnZones = camera.configuration.zones.filter(isZoneDrawn);
    if (!drawnZones.length) throw new Error('Draw and activate at least one ROI before starting this camera.');
    setRunning((current) => ({ ...current, [cameraId]: true }));
  }, [running, workerStatus]);

  const resetCamera = useCallback(async (cameraId: string) => {
    await requestJson('/reset', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cameraId }) });
    setFrames((current) => { const next = { ...current }; delete next[cameraId]; return next; });
    setEvents((current) => current.filter((event) => event.cameraId !== cameraId));
    setMetrics((current) => ({ ...current, [cameraId]: { ...emptyMetrics } }));
    lastOutputs.current[cameraId] = [];
  }, []);

  const addCamera = useCallback(() => {
    if (cameraRef.current.length >= 7) return null;
    const used = new Set(cameraRef.current.map((camera) => camera.id));
    const index = Array.from({ length: 7 }, (_, item) => item + 1).find((item) => !used.has(`camera-${item}`));
    if (!index) return null;
    const next = defaultCamera(index);
    setCameras((current) => [...current, next].sort((left, right) => left.id.localeCompare(right.id)));
    setActiveCameraId(next.id);
    return next.id;
  }, []);

  const removeCamera = useCallback((cameraId: string) => {
    if (cameraRef.current.length <= 1) return;
    stopSource(cameraId);
    setCameras((current) => current.filter((camera) => camera.id !== cameraId));
    setRunning((current) => { const next = { ...current }; delete next[cameraId]; return next; });
    setFrames((current) => { const next = { ...current }; delete next[cameraId]; return next; });
    setActiveCameraId((current) => current === cameraId ? cameraRef.current.find((camera) => camera.id !== cameraId)?.id ?? 'camera-1' : current);
  }, [stopSource]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      cameraRef.current.filter((camera) => running[camera.id]).forEach((camera) => {
        if (analyzing.current[camera.id]) return;
        const video = videoRefs.current[camera.id];
        if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;
        analyzing.current[camera.id] = true;
        void (async () => {
          try {
            const maxWidth = 960;
            const scale = Math.min(1, maxWidth / video.videoWidth);
            const canvas = canvasRefs.current[camera.id] ?? document.createElement('canvas');
            canvasRefs.current[camera.id] = canvas;
            canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
            canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
            const context = canvas.getContext('2d');
            if (!context) return;
            context.drawImage(video, 0, 0, canvas.width, canvas.height);
            const config = camera.configuration;
            const drawnZones = config.zones.filter(isZoneDrawn);
            const drawnIds = new Set(drawnZones.map((zone) => zone.id));
            const signals = config.signals.map((signal) => ({ ...signal, analysisEnabled: !signal.zoneId || drawnIds.has(signal.zoneId) }));
            const enabledSignalIds = new Set(signals.filter((signal) => signal.analysisEnabled).map((signal) => signal.id));
            const rules = config.rules.map((rule) => ({ ...rule, analysisEnabled: rule.conditions.every((condition) => enabledSignalIds.has(condition.signalId)) }));
            const response = await requestJson<AnalysisFrame>('/analyze', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                cameraId: camera.id,
                cameraName: camera.name,
                frame: frameNumbers.current[camera.id] = (frameNumbers.current[camera.id] ?? 0) + 1,
                timestamp: Date.now() / 1000,
                image: canvas.toDataURL('image/jpeg', 0.78),
                confidence: config.confidence,
                modelIds: config.selectedModelIds,
                classNames: requiredClasses(config.signals),
                zones: drawnZones.map(({ color: _color, ...zone }) => zone),
                countingLines: config.countingLines.filter(lineIsDrawn),
                analysisRoiIds: config.analysisRoiIds.filter((id) => drawnIds.has(id)),
                minimumRoiOverlap: config.minimumRoiOverlap,
                signalDefinitions: signals,
                rules
              })
            });
            response.detections = response.detections.map((detection) => detection.className === 'license_plate'
              ? { ...detection, ...plateVisualEvidence(canvas, detection.box) }
              : detection);
            setFrames((current) => ({ ...current, [camera.id]: response }));
            const previous = new Set(lastOutputs.current[camera.id] ?? []);
            const freshOutputs = response.outputs.filter((output) => !previous.has(output));
            if (freshOutputs.length) setEvents((current) => [...freshOutputs.map((output) => ({ id: `${camera.id}-${output}-${response.timestamp}`, cameraId: camera.id, timestamp: response.timestamp, type: 'rule' as const, title: output.replaceAll('_', ' '), detail: `${camera.name} rule output` })), ...current].slice(0, 500));
            const changedSignals = response.signals.filter((signal) => signal.stateChanged);
            if (changedSignals.length) setEvents((current) => [...changedSignals.map((signal) => ({ id: `${camera.id}-${signal.signalId}-${response.timestamp}`, cameraId: camera.id, timestamp: response.timestamp, type: signal.kind === 'line_crossing_count' ? 'count' as const : 'signal' as const, title: signal.name, detail: signal.active ? 'Became active' : 'Became inactive' })), ...current].slice(0, 500));
            lastOutputs.current[camera.id] = response.outputs;
            setMetrics((current) => {
              const previousMetrics = current[camera.id] ?? emptyMetrics;
              const delta = previousMetrics.lastTimestamp ? Math.min(2, Math.max(0, response.timestamp - previousMetrics.lastTimestamp)) : 0;
              const workerActive = response.rules.some((rule) => rule.output === 'WORKER_WORKING' && rule.active);
              const workerIdle = response.rules.some((rule) => rule.output === 'WORKER_IDLE' && rule.active);
              const absent = response.signals.some((signal) => signal.signalId === 'operator-absent' && signal.active);
              const machineIdle = response.signals.some((signal) => signal.signalId === 'machine-idle' && signal.active);
              return { ...current, [camera.id]: {
                activeSeconds: previousMetrics.activeSeconds + (workerActive ? delta : 0),
                idleSeconds: previousMetrics.idleSeconds + (workerIdle ? delta : 0),
                absentSeconds: previousMetrics.absentSeconds + (absent ? delta : 0),
                uptimeSeconds: previousMetrics.uptimeSeconds + (!machineIdle ? delta : 0),
                downtimeSeconds: previousMetrics.downtimeSeconds + (machineIdle ? delta : 0),
                lastTimestamp: response.timestamp
              } };
            });
            if (camera.error) updateCamera(camera.id, { error: '' });
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Frame analysis failed.';
            updateCamera(camera.id, { error: message });
            setEvents((current) => [{ id: `${camera.id}-error-${Date.now()}`, cameraId: camera.id, timestamp: Date.now() / 1000, type: 'error' as const, title: 'Analysis error', detail: message }, ...current].slice(0, 500));
          } finally {
            analyzing.current[camera.id] = false;
          }
        })();
      });
    }, 500);
    return () => window.clearInterval(timer);
  }, [running, updateCamera]);

  useEffect(() => () => {
    Object.keys(streamRefs.current).forEach(stopSource);
  }, [stopSource]);

  const getCamera = useCallback((cameraId?: string) => cameraRef.current.find((camera) => camera.id === (cameraId ?? activeCameraId)) ?? cameraRef.current[0], [activeCameraId]);

  const value = useMemo<VisionContextValue>(() => ({
    workerStatus, workerDetail, models, cameras, activeCameraId, frames, running, events, metrics,
    setActiveCameraId, getCamera, updateCamera, updateConfiguration, addCamera, removeCamera,
    setVideoElement, connectBrowserCamera, connectUploadedVideo, connectExternalVideo, disconnectCamera,
    toggleEngine, resetCamera, refreshModels
  }), [workerStatus, workerDetail, models, cameras, activeCameraId, frames, running, events, metrics, getCamera, updateCamera, updateConfiguration, addCamera, removeCamera, setVideoElement, connectBrowserCamera, connectUploadedVideo, connectExternalVideo, disconnectCamera, toggleEngine, resetCamera, refreshModels]);

  return <VisionContext.Provider value={value}>{children}</VisionContext.Provider>;
}

export function useVision() {
  const context = useContext(VisionContext);
  if (!context) throw new Error('useVision must be used inside VisionProvider');
  return context;
}

export interface TrainingAnnotation { id: string; className: string; x: number; y: number; width: number; height: number }
export interface TrainingImage { id: string; fileName: string; width: number; height: number; reviewed: boolean; annotations: TrainingAnnotation[] }
export interface TrainingVersion { id: string; createdAt: number; active: boolean; metrics: Record<string, number> }
export interface TrainingProject {
  id: string;
  name: string;
  description: string;
  classes: string[];
  baseModel: string;
  status: string;
  images: TrainingImage[];
  versions: TrainingVersion[];
  activeModelId: string | null;
  training: null | { status: string; progress: number; epoch: number; totalEpochs: number; error?: string };
}
export interface TrainingState { ok: boolean; projects: TrainingProject[]; activatedModel?: { id: string; name: string; classes: string[] }; deletedModelIds?: string[] }

export const trainingApi = {
  list: () => requestJson<TrainingState>('/training/projects'),
  create: (input: { name: string; description: string; classes: string[]; baseModel: string }) => requestJson<TrainingState>('/training/projects/create', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }),
  upload: (projectId: string, images: Array<{ fileName: string; data: string }>) => requestJson<TrainingState>('/training/images/upload', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId, images }) }),
  saveAnnotations: (projectId: string, imageId: string, annotations: TrainingAnnotation[], reviewed: boolean) => requestJson<TrainingState>('/training/annotations/save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId, imageId, annotations, reviewed }) }),
  train: (projectId: string, epochs: number, imageSize: number) => requestJson<TrainingState>('/training/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId, epochs, imageSize }) }),
  activate: (projectId: string, versionId: string) => requestJson<TrainingState>('/training/activate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId, versionId }) }),
  delete: (projectId: string) => requestJson<TrainingState>('/training/projects/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId }) }),
  imageUrl: (projectId: string, imageId: string) => `${workerUrl}/training/image?projectId=${encodeURIComponent(projectId)}&imageId=${encodeURIComponent(imageId)}`
};

export function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('File could not be read.'));
    reader.readAsDataURL(file);
  });
}
