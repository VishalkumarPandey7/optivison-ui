import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  BarChart3,
  Bell,
  Boxes,
  Camera,
  Check,
  ChevronRight,
  CircleDot,
  Clock3,
  Copy,
  Cpu,
  Database,
  Edit3,
  Eye,
  Gauge,
  Grid2X2,
  Layers3,
  LineChart,
  Link2,
  Mail,
  MapPin,
  Maximize2,
  Menu,
  MessageCircle,
  MonitorPlay,
  MoreHorizontal,
  MousePointer2,
  Pause,
  Play,
  Plus,
  Route,
  Save,
  ScanLine,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Target,
  TimerReset,
  Trash2,
  Upload,
  Users,
  Waypoints,
  X,
  Zap
} from 'lucide-react';
import {
  fileToDataUrl,
  trainingApi,
  useVision,
  type CameraRecord,
  type CameraCardMetric,
  type BusinessMetricKey,
  type BusinessRuleDefinition,
  type CountingLine,
  type RuleDefinition,
  type SignalDefinition,
  type SignalKind,
  type PersonActivityRecord,
  type TrainingAnnotation,
  type TrainingProject,
  type TrainingState,
  type Zone
} from './vision';
import { builtInRuleTemplates, builtInSignalTemplates, createSignalFromTemplate, type RuleTemplate, type SignalTemplate } from './templates';
import { LifecycleAutomationSetup, LifecycleStationSetup, LprTrackingPage, useLpr } from './lpr';
import { isArray, readStoredJson, readStoredString, writeStoredJson, writeStoredString } from './state/persistence';
import { readSetupDraft, writeSetupDraft } from './state/setupState';
import {
  resolveMetricBinding,
  type MetricSourceBinding,
  type OperationalMetricBindingKey,
  type MetricTotals
} from './state/operationalMetrics';
import { summarizePersonActivity } from './state/personActivity';

type Page =
  | 'setup-home'
  | 'add-camera'
  | 'cameras'
  | 'signals'
  | 'detection-rules'
  | 'business-rules'
  | 'automations'
  | 'integrations'
  | 'training'
  | 'monitoring'
  | 'camera-detail'
  | 'dashboard'
  | 'notifications'
  | 'lpr-cycle'
  | 'lpr-tracking';

const pageStorageKey = 'optivision-current-page-v1';
const dashboardWidgetsStorageKey = 'optivision-dashboard-widgets-v1';
const validPages = new Set<Page>([
  'setup-home', 'add-camera', 'cameras', 'signals', 'detection-rules', 'business-rules',
  'automations', 'integrations', 'training', 'monitoring', 'camera-detail', 'dashboard',
  'notifications', 'lpr-cycle', 'lpr-tracking'
]);

function loadStoredPage(): Page {
  const stored = readStoredString(pageStorageKey) as Page;
  return stored && validPages.has(stored) ? stored : 'monitoring';
}

function loadDashboardWidgets() {
  const fallback = ['Worker Productivity', 'Machine Utilization', 'Output Count', 'Camera Feed', 'Production Trend', 'Recent Alerts'];
  const parsed = readStoredJson<string[]>(dashboardWidgetsStorageKey, fallback, isArray<string>);
  return parsed.length ? parsed : fallback;
}

function distinctNotificationEvents<T extends { cameraId: string; detail: string; id: string; title: string; type: string }>(events: T[]) {
  const repeatedErrors = new Set<string>();
  return events.filter((event) => {
    if (event.type !== 'error') return true;
    const key = `${event.cameraId}:${event.title}:${event.detail}`;
    if (repeatedErrors.has(key)) return false;
    repeatedErrors.add(key);
    return true;
  });
}

const setupNavigation: Array<{ id: Page; label: string; icon: typeof Camera }> = [
  { id: 'setup-home', label: 'Setup overview', icon: Layers3 },
  { id: 'add-camera', label: 'Configuration flow', icon: Settings2 },
  { id: 'cameras', label: 'Cameras', icon: Camera },
  { id: 'signals', label: 'Manage signals', icon: Activity },
  { id: 'detection-rules', label: 'Detection rules', icon: Waypoints },
  { id: 'business-rules', label: 'Business rules', icon: BarChart3 },
  { id: 'automations', label: 'Automations', icon: Zap },
  { id: 'integrations', label: 'Integrations', icon: Link2 },
  { id: 'training', label: 'Model training', icon: Cpu }
];

const workflowSteps: Array<{ id: Page; label: string; hint: string; icon: typeof Camera }> = [
  { id: 'cameras', label: 'Cameras', hint: 'Connect and define ROI', icon: Camera },
  { id: 'signals', label: 'Signals', hint: 'Describe what is detected', icon: Activity },
  { id: 'detection-rules', label: 'Detection Rules', hint: 'Combine signal states', icon: Waypoints },
  { id: 'business-rules', label: 'Business Rules', hint: 'Calculate operational value', icon: BarChart3 },
  { id: 'lpr-cycle', label: 'Lifecycle Setup', hint: 'Map LPR stations and flow', icon: ScanLine },
  { id: 'automations', label: 'Automations', hint: 'Choose the response', icon: Zap },
  { id: 'monitoring', label: 'Monitoring', hint: 'Run and observe', icon: MonitorPlay }
];

const workflowPages = new Set<Page>(['add-camera', ...workflowSteps.map((step) => step.id)]);

function WorkflowGuide({ page, setPage }: { page: Page; setPage: (page: Page) => void }) {
  const currentPage = page === 'add-camera' ? 'cameras' : page;
  const currentIndex = workflowSteps.findIndex((step) => step.id === currentPage);
  return <nav className="setup-workflow" aria-label="OptiVision setup workflow"><div className="workflow-context"><span>Configuration flow</span><strong>{currentIndex >= 0 ? `Step ${currentIndex + 1} of ${workflowSteps.length}` : 'Guided setup'}</strong></div><div className="workflow-track">{workflowSteps.map((step, index) => <button className={index === currentIndex ? 'active' : index < currentIndex ? 'visited' : ''} key={step.id} type="button" onClick={() => setPage(step.id)} title={step.hint}><span><step.icon size={15} /></span><small>{step.label}</small>{index < workflowSteps.length - 1 ? <ChevronRight size={13} /> : null}</button>)}</div></nav>;
}

const wizardSteps = [
  'Plant',
  'Cameras',
  'Feed Preview',
  'ROI / Zones',
  'Model',
  'Display Parameters',
  'User Parameters',
  'Detection Signals',
  'Detection Rules',
  'Business Rules',
  'Station Mapping',
  'Automations',
  'Save / Review'
];

const models = [
  ['YOLO26n', 'Detection', '12 MB', '58 FPS', 'Low', 'General detection'],
  ['YOLO26s PPE', 'PPE', '41 MB', '34 FPS', 'Medium', 'Helmet and vest'],
  ['DEIMv2 Pico', 'Detection', '19 MB', '46 FPS', 'Low', 'Edge devices'],
  ['YOLO11m', 'Detection', '39 MB', '28 FPS', 'Medium', 'Balanced accuracy'],
  ['YOLO11s PPE', 'PPE', '22 MB', '41 FPS', 'Low', 'Safety monitoring'],
  ['YOLOv8n', 'Detection', '6 MB', '64 FPS', 'Low', 'Fast detection'],
  ['YOLOv8s PPE', 'PPE', '24 MB', '38 FPS', 'Medium', 'PPE compliance'],
  ['RF-DETR Nano', 'Detection', '31 MB', '32 FPS', 'Medium', 'Small objects'],
  ['Motion Detection', 'Motion', 'Built-in', 'Real-time', 'Very low', 'Machine movement'],
  ['State Classifier', 'Classification', 'Custom', 'Model based', 'Varies', 'Machine states']
];

const signalRows = [
  ['Worker Present', 'Presence', 'Assembly Line 01', 'Worker Zone', 'YOLO26n', 'Active'],
  ['Worker Moving', 'Movement', 'Assembly Line 01', 'Worker Zone', 'YOLO26n', 'Active'],
  ['Machine Motion', 'Movement', 'Assembly Line 01', 'Machine Zone', 'Motion Detection', 'Active'],
  ['Output Count', 'Count', 'Packaging Line 02', 'Counting Line', 'YOLO11m', 'Active'],
  ['Material Present', 'Presence', 'Packaging Line 02', 'Material Zone', 'YOLO11m', 'Disabled']
];

const detectionRuleRows = [
  ['Worker Working', 'Worker Present + Worker Moving', 'Assembly Line 01', 'Worker Zone', 'TRUE', '10:32:15'],
  ['Worker Idle', 'Worker Present + Not Moving', 'Assembly Line 01', 'Worker Zone', 'FALSE', '09:48:06'],
  ['Machine Running', 'Machine Motion', 'Assembly Line 01', 'Machine Zone', 'TRUE', '10:42:51'],
  ['Machine Stopped', 'No Machine Motion', 'Assembly Line 01', 'Machine Zone', 'FALSE', '08:15:40']
];

const businessRuleRows = [
  ['Worker Productivity', 'Working Time / Presence Time × 100', 'Assembly Line 01', '86%', '%'],
  ['Machine Utilization', 'Running Time / Shift Duration × 100', 'Assembly Line 01', '91%', '%'],
  ['Total Downtime', 'SUM Machine Idle periods', 'Assembly Line 01', '48m', 'duration'],
  ['Production Count', 'SUM Output Count', 'Packaging Line 02', '427', 'count'],
  ['Average Cycle Time', 'Production Time / Completed Cycles', 'Packaging Line 02', '44s', 'seconds']
];

const cameraCards = [
  { name: 'Assembly Line 01', location: 'Plant A · Assembly', status: 'Running', workers: 4, working: 3, idle: 1, output: 427, productivity: 86, tone: 'orange' },
  { name: 'Packaging Line 02', location: 'Plant A · Packaging', status: 'Running', workers: 2, working: 2, idle: 0, output: 612, productivity: 94, tone: 'blue' },
  { name: 'Machine Cell 03', location: 'Plant B · Machining', status: 'Stopped', workers: 1, working: 0, idle: 1, output: 184, productivity: 61, tone: 'purple' }
];

function Brand() {
  return (
    <button className="brand" type="button">
      <span className="brand-mark"><CircleDot size={26} /></span>
      <span><strong>Opti<span>Vision</span></strong><small>VISION INTELLIGENCE</small></span>
    </button>
  );
}

function Pill({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: string }) {
  return <span className={`pill ${tone}`}>{children}</span>;
}

function formatActivityDuration(seconds: number) {
  const safe = Math.max(0, Math.round(seconds));
  if (safe < 60) return `${safe}s`;
  if (safe < 3600) return `${Math.floor(safe / 60)}m ${safe % 60}s`;
  return `${Math.floor(safe / 3600)}h ${Math.floor(safe % 3600 / 60)}m`;
}

function personStateLabel(state: PersonActivityRecord['state']) {
  return state === 'not_visible' ? 'Not visible' : state.charAt(0).toUpperCase() + state.slice(1);
}

function currentVisitDuration(record: PersonActivityRecord) {
  const visit = record.visits[record.visits.length - 1];
  if (!visit) return 0;
  const liveTail = record.state === 'not_visible' ? 0 : Math.min(15, Math.max(0, Date.now() / 1000 - record.lastSeenAt));
  return visit.presentSeconds + liveTail;
}

function Switch({ label, defaultOn = true, value, onChange }: { label: string; defaultOn?: boolean; value?: boolean; onChange?: (enabled: boolean) => void }) {
  const [localEnabled, setLocalEnabled] = useState(defaultOn);
  const enabled = value ?? localEnabled;
  return <button className="switch-row" type="button" aria-pressed={enabled} onClick={() => { const next = !enabled; if (onChange) onChange(next); else setLocalEnabled(next); }}><span>{label}</span><i className={enabled ? 'on' : ''}><b /></i></button>;
}

function EmptyFeed({
  compact = false,
  cameraId,
  editor = false,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  draftZone,
  draftLine
}: {
  compact?: boolean;
  cameraId?: string;
  editor?: boolean;
  onPointerDown?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  draftZone?: Partial<Zone> | null;
  draftLine?: CountingLine | null;
}) {
  const vision = useVision();
  const camera = vision.getCamera(cameraId);
  const frame = vision.frames[camera.id];
  // Inference runs independently from playback and may take several seconds
  // on CPU. Keep results briefly visible over the live feed, but never replace
  // the moving video with the captured analysis frame.
  const displayedFrame = frame && Date.now() / 1000 - (frame.receivedAt ?? frame.timestamp) <= 12 ? frame : undefined;
  const [playback, setPlayback] = useState({ current: 0, duration: 0 });
  const sourceReady = camera.sourceStatus === 'ready';
  const display = camera.configuration.display;
  const setVideoNode = useCallback((node: HTMLVideoElement | null) => vision.setVideoElement(camera.id, node), [camera.id, vision.setVideoElement]);
  const countSignal = displayedFrame?.signals.find((signal) => signal.kind === 'line_crossing_count');
  const displayZones = camera.configuration.zones.filter((zone) => zone.width > 0.5 && zone.height > 0.5);
  const displayLines = camera.configuration.countingLines.filter((line) => Math.abs(line.end.x - line.start.x) + Math.abs(line.end.y - line.start.y) > 0.5);
  return (
    <div
      className={`feed ${compact ? 'compact' : ''} ${editor ? 'feed-editor' : ''}`}
      onPointerDown={editor ? onPointerDown : undefined}
      onPointerMove={editor ? onPointerMove : undefined}
      onPointerUp={editor ? onPointerUp : undefined}
    >
      <div className="feed-grid" />
      <video
        autoPlay
        className={sourceReady ? 'vision-video ready' : 'vision-video'}
        controls={sourceReady && !editor && !compact}
        loop={camera.sourceType === 'uploaded'}
        muted
        onDurationChange={(event) => {
          const duration = event.currentTarget.duration;
          setPlayback((current) => ({ ...current, duration: Number.isFinite(duration) ? duration : 0 }));
        }}
        onTimeUpdate={(event) => {
          const { currentTime, duration } = event.currentTarget;
          setPlayback({ current: currentTime, duration: Number.isFinite(duration) ? duration : 0 });
        }}
        playsInline
        preload="auto"
        ref={setVideoNode}
      />
      <span className={`feed-live ${vision.running[camera.id] ? '' : 'paused'}`}><i /> {vision.running[camera.id] ? 'DETECTING' : sourceReady ? 'CONNECTED' : 'DEMO'}</span>
      {!sourceReady ? <div className="feed-empty"><Camera size={24} /><strong>No live feed</strong><small>Connect a camera or upload a video to begin detection.</small></div> : null}
      {display.zoneOverlays ? displayZones.map((zone) => <div className={`live-zone ${zone.kind}`} key={zone.id} style={{ left: `${zone.x}%`, top: `${zone.y}%`, width: `${zone.width}%`, height: `${zone.height}%`, borderColor: zone.color }}><span style={{ background: zone.color }}>{zone.name}</span></div>) : null}
      {draftZone && Number(draftZone.width) > 0 ? <div className="live-zone draft" style={{ left: `${draftZone.x}%`, top: `${draftZone.y}%`, width: `${draftZone.width}%`, height: `${draftZone.height}%` }} /> : null}
      {displayLines.map((line) => <svg className="live-count-line" key={line.id} viewBox="0 0 100 100" preserveAspectRatio="none"><line x1={line.start.x} y1={line.start.y} x2={line.end.x} y2={line.end.y} /></svg>)}
      {draftLine ? <svg className="live-count-line draft" viewBox="0 0 100 100" preserveAspectRatio="none"><line x1={draftLine.start.x} y1={draftLine.start.y} x2={draftLine.end.x} y2={draftLine.end.y} /></svg> : null}
      {display.boundingBoxes ? displayedFrame?.detections.map((detection) => {
        const [left, top, right, bottom] = detection.box;
        const personActivity = detection.className === 'person'
          ? vision.personActivity[camera.id]?.find((record) => record.trackId === String(detection.trackId))
          : undefined;
        const label = [
          display.labels ? (detection.plateText ? `PLATE ${detection.plateText}` : detection.className.toUpperCase()) : '',
          display.trackIds && !detection.plateText
            ? detection.className === 'person' ? personActivity ? `PERSON ${personActivity.displayId}` : 'PERSON' : `#${detection.trackId}`
            : '',
          display.trackIds && personActivity ? personStateLabel(personActivity.state).toUpperCase() : '',
          display.trackIds && personActivity ? formatActivityDuration(currentVisitDuration(personActivity)) : '',
          display.confidence ? `${Math.round(detection.confidence * 100)}%` : ''
        ].filter(Boolean).join(' · ');
        return <div className="live-detection" key={detection.id} style={{ left: `${left / displayedFrame.width * 100}%`, top: `${top / displayedFrame.height * 100}%`, width: `${(right - left) / displayedFrame.width * 100}%`, height: `${(bottom - top) / displayedFrame.height * 100}%`, borderColor: display.detectionColor, borderWidth: `${display.boxThickness}px` }}>{label ? <span style={{ background: display.detectionColor }}>{label}</span> : null}</div>;
      }) : null}
      {countSignal ? <div className="live-count-badge"><small>OBJECTS PASSED</small><strong>{Number(countSignal.evidence.totalCount ?? countSignal.value ?? 0)}</strong></div> : null}
      {sourceReady && !displayedFrame && vision.running[camera.id] ? <div className="feed-waiting">Waiting for the current analyzed frame…</div> : null}
      {camera.error ? <div className="feed-error">{camera.error}</div> : null}
      <span className="feed-time">{camera.sourceType === 'uploaded' ? `VIDEO ${Math.floor(playback.current / 60)}:${String(Math.floor(playback.current % 60)).padStart(2, '0')} / ${Math.floor(playback.duration / 60)}:${String(Math.floor(playback.duration % 60)).padStart(2, '0')}` : new Date((frame?.timestamp ?? Date.now() / 1000) * 1000).toLocaleString()}</span>
    </div>
  );
}

function AppHeader({ page, setPage, sidebarOpen, setSidebarOpen }: { page: Page; setPage: (page: Page) => void; sidebarOpen: boolean; setSidebarOpen: (open: boolean) => void }) {
  const vision = useVision();
  const title = page === 'camera-detail' ? vision.getCamera().name : page === 'setup-home' ? 'Setup' : page === 'add-camera' ? 'Configuration Setup' : page === 'lpr-cycle' || page === 'lpr-tracking' ? 'Lifecycle Tracking' : page.replaceAll('-', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
  return (
    <header className="app-header">
      <button className="mobile-menu" type="button" onClick={() => setSidebarOpen(!sidebarOpen)}><Menu size={20} /></button>
      <div><span className="breadcrumb">OptiVision / {page.startsWith('setup') || setupNavigation.some((item) => item.id === page) ? 'Setup' : 'Operations'}</span><h1>{title}</h1></div>
      <div className="header-actions">
        <label className="search"><Search size={16} /><input aria-label="Search" placeholder="Search cameras, rules, events..." /></label>
        <button className="icon-button notification-button" type="button" onClick={() => setPage('notifications')}><Bell size={18} />{distinctNotificationEvents(vision.events).length ? <i /> : null}</button>
        <span className={`live-chip ${vision.workerStatus}`} title={vision.workerDetail}><i /> {vision.workerStatus === 'online' ? 'Engine online' : vision.workerStatus === 'checking' ? 'Checking engine' : 'Engine offline'}</span>
        <button className="avatar" type="button">VP</button>
      </div>
    </header>
  );
}

function Sidebar({ page, setPage, open }: { page: Page; setPage: (page: Page) => void; open: boolean }) {
  const vision = useVision();
  const notificationCount = distinctNotificationEvents(vision.events).length;
  return (
    <aside className={`sidebar ${open ? 'open' : ''}`}>
      <Brand />
      <nav>
        <span className="nav-label">OPERATIONS</span>
        <button className={page === 'monitoring' || page === 'camera-detail' ? 'active' : ''} type="button" onClick={() => setPage('monitoring')}><MonitorPlay size={18} />User monitoring</button>
        <button className={page === 'dashboard' ? 'active' : ''} type="button" onClick={() => setPage('dashboard')}><Grid2X2 size={18} />Dashboard</button>
        <button className={page === 'lpr-tracking' || page === 'lpr-cycle' ? 'active' : ''} type="button" onClick={() => setPage('lpr-tracking')}><Route size={18} />Lifecycle Tracking</button>
        <button className={page === 'notifications' ? 'active' : ''} type="button" onClick={() => setPage('notifications')}><Bell size={18} />Notifications {notificationCount ? <em>{Math.min(99, notificationCount)}</em> : null}</button>
        <span className="nav-label setup-label">SETUP</span>
        {setupNavigation.map((item) => {
          const Icon = item.icon;
          return <button className={page === item.id ? 'active' : ''} type="button" key={item.id} onClick={() => setPage(item.id)}><Icon size={18} />{item.label}</button>;
        })}
      </nav>
      <div className="sidebar-footer"><ShieldCheck size={18} /><span><strong>Administrator</strong><small>Full configuration access</small></span></div>
    </aside>
  );
}

function SetupHome({ setPage }: { setPage: (page: Page) => void }) {
  return (
    <div className="page-stack">
      <section className="hero-card">
        <div><Pill tone="orange"><Sparkles size={13} /> Guided setup</Pill><h2>Build camera intelligence in the correct order.</h2><p>Configure the source once, turn detections into reusable signals, calculate business meaning, then automate the response.</p><button className="primary" type="button" onClick={() => setPage('add-camera')}><Plus size={16} /> Add camera</button></div>
        <div className="hero-metrics"><span><strong>3</strong><small>Cameras</small></span><span><strong>5</strong><small>Signals</small></span><span><strong>4</strong><small>Detection rules</small></span><span><strong>3</strong><small>Automations</small></span></div>
      </section>
      <section className="panel">
        <div className="section-heading"><div><span className="eyebrow">FINAL ARCHITECTURE</span><h2>Configuration hierarchy</h2><p>Each layer uses the output of the previous layer.</p></div></div>
        <div className="hierarchy-flow">
          {workflowSteps.map((step, index) => <div className="hierarchy-item" key={step.id}><button type="button" onClick={() => setPage(step.id)}><span><step.icon size={19} /></span><div><strong>{step.label}</strong><small>{step.hint}</small></div></button>{index < workflowSteps.length - 1 && <ChevronRight size={18} />}</div>)}
        </div>
      </section>
      <section className="two-column">
        <article className="panel quick-start"><div className="section-heading"><div><span className="eyebrow">ADMINISTRATOR</span><h2>Setup workspace</h2></div></div>{setupNavigation.slice(1).map((item) => <button type="button" key={item.id} onClick={() => setPage(item.id)}><item.icon size={18} /><span><strong>{item.label}</strong><small>Open configuration</small></span><ChevronRight size={16} /></button>)}</article>
        <article className="panel separation-card"><span className="eyebrow">IMPORTANT SEPARATION</span><h2>Configuration stays out of daily monitoring.</h2><div><span><Settings2 size={19} /></span><p><strong>Setup</strong> creates the camera, signals, rules, business logic, and actions.</p></div><div><span><Eye size={19} /></span><p><strong>User monitoring</strong> shows live camera results and relevant operational values.</p></div><div><span><Grid2X2 size={19} /></span><p><strong>Dashboard</strong> combines selected values into a customizable business view.</p></div></article>
      </section>
    </div>
  );
}

function FormField({ label, children, wide = false }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return <label className={wide ? 'field wide' : 'field'}><span>{label}</span>{children}</label>;
}

function LegacyCameraWizard({ setPage }: { setPage: (page: Page) => void }) {
  const [step, setStep] = useState(0);
  const [source, setSource] = useState('RTSP');
  const [selectedModel, setSelectedModel] = useState('YOLO26n');
  const [signalMode, setSignalMode] = useState<'existing' | 'new'>('existing');
  const [saved, setSaved] = useState(false);

  const stepContent = () => {
    if (step === 0) return <div className="wizard-content"><div className="section-heading"><div><span className="eyebrow">STEP 1 OF 10</span><h2>Camera source</h2><p>Choose the source and identify where this camera operates.</p></div><Pill tone="orange">Required</Pill></div><div className="choice-grid source-grid">{['RTSP', 'IP Camera', 'ONVIF', 'USB Camera', 'Browser Camera', 'Uploaded / Recorded Video'].map((item) => <button className={source === item ? 'selected' : ''} type="button" key={item} onClick={() => setSource(item)}><Camera size={20} /><strong>{item}</strong><small>{item === 'RTSP' ? 'Recommended for production' : 'Available source'}</small>{source === item && <Check size={15} />}</button>)}</div><div className="form-grid"><FormField label="Camera name"><input defaultValue="Assembly Line 01" /></FormField><FormField label="Location"><input defaultValue="Plant A" /></FormField><FormField label="Department"><input defaultValue="Assembly" /></FormField><FormField label="Production line"><input defaultValue="Line 01" /></FormField><FormField label="Resolution"><select defaultValue="1920 × 1080"><option>1920 × 1080</option><option>1280 × 720</option></select></FormField><FormField label="FPS"><input type="number" defaultValue="25" /></FormField><FormField label="Connection settings" wide><input defaultValue="rtsp://192.168.1.45:554/stream1" /></FormField></div><div className="inline-status success"><Check size={16} /><span><strong>Connection test successful</strong><small>Camera reachable · 1920 × 1080 · 25 FPS</small></span><button type="button">Test again</button></div></div>;
    if (step === 1) return <div className="wizard-content"><div className="section-heading"><div><span className="eyebrow">STEP 2 OF 10</span><h2>Feed preview</h2><p>Confirm the live feed before creating zones and intelligence.</p></div><Pill tone="green"><i /> Connected</Pill></div><EmptyFeed /><div className="preview-details"><span><small>Camera</small><strong>Assembly Line 01</strong></span><span><small>Resolution</small><strong>1920 × 1080</strong></span><span><small>Frame rate</small><strong>25 FPS</strong></span><span><small>Latency</small><strong>84 ms</strong></span><button type="button"><Maximize2 size={15} /> Full screen</button></div></div>;
    if (step === 2) return <div className="wizard-content"><div className="section-heading"><div><span className="eyebrow">STEP 3 OF 10</span><h2>ROI / Zone setup</h2><p>Draw directly on the camera feed. Create as many zones as this camera requires.</p></div><button className="secondary" type="button"><Plus size={15} /> Add zone</button></div><div className="roi-workspace"><div><div className="drawing-tools">{['Rectangle', 'Polygon', 'Line', 'Multiple regions', 'Custom shape'].map((tool, index) => <button className={index === 0 ? 'active' : ''} type="button" key={tool}><MousePointer2 size={14} />{tool}</button>)}</div><EmptyFeed /></div><aside><span className="eyebrow">CAMERA ZONES</span>{[['Worker Zone', '#ff6b00', 'Rectangle'], ['Machine Zone', '#7c3aed', 'Polygon'], ['Counting Line', '#1d9bf0', 'Line']].map(([name, color, type]) => <article key={name}><i style={{ background: color }} /><span><strong>{name}</strong><small>{type} · Active</small></span><button type="button"><Edit3 size={14} /></button><button type="button"><Trash2 size={14} /></button></article>)}<button className="add-inline" type="button"><Plus size={14} /> Add another zone</button><div className="zone-form"><FormField label="Zone name"><input defaultValue="Worker Zone" /></FormField><FormField label="Type"><select><option>Worker Zone</option><option>Machine Zone</option><option>Material Zone</option><option>Output Zone</option><option>Inspection Zone</option></select></FormField><FormField label="Description"><textarea defaultValue="Operator working area" /></FormField><FormField label="Color"><input type="color" defaultValue="#ff6b00" /></FormField></div></aside></div></div>;
    if (step === 3) return <div className="wizard-content"><div className="section-heading"><div><span className="eyebrow">STEP 4 OF 10</span><h2>Model selection</h2><p>Use the recommended model or manually select the processing model.</p></div><Pill tone="green"><Sparkles size={13} /> Recommended: YOLO26n</Pill></div><div className="model-table"><div className="model-head"><span>Model</span><span>Size</span><span>Expected FPS</span><span>CPU</span><span>Recommended use</span><span /></div>{models.map((model) => <button className={selectedModel === model[0] ? 'selected' : ''} type="button" key={model[0]} onClick={() => setSelectedModel(model[0])}><span><Cpu size={17} /><b>{model[0]}</b><small>{model[1]}</small></span><span>{model[2]}</span><span>{model[3]}</span><span>{model[4]}</span><span>{model[5]}</span><span>{selectedModel === model[0] ? <Check size={16} /> : 'Select'}</span></button>)}</div><div className="inline-status info"><Sparkles size={16} /><span><strong>Test model on the live camera</strong><small>Switch models and compare accuracy, FPS, and CPU before continuing.</small></span><button type="button"><Play size={14} /> Run live test</button></div></div>;
    if (step === 4) return <div className="wizard-content"><div className="section-heading"><div><span className="eyebrow">STEP 5 OF 10</span><h2>Visual display settings</h2><p>These settings change presentation only. They do not change detection logic.</p></div><button className="secondary" type="button"><Eye size={15} /> Preview</button></div><div className="display-layout"><div className="settings-card"><Switch label="Bounding boxes" /><Switch label="Track IDs" /><Switch label="Detection labels" /><Switch label="Confidence values" /><Switch label="Tracking trails" /><Switch label="Zone overlays" /><Switch label="Heatmap" defaultOn={false} /><div className="slider-row"><span>Bounding box thickness</span><input type="range" min="1" max="8" defaultValue="3" /></div><div className="slider-row"><span>Label size</span><input type="range" min="10" max="24" defaultValue="14" /></div><div className="color-row"><span>Detection colors</span><input type="color" defaultValue="#ff6b00" /><input type="color" defaultValue="#7c3aed" /><input type="color" defaultValue="#1d9bf0" /></div></div><EmptyFeed compact /></div></div>;
    if (step === 5) return <div className="wizard-content"><div className="section-heading"><div><span className="eyebrow">STEP 6 OF 10</span><h2>Detection signals</h2><p>A Detection Signal answers: <strong>What is happening in the camera feed?</strong></p></div><Pill tone="orange">First intelligence layer</Pill></div><div className="segmented"><button className={signalMode === 'existing' ? 'active' : ''} type="button" onClick={() => setSignalMode('existing')}>Select existing signal</button><button className={signalMode === 'new' ? 'active' : ''} type="button" onClick={() => setSignalMode('new')}>Create new signal</button></div>{signalMode === 'existing' ? <div className="signal-library">{['Worker Detected', 'Worker Present', 'Worker Moving', 'Worker Stationary', 'Machine Detected', 'Machine Moving', 'Machine Stationary', 'Machine Running', 'Machine Stopped', 'Material Detected', 'Product Detected', 'Object Count', 'Object Entered Zone', 'Object Exited Zone', 'Object Crossed Line', 'Motion Detected', 'Specific Color Detected'].map((item, index) => <label key={item}><input type="checkbox" defaultChecked={[1, 2, 7, 11].includes(index)} /><span><Activity size={15} /><strong>{item}</strong><small>{index % 3 === 0 ? 'Zone aware' : 'Reusable signal'}</small></span></label>)}</div> : <div className="builder-card"><div className="form-grid"><FormField label="Signal name"><input defaultValue="Worker Working" /></FormField><FormField label="Camera"><select><option>Assembly Line 01</option></select></FormField><FormField label="Object / class"><select><option>Person</option><option>Machine</option><option>Product</option></select></FormField><FormField label="Condition"><select><option>Movement detected</option><option>Present</option><option>Stationary</option></select></FormField><FormField label="Zone"><select><option>Worker Zone</option><option>Machine Zone</option></select></FormField><FormField label="Duration"><div className="input-suffix"><input type="number" defaultValue="5" /><span>seconds</span></div></FormField></div><div className="logic-preview"><small>SIGNAL LOGIC</small><strong>WHEN Person <em>AND</em> Movement detected <em>AND</em> Inside Worker Zone <em>FOR</em> 5 seconds</strong></div><button className="primary" type="button"><Save size={15} /> Save reusable signal</button></div>}</div>;
    if (step === 6) return <div className="wizard-content"><div className="section-heading"><div><span className="eyebrow">STEP 7 OF 10</span><h2>Detection rules</h2><p>Detection Rules answer: <strong>Based on what the camera detects, what does that detection mean?</strong></p></div><button className="secondary" type="button"><Play size={15} /> Live test</button></div><div className="builder-card rule-builder"><FormField label="Rule name"><input defaultValue="Worker Working" /></FormField><span className="logic-token if">IF</span>{['Worker Present', 'Worker Moving', 'Worker is inside Worker Zone'].map((item, index) => <div className="condition-row" key={item}><select defaultValue={item}><option>{item}</option><option>Machine Running</option><option>Material Present</option></select>{index < 2 && <Pill>AND</Pill>}<button type="button"><Trash2 size={14} /></button></div>)}<button className="add-inline" type="button"><Plus size={14} /> Add condition</button><div className="duration-row"><Pill tone="orange">FOR</Pill><input type="number" defaultValue="5" /><span>seconds continuously</span></div><div className="then-row"><span className="logic-token then">THEN</span><input defaultValue="Worker Working" /><span>=</span><select><option>TRUE</option><option>FALSE</option></select></div><div className="test-strip"><span><i /><strong>Live test result</strong> Rule is TRUE on Assembly Line 01</span><b>5.0 / 5.0s</b></div></div></div>;
    if (step === 7) return <div className="wizard-content"><div className="section-heading"><div><span className="eyebrow">STEP 8 OF 10</span><h2>Business rules</h2><p>Calculate what configured detection rules mean for the factory.</p></div><Pill tone="orange">No-code formula</Pill></div><div className="builder-card formula-builder"><div className="form-grid"><FormField label="Business rule name"><input defaultValue="Worker Productivity" /></FormField><FormField label="Unit"><select><option>Percentage (%)</option><option>Duration</option><option>Count</option><option>Ratio</option></select></FormField><FormField label="Camera"><select><option>Assembly Line 01</option></select></FormField><FormField label="Time window"><select><option>Current shift</option><option>Last hour</option><option>Today</option></select></FormField></div><span className="field-label">Formula</span><div className="formula-canvas"><button type="button">Working Time</button><b>÷</b><button type="button">Total Presence Time</button><b>×</b><span>100</span></div><div className="formula-tools">{['+', '−', '×', '÷', '%', 'SUM', 'COUNT', 'AVERAGE', 'MIN', 'MAX', 'Duration', 'Comparison'].map((item) => <button type="button" key={item}>{item}</button>)}</div><div className="result-preview"><span><small>CURRENT RESULT</small><strong>86%</strong></span><p>Worker Productivity = Working Time ÷ Total Presence Time × 100</p></div></div></div>;
    if (step === 8) return <div className="wizard-content"><div className="section-heading"><div><span className="eyebrow">STEP 9 OF 10</span><h2>Automations</h2><p>Define what OptiVision should do when a rule, threshold, or duration condition is met.</p></div><Pill tone="green"><Check size={13} /> Integrations ready</Pill></div><div className="builder-card automation-builder"><FormField label="Automation name"><input defaultValue="Low productivity alert" /></FormField><span className="logic-token if">IF</span><div className="automation-condition"><select><option>Business Rule</option><option>Detection Rule</option><option>Threshold</option><option>Duration</option></select><select><option>Worker Productivity</option><option>Machine Utilization</option><option>Production Count</option></select><select><option>is below</option><option>is above</option><option>equals</option></select><div className="input-suffix"><input type="number" defaultValue="70" /><span>%</span></div></div><span className="logic-token then">THEN</span><div className="action-grid"><label><input type="checkbox" defaultChecked /><span><Mail size={18} /><strong>Email</strong><small>Connected</small></span></label><label><input type="checkbox" defaultChecked /><span><MessageCircle size={18} /><strong>WhatsApp</strong><small>Connected</small></span></label><label><input type="checkbox" defaultChecked /><span><Bell size={18} /><strong>In-system</strong><small>Available</small></span></label></div><div className="form-grid"><FormField label="Recipient group"><select><option>Production Manager</option><option>Maintenance Team</option></select></FormField><FormField label="Repeat"><select><option>Once per event</option><option>Every 10 minutes</option><option>Hourly digest</option></select></FormField><FormField label="Message" wide><textarea defaultValue="Worker productivity on Assembly Line 01 is below 70%. Please review the camera and event history." /></FormField></div></div></div>;
    return <div className="wizard-content"><div className="section-heading"><div><span className="eyebrow">STEP 10 OF 10</span><h2>Review and save</h2><p>Confirm the complete camera intelligence flow before making it available to users.</p></div>{saved ? <Pill tone="green"><Check size={13} /> Saved</Pill> : <Pill tone="orange">Ready to save</Pill>}</div><div className="review-grid">{[['Camera', 'Assembly Line 01', 'RTSP · Plant A · Assembly'], ['Model', selectedModel, 'Detection · 58 expected FPS'], ['Zones', '3 configured', 'Worker Zone · Machine Zone · Counting Line'], ['Signals', '4 selected', 'Worker Present · Moving · Machine Motion · Output Count'], ['Detection rules', '3 configured', 'Worker Working · Worker Idle · Machine Running'], ['Business rules', '2 configured', 'Worker Productivity · Machine Utilization'], ['Automations', '1 configured', 'Email + WhatsApp + In-system']].map(([label, value, detail], index) => <article key={label}><span>{index + 1}</span><div><small>{label}</small><strong>{value}</strong><p>{detail}</p></div><button type="button" onClick={() => setStep(Math.min(index === 0 ? 0 : index + 2, 8))}><Edit3 size={14} /> Edit</button></article>)}</div>{saved ? <div className="save-success"><span><Check size={24} /></span><div><h3>Camera configuration saved</h3><p>Assembly Line 01 is now available in User Monitoring and Dashboard.</p></div><button className="primary" type="button" onClick={() => setPage('monitoring')}>Open monitoring <ArrowRight size={15} /></button></div> : <button className="primary large" type="button" onClick={() => setSaved(true)}><Save size={17} /> Save camera configuration</button>}</div>;
  };

  return <div className="wizard-page"><button className="back-link" type="button" onClick={() => setPage('cameras')}><ArrowLeft size={15} /> Cameras</button><div className="wizard-stepper">{wizardSteps.map((label, index) => <button className={step === index ? 'active' : step > index ? 'complete' : ''} type="button" key={label} onClick={() => setStep(index)}><span>{step > index ? <Check size={13} /> : index + 1}</span><small>{label}</small></button>)}</div><section className="panel wizard-shell">{stepContent()}<footer className="wizard-footer"><button className="secondary" type="button" disabled={step === 0} onClick={() => setStep(step - 1)}><ArrowLeft size={15} /> Back</button><span>Step {step + 1} of {wizardSteps.length}</span>{step < wizardSteps.length - 1 ? <button className="primary" type="button" onClick={() => setStep(step + 1)}>Continue <ArrowRight size={15} /></button> : <button className="secondary" type="button" onClick={() => setPage('cameras')}>Finish</button>}</footer></section></div>;
}

function CameraWizard({ setPage }: { setPage: (page: Page) => void }) {
  const vision = useVision();
  const camera = vision.getCamera();
  const config = camera.configuration;
  const wizardStepStorageKey = `optivision-camera-wizard-step:${camera.id}`;
  const initialDraftRef = useRef<ReturnType<typeof readSetupDraft> | null>(null);
  if (!initialDraftRef.current) initialDraftRef.current = readSetupDraft(camera.id, wizardStepStorageKey, wizardSteps.length - 1);
  const initialDraft = initialDraftRef.current;
  const [setupStep, setSetupStep] = useState(initialDraft.currentStep);
  const [source, setSource] = useState<CameraRecord['sourceType']>(() => {
    const saved = initialDraft.sourceType as CameraRecord['sourceType'] | undefined;
    return saved && ['browser', 'uploaded', 'usb', 'http', 'rtsp', 'onvif', 'nvr'].includes(saved) ? saved : camera.sourceType;
  });
  const [externalUrl, setExternalUrl] = useState(initialDraft.externalUrl ?? camera.sourceUrl);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [activeZoneId, setActiveZoneId] = useState(initialDraft.activeZoneId ?? config.zones[0]?.id ?? '');
  const [drawMode, setDrawMode] = useState<'zone' | 'line'>(initialDraft.drawMode ?? 'zone');
  const [draftStart, setDraftStart] = useState<{ x: number; y: number } | null>(null);
  const [draftZone, setDraftZone] = useState<Partial<Zone> | null>(null);
  const [draftLine, setDraftLine] = useState<CountingLine | null>(null);
  const [signalMode, setSignalMode] = useState<'existing' | 'new'>(initialDraft.signalMode ?? 'existing');
  const [newSignal, setNewSignal] = useState(() => ({
    name: typeof initialDraft.newSignal?.name === 'string' ? initialDraft.newSignal.name : 'Worker Working',
    className: typeof initialDraft.newSignal?.className === 'string' ? initialDraft.newSignal.className : 'person',
    kind: (typeof initialDraft.newSignal?.kind === 'string' ? initialDraft.newSignal.kind : 'object_in_roi') as SignalKind,
    zoneId: typeof initialDraft.newSignal?.zoneId === 'string' ? initialDraft.newSignal.zoneId : 'operator-zone',
    holdSeconds: typeof initialDraft.newSignal?.holdSeconds === 'number' ? initialDraft.newSignal.holdSeconds : 5
  }));
  const [saved, setSaved] = useState(false);
  const [newPlantName, setNewPlantName] = useState('');
  const selectedPlant = vision.plants.find((plant) => plant.id === vision.selectedPlantId) ?? vision.plants[0];
  const plantCameras = vision.cameras.filter((item) => item.plantId === selectedPlant?.id);
  const [desiredCameraCount, setDesiredCameraCount] = useState(() => Math.max(1, plantCameras.length));
  const remainingCameraSlots = Math.max(0, 7 - vision.cameras.length);
  const maximumPlantCameraCount = plantCameras.length + remainingCameraSlots;
  const camerasToCreate = Math.max(0, desiredCameraCount - plantCameras.length);

  useEffect(() => {
    const draftPlantId = initialDraft.selectedPlantId;
    if (draftPlantId && vision.plants.some((plant) => plant.id === draftPlantId) && draftPlantId !== vision.selectedPlantId) vision.setSelectedPlantId(draftPlantId);
  }, []);

  useEffect(() => {
    if (plantCameras.length && !plantCameras.some((item) => item.id === vision.activeCameraId)) vision.setActiveCameraId(plantCameras[0].id);
  }, [vision.selectedPlantId]);

  useEffect(() => {
    setDesiredCameraCount(Math.max(1, plantCameras.length));
  }, [vision.selectedPlantId]);

  useEffect(() => {
    setSource(camera.sourceType);
    setExternalUrl(camera.sourceUrl);
    setActiveZoneId(camera.configuration.zones[0]?.id ?? '');
    setMessage('');
  }, [camera.id]);

  useEffect(() => {
    writeStoredString(wizardStepStorageKey, String(setupStep));
  }, [setupStep, wizardStepStorageKey]);

  useEffect(() => {
    writeSetupDraft({
      flowVersion: 3,
      cameraId: camera.id,
      selectedPlantId: vision.selectedPlantId,
      currentStep: setupStep,
      sourceType: source,
      externalUrl,
      activeZoneId,
      drawMode,
      signalMode,
      newSignal,
      updatedAt: Date.now()
    });
  }, [camera.id, vision.selectedPlantId, setupStep, source, externalUrl, activeZoneId, drawMode, signalMode, newSignal]);

  const sourceChoices: Array<{ id: CameraRecord['sourceType']; label: string }> = [
    { id: 'rtsp', label: 'RTSP' }, { id: 'http', label: 'IP Camera' }, { id: 'onvif', label: 'ONVIF' },
    { id: 'usb', label: 'USB Camera' }, { id: 'browser', label: 'Browser Camera' }, { id: 'uploaded', label: 'Uploaded / Recorded Video' }
  ];
  const signalTemplates = builtInSignalTemplates.map((template) => createSignalFromTemplate(template, config.zones));

  function updateConfig(update: (current: typeof config) => typeof config) {
    vision.updateConfiguration(camera.id, update);
  }

  function createSelectedPlantCameras() {
    if (!selectedPlant || camerasToCreate <= 0) return;
    vision.addCameras(camerasToCreate, selectedPlant.id, selectedPlant.name);
  }

  async function connectSource(file?: File) {
    setBusy('connect');
    setMessage('');
    try {
      if (source === 'browser' || source === 'usb') await vision.connectBrowserCamera(camera.id);
      else if (source === 'uploaded' && file) await vision.connectUploadedVideo(camera.id, file);
      else if (source !== 'uploaded') await vision.connectExternalVideo(camera.id, externalUrl, source);
      else return;
      setMessage('Connection ready. Continue to preview the real feed.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Connection failed.');
    } finally {
      setBusy('');
    }
  }

  function pointerPercent(event: ReactPointerEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(100, (event.clientX - bounds.left) / bounds.width * 100)),
      y: Math.max(0, Math.min(100, (event.clientY - bounds.top) / bounds.height * 100))
    };
  }

  function startDraw(event: ReactPointerEvent<HTMLDivElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = pointerPercent(event);
    setDraftStart(point);
    if (drawMode === 'zone') setDraftZone({ x: point.x, y: point.y, width: 0, height: 0 });
    else setDraftLine({ id: 'conveyor-line', name: 'Conveyor Counting Line', zoneId: 'counting-zone', start: point, end: point, coordinateSpace: 'percent' });
  }

  function moveDraw(event: ReactPointerEvent<HTMLDivElement>) {
    if (!draftStart) return;
    const point = pointerPercent(event);
    if (drawMode === 'zone') setDraftZone({ x: Math.min(draftStart.x, point.x), y: Math.min(draftStart.y, point.y), width: Math.abs(point.x - draftStart.x), height: Math.abs(point.y - draftStart.y) });
    else setDraftLine((current) => current ? { ...current, end: point } : null);
  }

  function finishDraw(event: ReactPointerEvent<HTMLDivElement>) {
    const point = pointerPercent(event);
    if (!draftStart) return;
    if (drawMode === 'zone') {
      const shape = { x: Math.min(draftStart.x, point.x), y: Math.min(draftStart.y, point.y), width: Math.abs(point.x - draftStart.x), height: Math.abs(point.y - draftStart.y) };
      if (shape.width > .5 && shape.height > .5) updateConfig((current) => ({ ...current, zones: current.zones.map((zone) => zone.id === activeZoneId ? { ...zone, ...shape } : zone), analysisRoiIds: current.analysisRoiIds.includes(activeZoneId) ? current.analysisRoiIds : [...current.analysisRoiIds, activeZoneId] }));
    } else if (draftLine) {
      const line = { ...draftLine, end: point };
      updateConfig((current) => ({ ...current, countingLines: current.countingLines.map((item) => item.id === line.id ? line : item) }));
    }
    setDraftStart(null); setDraftZone(null); setDraftLine(null);
  }

  function setTemplateEnabled(signal: SignalDefinition, enabled: boolean) {
    updateConfig((current) => {
      const matches = (item: SignalDefinition) => item.id === signal.id || item.name === signal.name;
      const existing = current.signals.find(matches);
      if (enabled) return existing ? current : { ...current, signals: [...current.signals, { ...signal }] };
      if (!existing) return current;
      return {
        ...current,
        signals: current.signals.filter((item) => item.id !== existing.id),
        rules: current.rules.filter((rule) => rule.conditions.every((condition) => condition.signalId !== existing.id))
      };
    });
  }

  function saveNewSignal() {
    const definition: SignalDefinition = {
      id: `signal-${Date.now()}`,
      name: newSignal.name.trim() || 'Custom Signal',
      kind: newSignal.kind,
      className: newSignal.className.trim() || 'person',
      sourceTask: newSignal.kind === 'pose_moving' ? 'pose' : 'detect',
      confidence: .35,
      zoneId: newSignal.zoneId || undefined,
      holdSeconds: Number(newSignal.holdSeconds) || 0
    };
    updateConfig((current) => ({ ...current, signals: [...current.signals, definition] }));
    setSignalMode('existing');
  }

  function addRule() {
    const first = config.signals[0];
    if (!first) return;
    const rule: RuleDefinition = { id: `rule-${Date.now()}`, name: 'New Detection Rule', output: 'NEW_RULE_OUTPUT', combinator: 'AND', forSeconds: 0, conditions: [{ id: `condition-${Date.now()}`, signalId: first.id, operator: 'IS_ACTIVE' }] };
    updateConfig((current) => ({ ...current, rules: [...current.rules, rule] }));
  }

  function addRuleTemplate(template: RuleTemplate) {
    updateConfig((current) => {
      if (current.rules.some((rule) => rule.id === template.id || rule.name === template.name)) return current;
      const signals = [...current.signals];
      const signalIds = new Map<string, string>();
      template.conditions.forEach((condition) => {
        const seed = builtInSignalTemplates.find((item) => item.id === condition.signalTemplateId);
        if (!seed) return;
        const existing = signals.find((signal) => signal.id === seed.id || signal.name === seed.name);
        if (existing) signalIds.set(seed.id, existing.id);
        else { const created = createSignalFromTemplate(seed, current.zones); signals.push(created); signalIds.set(seed.id, created.id); }
      });
      const rule: RuleDefinition = { id: template.id, name: template.name, output: template.output, combinator: template.combinator, forSeconds: template.forSeconds, conditions: template.conditions.map((condition, index) => ({ id: `${template.id}-condition-${index + 1}`, signalId: signalIds.get(condition.signalTemplateId) ?? condition.signalTemplateId, operator: condition.operator, value: condition.value })) };
      return { ...current, signals, rules: [...current.rules, rule] };
    });
  }

  const step = setupStep - 1;
  let content: React.ReactNode;
  if (setupStep === 0) content = <div className="wizard-content plant-first-step">
    <div className="section-heading"><div><span className="eyebrow">STEP 1 OF 13</span><h2>Select a plant</h2><p>Camera configuration, station mapping, and lifecycle setup will use the selected plant. Switching plants does not stop running cameras.</p></div><Pill tone="orange">Plant first</Pill></div>
    <div className="plant-choice-grid">{vision.plants.map((plant) => { const count = vision.cameras.filter((item) => item.plantId === plant.id).length; return <button className={vision.selectedPlantId === plant.id ? 'selected' : ''} key={plant.id} onClick={() => { vision.setSelectedPlantId(plant.id); const first = vision.cameras.find((item) => item.plantId === plant.id); if (first) vision.setActiveCameraId(first.id); }} type="button"><span><MapPin size={19} /></span><div><strong>{plant.name}</strong><small>{count} configured camera{count === 1 ? '' : 's'}</small></div>{vision.selectedPlantId === plant.id ? <Check size={17} /> : null}</button>; })}</div>
    <section className="panel add-plant-inline"><div><strong>Add another plant</strong><small>Create a plant only when cameras belong to a separate site or facility.</small></div><input aria-label="New plant name" value={newPlantName} onChange={(event) => setNewPlantName(event.target.value)} placeholder="Plant name" /><button className="secondary" disabled={!newPlantName.trim()} onClick={() => { const plant = vision.addPlant(newPlantName); vision.setSelectedPlantId(plant.id); setNewPlantName(''); }} type="button"><Plus size={14} />Add plant</button></section>
  </div>;
  else if (setupStep === 1) content = <div className="wizard-content">
    <div className="section-heading"><div><span className="eyebrow">STEP 2 OF 13</span><h2>Cameras in {selectedPlant?.name ?? 'this plant'}</h2><p>Choose how many cameras this plant needs, then configure each camera independently. Every created camera appears in User Monitoring.</p></div><Pill tone="orange">{vision.cameras.length} / 7 total</Pill></div>
    <section className="panel camera-count-setup"><div><span className="camera-count-icon"><Camera size={19} /></span><span><strong>How many cameras are in {selectedPlant?.name ?? 'this plant'}?</strong><small>The seven-camera limit is shared by all plants. Existing cameras are never removed when this number changes.</small></span></div><div className="camera-count-control"><label htmlFor="plant-camera-count">Camera count</label><input id="plant-camera-count" min={Math.max(1, plantCameras.length)} max={Math.max(1, maximumPlantCameraCount)} type="number" value={desiredCameraCount} onChange={(event) => { const value = Number(event.target.value); if (Number.isFinite(value)) setDesiredCameraCount(Math.max(Math.max(1, plantCameras.length), Math.min(Math.max(1, maximumPlantCameraCount), Math.floor(value)))); }} /><button className="primary" disabled={!camerasToCreate || camerasToCreate > remainingCameraSlots} onClick={createSelectedPlantCameras} type="button">{camerasToCreate ? <><Plus size={15} /> Create {camerasToCreate} camera{camerasToCreate === 1 ? '' : 's'}</> : <><Check size={15} /> Camera count ready</>}</button></div><small className="camera-slot-summary">{remainingCameraSlots ? `${remainingCameraSlots} camera slot${remainingCameraSlots === 1 ? '' : 's'} still available across all plants.` : 'All seven camera slots are currently in use.'}</small></section>
    {plantCameras.length ? <><div className="camera-selection-heading"><span><strong>Select the camera to configure</strong><small>You can switch cameras here or from the camera bar on every camera setup step.</small></span><small>{plantCameras.length} in {selectedPlant?.name}</small></div><div className="setup-camera-selector">{plantCameras.map((item, index) => <button aria-pressed={item.id === camera.id} className={item.id === camera.id ? 'selected' : ''} key={item.id} onClick={() => vision.setActiveCameraId(item.id)} type="button"><span className="camera-sequence">{index + 1}</span><Camera size={16} /><span><strong>{item.name}</strong><small>{item.sourceStatus === 'ready' ? 'Connected' : item.sourceStatus === 'error' ? 'Needs attention' : 'Not connected'}</small></span>{item.id === camera.id ? <Check size={14} /> : null}</button>)}</div></> : <div className="setup-empty-state"><Camera size={25} /><strong>No cameras in this plant</strong><p>Choose a camera count above and create the cameras to continue.</p></div>}
    {plantCameras.length ? <>
    <div className="choice-grid source-grid">{sourceChoices.map((item) => <button className={source === item.id ? 'selected' : ''} type="button" key={item.id} onClick={() => { setSource(item.id); vision.updateCamera(camera.id, { sourceType: item.id }); }}><Camera size={20} /><strong>{item.label}</strong><small>{item.id === 'rtsp' ? 'Use an HLS/WebRTC bridge' : 'Available source'}</small>{source === item.id && <Check size={15} />}</button>)}</div>
    <div className="form-grid"><FormField label="Camera name"><input value={camera.name} onChange={(event) => vision.updateCamera(camera.id, { name: event.target.value })} /></FormField><FormField label="Plant"><select value={camera.plantId} onChange={(event) => { const plant = vision.plants.find((item) => item.id === event.target.value); if (plant) vision.updateCamera(camera.id, { plantId: plant.id, location: plant.name }); }}>{vision.plants.map((plant) => <option key={plant.id} value={plant.id}>{plant.name}</option>)}</select></FormField><FormField label="Department"><input value={camera.department} onChange={(event) => vision.updateCamera(camera.id, { department: event.target.value })} /></FormField><FormField label="Production line"><input value={camera.productionLine} onChange={(event) => vision.updateCamera(camera.id, { productionLine: event.target.value })} /></FormField></div>
    {source === 'uploaded' ? <label className="upload-source"><Upload size={22} /><strong>Select CCTV video</strong><small>MP4, WebM, or another browser-playable recording</small><input accept="video/*" type="file" onChange={(event) => { const file = event.target.files?.[0]; if (file) void connectSource(file); }} /></label> : source === 'browser' || source === 'usb' ? <button className="primary connect-source" disabled={busy === 'connect'} type="button" onClick={() => void connectSource()}><Camera size={16} /> {busy ? 'Connecting…' : `Connect ${source === 'usb' ? 'USB' : 'browser'} camera`}</button> : <div className="external-source"><FormField label="Browser-playable stream URL"><input value={externalUrl} onChange={(event) => setExternalUrl(event.target.value)} placeholder="https://gateway.local/camera-1/index.m3u8" /></FormField><button className="primary" disabled={busy === 'connect'} type="button" onClick={() => void connectSource()}>{busy ? 'Testing…' : 'Connect and test'}</button><small>Raw RTSP cannot play in a browser. Use the HLS, WebRTC, or HTTP URL produced by your gateway/NVR.</small></div>}
    {message || camera.error ? <div className={`inline-status ${camera.sourceStatus === 'ready' ? 'success' : 'info'}`}><span><strong>{camera.sourceStatus === 'ready' ? 'Connection ready' : 'Connection status'}</strong><small>{camera.error || message}</small></span></div> : null}
    </> : null}
  </div>;
  else if (step === 1) content = <div className="wizard-content"><div className="section-heading"><div><span className="eyebrow">STEP 3 OF 13</span><h2>Feed preview</h2><p>Confirm the real feed before drawing zones.</p></div><Pill tone={camera.sourceStatus === 'ready' ? 'green' : 'red'}><i /> {camera.sourceStatus === 'ready' ? 'Connected' : 'Not connected'}</Pill></div><EmptyFeed cameraId={camera.id} /><div className="preview-details"><span><small>Camera</small><strong>{camera.name}</strong></span><span><small>Source</small><strong>{camera.sourceLabel || camera.sourceType}</strong></span><span><small>Engine</small><strong>{vision.workerStatus}</strong></span>{camera.sourceStatus === 'ready' ? <button type="button" onClick={() => vision.disconnectCamera(camera.id)}>Disconnect</button> : <button type="button" onClick={() => setSetupStep(1)}>Reconnect feed</button>}</div></div>;
  else if (step === 2) content = <div className="wizard-content"><div className="section-heading"><div><span className="eyebrow">STEP 3 OF 10</span><h2>ROI / Zone setup</h2><p>Select a zone, then drag on the feed. Completing the shape activates it automatically for this camera.</p></div><Pill tone="orange">{config.analysisRoiIds.length} active ROI</Pill></div><div className="roi-workspace"><div><div className="drawing-tools"><button className={drawMode === 'zone' ? 'active' : ''} type="button" onClick={() => setDrawMode('zone')}><MousePointer2 size={14} />Rectangle ROI</button><button className={drawMode === 'line' ? 'active' : ''} type="button" onClick={() => setDrawMode('line')}><Waypoints size={14} />Counting line</button></div><EmptyFeed cameraId={camera.id} editor onPointerDown={startDraw} onPointerMove={moveDraw} onPointerUp={finishDraw} draftZone={draftZone} draftLine={draftLine} /></div><aside><span className="eyebrow">CAMERA ZONES</span>{config.zones.map((zone) => <article className={activeZoneId === zone.id ? 'selected' : ''} key={zone.id} onClick={() => { setActiveZoneId(zone.id); setDrawMode('zone'); }}><i style={{ background: zone.color }} /><span><strong>{zone.name}</strong><small>{zone.width > .5 ? `${Math.round(zone.width)} × ${Math.round(zone.height)}% · Active` : 'Select to draw'}</small></span><button type="button"><Edit3 size={14} /></button><button type="button" onClick={(event) => { event.stopPropagation(); updateConfig((current) => ({ ...current, zones: current.zones.map((item) => item.id === zone.id ? { ...item, x: 0, y: 0, width: 0, height: 0 } : item), analysisRoiIds: current.analysisRoiIds.filter((id) => id !== zone.id) })); }}><Trash2 size={14} /></button></article>)}<div className="zone-form"><FormField label="Selected zone"><input value={config.zones.find((zone) => zone.id === activeZoneId)?.name ?? ''} onChange={(event) => updateConfig((current) => ({ ...current, zones: current.zones.map((zone) => zone.id === activeZoneId ? { ...zone, name: event.target.value } : zone) }))} /></FormField><FormField label="Strict overlap"><div className="input-suffix"><input min="10" max="100" type="number" value={Math.round(config.minimumRoiOverlap * 100)} onChange={(event) => updateConfig((current) => ({ ...current, minimumRoiOverlap: Math.max(.1, Math.min(1, Number(event.target.value) / 100)) }))} /><span>%</span></div></FormField></div></aside></div></div>;
  else if (step === 3) content = <div className="wizard-content"><div className="section-heading"><div><span className="eyebrow">STEP 5 OF 13</span><h2>Model selection</h2><p>Select actual models exposed by the OptiVision 2 worker.</p></div><Pill tone={vision.workerStatus === 'online' ? 'green' : 'red'}>{vision.workerDetail}</Pill></div><div className="model-table"><div className="model-head"><span>Model</span><span>Task</span><span>Classes</span><span>Installed</span><span>Use</span><span /></div>{vision.models.map((model) => { const selected = config.selectedModelIds.includes(model.id); return <button className={selected ? 'selected' : ''} type="button" key={model.id} onClick={() => updateConfig((current) => ({ ...current, selectedModelIds: selected ? current.selectedModelIds.filter((id) => id !== model.id) : [...current.selectedModelIds, model.id] }))}><span><Cpu size={17} /><b>{model.name}</b><small>{model.id}</small></span><span>{model.task}</span><span>{model.classes.length || 'Custom'}</span><span>{model.installed ? 'Yes' : 'On demand'}</span><span>{model.task === 'pose' ? 'Worker movement' : 'Object detection'}</span><span>{selected ? <Check size={16} /> : 'Select'}</span></button>; })}</div><div className="inline-status info"><Sparkles size={16} /><span><strong>Model isolation</strong><small>These models apply only to {camera.name}. Conveyor direct-motion counting can run without an object model.</small></span><button type="button" onClick={() => void vision.refreshModels()}>Refresh</button></div></div>;
  else if (step === 4) content = <div className="wizard-content"><div className="section-heading"><div><span className="eyebrow">STEP 5 OF 10</span><h2>Visual display settings</h2><p>These controls now change the live overlay for this camera.</p></div></div><div className="display-layout"><div className="settings-card"><Switch label="Bounding boxes" value={config.display.boundingBoxes} onChange={(value) => updateConfig((current) => ({ ...current, display: { ...current.display, boundingBoxes: value } }))} /><Switch label="Track IDs" value={config.display.trackIds} onChange={(value) => updateConfig((current) => ({ ...current, display: { ...current.display, trackIds: value } }))} /><Switch label="Detection labels" value={config.display.labels} onChange={(value) => updateConfig((current) => ({ ...current, display: { ...current.display, labels: value } }))} /><Switch label="Confidence values" value={config.display.confidence} onChange={(value) => updateConfig((current) => ({ ...current, display: { ...current.display, confidence: value } }))} /><Switch label="Tracking trails" value={config.display.trackingTrails} onChange={(value) => updateConfig((current) => ({ ...current, display: { ...current.display, trackingTrails: value } }))} /><Switch label="Zone overlays" value={config.display.zoneOverlays} onChange={(value) => updateConfig((current) => ({ ...current, display: { ...current.display, zoneOverlays: value } }))} /><Switch label="Heatmap" value={config.display.heatmap} onChange={(value) => updateConfig((current) => ({ ...current, display: { ...current.display, heatmap: value } }))} /><div className="display-color-row"><span>Detection color</span><input aria-label="Detection color" type="color" value={config.display.detectionColor} onChange={(event) => updateConfig((current) => ({ ...current, display: { ...current.display, detectionColor: event.target.value } }))} /></div><div className="slider-row"><span>Bounding box thickness</span><input type="range" min="1" max="8" value={config.display.boxThickness} onChange={(event) => updateConfig((current) => ({ ...current, display: { ...current.display, boxThickness: Number(event.target.value) } }))} /></div></div><EmptyFeed cameraId={camera.id} compact /></div></div>;
  else if (setupStep === 6) content = <div className="wizard-content"><div className="section-heading"><div><span className="eyebrow">STEP 7 OF 13</span><h2>User monitoring parameters</h2><p>Choose what operators should see on this camera card, including Workers working, Productivity, output, machine status, configured signals, and business values.</p></div></div><MonitoringMetricSetup cameraId={camera.id} /></div>;
  else if (setupStep === 7) content = <div className="wizard-content"><div className="section-heading"><div><span className="eyebrow">STEP 8 OF 13</span><h2>Detection signals</h2><p>Choose from the complete shared signal library or create a camera-specific signal.</p></div><Pill tone="orange">{config.signals.length} configured</Pill></div><div className="segmented"><button className={signalMode === 'existing' ? 'active' : ''} type="button" onClick={() => setSignalMode('existing')}>Signal templates ({signalTemplates.length})</button><button className={signalMode === 'new' ? 'active' : ''} type="button" onClick={() => setSignalMode('new')}>Create manually</button></div>{signalMode === 'existing' ? <div className="signal-library">{signalTemplates.map((signal) => { const selected = config.signals.some((item) => item.id === signal.id || item.name === signal.name); return <label key={signal.id}><input type="checkbox" checked={selected} onChange={(event) => setTemplateEnabled(signal, event.currentTarget.checked)} /><span><Activity size={15} /><strong>{signal.name}</strong><small>{signal.kind.replaceAll('_', ' ')}</small></span></label>; })}</div> : <div className="builder-card"><div className="form-grid"><FormField label="Signal name"><input value={newSignal.name} onChange={(event) => setNewSignal({ ...newSignal, name: event.target.value })} /></FormField><FormField label="Object class"><input value={newSignal.className} onChange={(event) => setNewSignal({ ...newSignal, className: event.target.value })} /></FormField><FormField label="Signal kind"><select value={newSignal.kind} onChange={(event) => setNewSignal({ ...newSignal, kind: event.target.value as SignalKind })}>{['object_detected','object_in_roi','object_absent_from_roi','object_count','object_entered_roi','line_crossing_count','objects_near','pose_moving','zone_motion','zone_idle','line_crossing_rate','roi_color_match','object_orientation_match','object_size_check'].map((kind) => <option key={kind} value={kind}>{kind.replaceAll('_',' ')}</option>)}</select></FormField><FormField label="Zone"><select value={newSignal.zoneId} onChange={(event) => setNewSignal({ ...newSignal, zoneId: event.target.value })}><option value="">Full frame</option>{config.zones.map((zone) => <option key={zone.id} value={zone.id}>{zone.name}</option>)}</select></FormField><FormField label="Hold duration"><div className="input-suffix"><input min="0" type="number" value={newSignal.holdSeconds} onChange={(event) => setNewSignal({ ...newSignal, holdSeconds: Number(event.target.value) })} /><span>seconds</span></div></FormField></div><button className="primary" type="button" onClick={saveNewSignal}><Save size={15} /> Save signal</button></div>}</div>;
  else if (setupStep === 8) content = <div className="wizard-content"><div className="section-heading"><div><span className="eyebrow">STEP 9 OF 13</span><h2>Detection rules</h2><p>Use the complete shared rule library or edit this camera's selected rules.</p></div><button className="secondary" type="button" onClick={addRule}><Plus size={15} /> Create manually</button></div><div className="rule-card-list">{config.rules.map((rule) => <article className="builder-card" key={rule.id}><div className="rule-editor-head"><input value={rule.name} onChange={(event) => updateConfig((current) => ({ ...current, rules: current.rules.map((item) => item.id === rule.id ? { ...item, name: event.target.value } : item) }))} /><Pill tone={vision.frames[camera.id]?.rules.find((item) => item.ruleId === rule.id)?.active ? 'green' : 'neutral'}>{vision.frames[camera.id]?.rules.find((item) => item.ruleId === rule.id)?.active ? 'TRUE' : 'FALSE'}</Pill><button title="Delete rule" type="button" onClick={() => updateConfig((current) => ({ ...current, rules: current.rules.filter((item) => item.id !== rule.id) }))}><Trash2 size={14} /></button></div><div className="condition-row"><select value={rule.conditions[0]?.signalId} onChange={(event) => updateConfig((current) => ({ ...current, rules: current.rules.map((item) => item.id === rule.id ? { ...item, conditions: [{ ...(item.conditions[0] ?? { id: `condition-${Date.now()}`, operator: 'IS_ACTIVE' }), signalId: event.target.value }] } : item) }))}>{config.signals.map((signal) => <option key={signal.id} value={signal.id}>{signal.name}</option>)}</select><select value={rule.conditions[0]?.operator} onChange={(event) => updateConfig((current) => ({ ...current, rules: current.rules.map((item) => item.id === rule.id ? { ...item, conditions: [{ ...item.conditions[0], operator: event.target.value as RuleDefinition['conditions'][number]['operator'] }] } : item) }))}><option value="IS_ACTIVE">is active</option><option value="IS_NOT_ACTIVE">is not active</option><option value="GREATER_THAN">greater than</option><option value="LESS_THAN">less than</option><option value="EQUALS">equals</option><option value="STATE_CHANGE">state changed</option></select><input aria-label="Rule duration seconds" min="0" type="number" value={rule.forSeconds} onChange={(event) => updateConfig((current) => ({ ...current, rules: current.rules.map((item) => item.id === rule.id ? { ...item, forSeconds: Number(event.target.value) } : item) }))} /></div><small>THEN output <strong>{rule.output}</strong> after {rule.forSeconds}s</small></article>)}</div><div className="available-rule-library"><div className="section-heading"><div><h3>Available rule templates</h3><p>{builtInRuleTemplates.length} worker, machine, counting and safety rules.</p></div></div><div className="template-catalog">{builtInRuleTemplates.map((template) => { const added = config.rules.some((rule) => rule.id === template.id || rule.name === template.name); return <article key={template.id}><span><small>{template.category}</small><strong>{template.name}</strong><p>{template.description}</p></span><button className="secondary" disabled={added} type="button" onClick={() => addRuleTemplate(template)}>{added ? 'Added' : 'Add'}</button></article>; })}</div></div><div className="inline-status info"><Play size={16} /><span><strong>Live engine test</strong><small>Connect the feed, draw an ROI, then start this camera from Monitoring or the final step.</small></span></div></div>;
  else if (setupStep === 9) content = <BusinessRuleSetup cameraId={camera.id} />;
  else if (setupStep === 10) content = <div className="wizard-content"><div className="section-heading"><div><span className="eyebrow">STEP 11 OF 13</span><h2>Station mapping</h2><p>Define the lifecycle journey for the selected plant while preserving every existing station identity.</p></div></div><LifecycleStationSetup plantId={vision.selectedPlantId} /></div>;
  else if (setupStep === 11) content = <div className="wizard-content"><div className="section-heading"><div><span className="eyebrow">STEP 12 OF 13</span><h2>Automations</h2><p>Lifecycle notifications use configured station IDs. General rule automations remain separate below.</p></div></div><LifecycleAutomationSetup /><section className="panel general-automation-callout"><div><span>General and business-rule automations</span><p>Detection and business-rule alerts are managed separately and do not share lifecycle station triggers.</p></div><button className="secondary" type="button" onClick={() => setPage('automations')}>Open general automations <ArrowRight size={14} /></button></section></div>;
  else content = <div className="wizard-content"><div className="section-heading"><div><span className="eyebrow">STEP 13 OF 13</span><h2>Review and save</h2><p>The actual per-camera engine configuration is already stored locally and ready for testing.</p></div><Pill tone={saved ? 'green' : 'orange'}>{saved ? 'Saved' : 'Ready'}</Pill></div><div className="review-grid">{[['Camera', camera.name, `${camera.sourceStatus} · ${camera.sourceType}`], ['Models', String(config.selectedModelIds.length), config.selectedModelIds.join(' · ') || 'Direct-motion mode'], ['Zones', String(config.analysisRoiIds.length), config.zones.filter((zone) => zone.width > .5).map((zone) => zone.name).join(' · ') || 'Draw zones first'], ['Monitoring metrics', String(config.monitoringMetrics.length), config.monitoringMetrics.map((metric) => metric.label).join(' · ') || 'None selected'], ['Signals', String(config.signals.length), 'Reusable per-camera signal definitions'], ['Detection rules', String(config.rules.length), 'Evaluated by the OptiVision 2 worker'], ['Engine', vision.workerStatus, vision.workerDetail]].map(([label, value, detail], index) => <article key={label}><span>{index + 1}</span><div><small>{label}</small><strong>{value}</strong><p>{detail}</p></div></article>)}</div><div className="save-actions"><button className="primary large" type="button" onClick={() => setSaved(true)}><Save size={17} /> Save configuration</button><button className="secondary large" type="button" onClick={() => void vision.toggleEngine(camera.id)}>{vision.running[camera.id] ? <Pause size={16} /> : <Play size={16} />}{vision.running[camera.id] ? 'Pause this camera' : 'Start this camera'}</button>{plantCameras.length > 1 ? <button className="secondary large" type="button" onClick={() => { const currentIndex = plantCameras.findIndex((item) => item.id === camera.id); const nextCamera = plantCameras[(currentIndex + 1) % plantCameras.length]; vision.setActiveCameraId(nextCamera.id); setSaved(false); setSetupStep(1); }}><Camera size={16} /> Configure next camera</button> : null}</div>{camera.error ? <div className="inline-status info"><AlertTriangle size={16} /><span><strong>Engine requirement</strong><small>{camera.error}</small></span></div> : null}</div>;

  const showCameraSwitcher = plantCameras.length > 1 && setupStep >= 1 && setupStep <= 9;
  return <div className="wizard-page"><button className="back-link" type="button" onClick={() => setPage('cameras')}><ArrowLeft size={15} /> Cameras</button><div className="wizard-stepper">{wizardSteps.map((label, index) => <button className={setupStep === index ? 'active' : setupStep > index ? 'complete' : ''} type="button" key={label} onClick={() => setSetupStep(index)}><span>{setupStep > index ? <Check size={13} /> : index + 1}</span><small>{label}</small></button>)}</div><section className="panel wizard-shell" data-step={setupStep + 1}>{showCameraSwitcher ? <nav aria-label="Camera being configured" className="camera-setup-switcher"><span><Camera size={16} /><small>Configuring camera</small></span><div>{plantCameras.map((item, index) => <button aria-current={item.id === camera.id ? 'true' : undefined} className={item.id === camera.id ? 'active' : ''} key={item.id} onClick={() => vision.setActiveCameraId(item.id)} type="button"><b>{index + 1}</b>{item.name}{item.id === camera.id ? <Check size={13} /> : null}</button>)}</div></nav> : null}{content}<footer className="wizard-footer"><button className="secondary" type="button" disabled={setupStep === 0} onClick={() => setSetupStep(setupStep - 1)}><ArrowLeft size={15} /> Back</button><span>Step {setupStep + 1} of {wizardSteps.length}</span>{setupStep < wizardSteps.length - 1 ? <button className="primary" disabled={setupStep === 1 && !plantCameras.length} type="button" onClick={() => setSetupStep(setupStep + 1)}>Continue <ArrowRight size={15} /></button> : <button className="secondary" type="button" onClick={() => setPage('monitoring')}>Open monitoring</button>}</footer></section></div>;
}

function MonitoringMetricSetup({ cameraId }: { cameraId: string }) {
  const vision = useVision();
  const camera = vision.getCamera(cameraId);
  const selected = camera.configuration.monitoringMetrics;
  const options = ([
    { id: 'worker-present', label: 'Worker present', source: 'system', sourceId: 'worker_present', format: 'number' },
    { id: 'workers-working', label: 'Workers working', source: 'system', sourceId: 'workers_working', format: 'number' },
    { id: 'workers-idle', label: 'Workers idle', source: 'system', sourceId: 'workers_idle', format: 'number' },
    { id: 'output-count', label: 'Output count', source: 'system', sourceId: 'output_count', format: 'number' },
    { id: 'productivity', label: 'Productivity', source: 'system', sourceId: 'productivity', format: 'percent' },
    { id: 'machine-status', label: 'Machine status', source: 'system', sourceId: 'machine_status', format: 'status' },
    ...camera.configuration.signals.map((signal) => ({ id: `signal:${signal.id}`, label: signal.name, source: 'signal' as const, sourceId: signal.id, format: signal.kind.includes('count') || signal.kind.includes('rate') ? 'number' as const : 'status' as const })),
    ...camera.configuration.rules.map((rule) => ({ id: `rule:${rule.id}`, label: rule.name, source: 'rule' as const, sourceId: rule.id, format: 'status' as const })),
    ...camera.configuration.businessRules.map((rule) => ({ id: `business:${rule.id}`, label: rule.name, source: 'business' as const, sourceId: rule.id, format: rule.unit === 'percent' ? 'percent' as const : rule.unit === 'duration' ? 'duration' as const : 'number' as const }))
  ] satisfies CameraCardMetric[]).filter((option, index, all) => all.findIndex((item) => item.id === option.id) === index);
  const toggle = (metric: CameraCardMetric) => vision.updateConfiguration(cameraId, (current) => ({
    ...current,
    monitoringMetrics: current.monitoringMetrics.some((item) => item.id === metric.id)
      ? current.monitoringMetrics.filter((item) => item.id !== metric.id)
      : [...current.monitoringMetrics, metric]
  }));
  return <section className="monitoring-metric-setup panel"><div className="section-heading"><div><h3>User monitoring parameters</h3><p>Select the fields that should appear on this camera in User Monitoring. These choices are saved separately for each camera.</p></div><Pill tone="orange">{selected.length} shown</Pill></div><div className="metric-choice-grid">{options.map((metric) => { const active = selected.some((item) => item.id === metric.id); return <button className={active ? 'selected' : ''} type="button" key={metric.id} onClick={() => toggle(metric)}><span><strong>{metric.label}</strong><small>{metric.source} · {metric.format}</small></span>{active ? <Check size={15} /> : <Plus size={15} />}</button>; })}</div>{selected.length === 0 ? <div className="inline-status info"><AlertTriangle size={16} /><span><strong>No parameters selected</strong><small>This camera card will show a prompt to choose parameters instead of fixed placeholder values.</small></span></div> : null}</section>;
}

const businessMetricLabels: Record<BusinessMetricKey, string> = {
  active_seconds: 'Working time', presence_seconds: 'Presence time', running_seconds: 'Machine running time',
  observed_seconds: 'Observed time', output_count: 'Output count', idle_seconds: 'Idle time', absent_seconds: 'Absent time'
};

const businessTemplates: BusinessRuleDefinition[] = [
  { id: 'worker-productivity', name: 'Worker Productivity', numerator: 'active_seconds', denominator: 'presence_seconds', operation: 'DIVIDE_PERCENT', unit: 'percent', scope: 'shift' },
  { id: 'machine-utilization', name: 'Machine Utilization', numerator: 'running_seconds', denominator: 'observed_seconds', operation: 'DIVIDE_PERCENT', unit: 'percent', scope: 'shift' },
  { id: 'working-time', name: 'Working Time', numerator: 'active_seconds', operation: 'VALUE', unit: 'duration', scope: 'shift' },
  { id: 'presence-time', name: 'Presence Time', numerator: 'presence_seconds', operation: 'VALUE', unit: 'duration', scope: 'shift' },
  { id: 'idle-time', name: 'Idle Time', numerator: 'idle_seconds', operation: 'VALUE', unit: 'duration', scope: 'shift' },
  { id: 'absence-time', name: 'Absence Time', numerator: 'absent_seconds', operation: 'VALUE', unit: 'duration', scope: 'shift' },
  { id: 'machine-running-time', name: 'Machine Running Time', numerator: 'running_seconds', operation: 'VALUE', unit: 'duration', scope: 'shift' },
  { id: 'observed-time', name: 'Observed Time', numerator: 'observed_seconds', operation: 'VALUE', unit: 'duration', scope: 'shift' },
  { id: 'production-count', name: 'Production Count', numerator: 'output_count', operation: 'VALUE', unit: 'count', scope: 'shift' }
];

function scopedMetrics(vision: ReturnType<typeof useVision>, cameraId: string, scope: BusinessRuleDefinition['scope'] = 'session'): MetricTotals | undefined {
  const metrics = vision.metrics[cameraId];
  if (!metrics) return undefined;
  if (scope === 'shift') return metrics.shift;
  if (scope === 'day') return metrics.day;
  return metrics;
}

function businessMetricValue(key: BusinessMetricKey, vision: ReturnType<typeof useVision>, cameraId: string, scope: BusinessRuleDefinition['scope'] = 'session') {
  const metrics = scopedMetrics(vision, cameraId, scope);
  if (!metrics) return null;
  if (key === 'active_seconds') return metrics.activeSeconds;
  if (key === 'presence_seconds') return metrics.activeSeconds + metrics.idleSeconds;
  if (key === 'running_seconds') return metrics.uptimeSeconds;
  if (key === 'observed_seconds') return metrics.uptimeSeconds + metrics.downtimeSeconds;
  if (key === 'idle_seconds') return metrics.idleSeconds;
  if (key === 'absent_seconds') return metrics.absentSeconds;
  return metrics.outputCount;
}

function businessRuleResult(rule: BusinessRuleDefinition, vision: ReturnType<typeof useVision>, cameraId: string) {
  const scope = rule.scope ?? 'session';
  const numerator = businessMetricValue(rule.numerator, vision, cameraId, scope);
  if (numerator === null) return null;
  if (rule.operation === 'DIVIDE_PERCENT') {
    const denominator = rule.denominator ? businessMetricValue(rule.denominator, vision, cameraId, scope) : null;
    return denominator && denominator > 0 ? numerator / denominator * 100 : null;
  }
  const totals = scopedMetrics(vision, cameraId, scope);
  if (rule.numerator === 'output_count') return vision.metrics[cameraId]?.lastOutputValue === null ? null : numerator;
  if (['running_seconds', 'observed_seconds'].includes(rule.numerator) && !(totals && totals.uptimeSeconds + totals.downtimeSeconds > 0)) return null;
  if (['active_seconds', 'presence_seconds', 'idle_seconds', 'absent_seconds'].includes(rule.numerator) && !(totals && totals.activeSeconds + totals.idleSeconds + totals.absentSeconds > 0)) return null;
  return numerator;
}

function formatBusinessResult(rule: BusinessRuleDefinition, value: number | null) {
  if (value === null) return 'No data';
  if (rule.unit === 'percent') return `${Math.round(value)}%`;
  if (rule.unit === 'duration') return `${Math.floor(value / 3600)}h ${Math.floor(value % 3600 / 60)}m ${Math.floor(value % 60)}s`;
  return String(Math.round(value));
}

const operationalBindingLabels: Record<OperationalMetricBindingKey, string> = {
  workerPresent: 'Worker present',
  workerWorking: 'Worker working',
  workerIdle: 'Worker idle',
  workerAbsent: 'Worker absent',
  machineRunning: 'Machine running',
  machineStopped: 'Machine stopped',
  outputCount: 'Output count'
};

function bindingSelectValue(binding: MetricSourceBinding | null) {
  return binding ? `${binding.source}:${binding.sourceId}` : '';
}

function OperationalMetricSourceSetup({ cameraId }: { cameraId: string }) {
  const vision = useVision();
  const camera = vision.getCamera(cameraId);
  const frame = vision.frames[cameraId];
  const metrics = vision.metrics[cameraId];
  const operational = camera.configuration.operationalMetrics;
  const bindingKeys = Object.keys(operationalBindingLabels) as OperationalMetricBindingKey[];
  const update = (next: typeof operational) => vision.updateConfiguration(cameraId, (current) => ({ ...current, operationalMetrics: next }));
  const setBinding = (key: OperationalMetricBindingKey, value: string) => {
    const separator = value.indexOf(':');
    const binding = separator > 0
      ? { source: value.slice(0, separator) as MetricSourceBinding['source'], sourceId: value.slice(separator + 1) }
      : null;
    update({ ...operational, bindings: { ...operational.bindings, [key]: binding } });
  };
  const shiftStart = `${String(Math.floor(operational.shift.startMinuteOfDay / 60)).padStart(2, '0')}:${String(operational.shift.startMinuteOfDay % 60).padStart(2, '0')}`;
  const liveState = (key: OperationalMetricBindingKey) => frame
    ? resolveMetricBinding(operational.bindings[key], frame).state.toUpperCase()
    : 'UNKNOWN';
  const formatDuration = (seconds: number) => `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
  return <section className="panel operational-metric-setup"><div className="section-heading"><div><span className="eyebrow">OPERATIONAL METRIC SOURCES</span><h3>Connect business metrics to real camera intelligence</h3><p>Choose the signal or detection rule that proves each state. Missing or conflicting evidence remains Unknown.</p></div><Pill tone={metrics && (metrics.workerState !== 'unknown' || metrics.machineState !== 'unknown') ? 'green' : 'neutral'}>{metrics ? `Worker ${metrics.workerState} · Machine ${metrics.machineState}` : 'No analyzed data'}</Pill></div><div className="operational-binding-grid">{bindingKeys.map((key) => <label key={key}><span><strong>{operationalBindingLabels[key]}</strong><small>{liveState(key)}</small></span><select aria-label={`${operationalBindingLabels[key]} source`} value={bindingSelectValue(operational.bindings[key])} onChange={(event) => setBinding(key, event.target.value)}><option value="">Not configured — Unknown</option><optgroup label="Signals">{camera.configuration.signals.map((signal) => <option key={`signal:${signal.id}`} value={`signal:${signal.id}`}>{signal.name}</option>)}</optgroup><optgroup label="Detection rules">{camera.configuration.rules.map((rule) => <option key={`rule:${rule.id}`} value={`rule:${rule.id}`}>{rule.name}</option>)}</optgroup></select></label>)}</div><div className="shift-configuration"><FormField label="Shift starts"><input type="time" value={shiftStart} onChange={(event) => { const [hours, minutes] = event.target.value.split(':').map(Number); update({ ...operational, shift: { ...operational.shift, startMinuteOfDay: hours * 60 + minutes } }); }} /></FormField><FormField label="Shift length"><select value={operational.shift.durationMinutes} onChange={(event) => update({ ...operational, shift: { ...operational.shift, durationMinutes: Number(event.target.value) } })}><option value={360}>6 hours</option><option value={480}>8 hours</option><option value={720}>12 hours</option><option value={1440}>24 hours</option></select></FormField><div><small>Current shift</small><strong>{metrics ? `${formatDuration(metrics.shift.activeSeconds)} working · ${formatDuration(metrics.shift.idleSeconds)} idle` : 'No data'}</strong></div><div><small>Today</small><strong>{metrics ? `${formatDuration(metrics.day.activeSeconds)} working · ${metrics.day.outputCount} output` : 'No data'}</strong></div></div></section>;
}

function BusinessRuleSetup({ cameraId, master = false }: { cameraId: string; master?: boolean }) {
  const vision = useVision();
  const camera = vision.getCamera(cameraId);
  const [mode, setMode] = useState<'closed' | 'templates' | 'manual'>('closed');
  const [draft, setDraft] = useState<BusinessRuleDefinition>({ id: '', name: '', numerator: 'active_seconds', denominator: 'presence_seconds', operation: 'DIVIDE_PERCENT', unit: 'percent', scope: 'shift' });
  const updateRules = (rules: BusinessRuleDefinition[]) => vision.updateConfiguration(camera.id, (current) => ({ ...current, businessRules: rules }));
  const addTemplate = (template: BusinessRuleDefinition) => { if (!camera.configuration.businessRules.some((rule) => rule.id === template.id)) updateRules([...camera.configuration.businessRules, { ...template }]); setMode('closed'); };
  const saveManual = () => { const id = `business-${Date.now()}`; updateRules([...camera.configuration.businessRules, { ...draft, id, name: draft.name.trim() || 'Custom Business Rule', denominator: draft.operation === 'DIVIDE_PERCENT' ? draft.denominator : undefined }]); setMode('closed'); };
  return <div className={master ? 'page-stack' : 'wizard-content'}>
    <div className={master ? 'page-title' : 'section-heading'}><div><span className="eyebrow">{master ? 'SETUP / BUSINESS RULES' : 'STEP 8 OF 10'}</span><h2>{master ? 'Business rules' : 'Business rule setup'}</h2><p>Live values are calculated from this camera's actual session metrics and conveyor count.</p></div><div className="definition-actions">{master ? <select value={vision.activeCameraId} onChange={(event) => vision.setActiveCameraId(event.target.value)}>{vision.cameras.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select> : null}<button className="primary" type="button" onClick={() => setMode(mode === 'closed' ? 'templates' : 'closed')}><Plus size={15} /> Add business rule</button></div></div>
    <OperationalMetricSourceSetup cameraId={camera.id} />
    {mode !== 'closed' ? <section className="panel compact-builder"><div className="segmented"><button className={mode === 'templates' ? 'active' : ''} type="button" onClick={() => setMode('templates')}>Templates</button><button className={mode === 'manual' ? 'active' : ''} type="button" onClick={() => setMode('manual')}>Create manually</button></div>{mode === 'templates' ? <div className="template-catalog">{businessTemplates.map((template) => <article key={template.id}><span><small>{template.unit.toUpperCase()} · {(template.scope ?? 'session').toUpperCase()}</small><strong>{template.name}</strong><p>{businessMetricLabels[template.numerator]}{template.denominator ? ` / ${businessMetricLabels[template.denominator]} × 100` : ''}</p></span><button className="secondary" disabled={camera.configuration.businessRules.some((rule) => rule.id === template.id)} type="button" onClick={() => addTemplate(template)}>{camera.configuration.businessRules.some((rule) => rule.id === template.id) ? 'Added' : 'Use template'}</button></article>)}</div> : <><div className="form-grid"><FormField label="Rule name"><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></FormField><FormField label="Time window"><select value={draft.scope ?? 'session'} onChange={(event) => setDraft({ ...draft, scope: event.target.value as BusinessRuleDefinition['scope'] })}><option value="session">Current session</option><option value="shift">Current shift</option><option value="day">Today</option></select></FormField><FormField label="Calculation"><select value={draft.operation} onChange={(event) => { const operation = event.target.value as BusinessRuleDefinition['operation']; setDraft({ ...draft, operation, unit: operation === 'DIVIDE_PERCENT' ? 'percent' : draft.unit }); }}><option value="DIVIDE_PERCENT">Percentage (A / B × 100)</option><option value="VALUE">Direct value</option></select></FormField><FormField label="Input A"><select value={draft.numerator} onChange={(event) => setDraft({ ...draft, numerator: event.target.value as BusinessMetricKey })}>{Object.entries(businessMetricLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></FormField>{draft.operation === 'DIVIDE_PERCENT' ? <FormField label="Input B"><select value={draft.denominator} onChange={(event) => setDraft({ ...draft, denominator: event.target.value as BusinessMetricKey })}>{Object.entries(businessMetricLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></FormField> : <FormField label="Unit"><select value={draft.unit} onChange={(event) => setDraft({ ...draft, unit: event.target.value as BusinessRuleDefinition['unit'] })}><option value="duration">Duration</option><option value="count">Count</option></select></FormField>}</div><button className="primary" type="button" onClick={saveManual}><Save size={15} /> Save business rule</button></>}</section> : null}
    <section className="panel table-panel"><div className="definition-head business-definition-head"><span>Name</span><span>Formula</span><span>Window</span><span>Live result</span><span>Actions</span></div>{camera.configuration.businessRules.map((rule) => <div className="definition-row business-definition-row" key={rule.id}><strong>{rule.name}</strong><span>{businessMetricLabels[rule.numerator]}{rule.denominator ? ` / ${businessMetricLabels[rule.denominator]} × 100` : ''}</span><select aria-label={`${rule.name} time window`} value={rule.scope ?? 'session'} onChange={(event) => updateRules(camera.configuration.businessRules.map((item) => item.id === rule.id ? { ...item, scope: event.target.value as BusinessRuleDefinition['scope'] } : item))}><option value="session">Session</option><option value="shift">Shift</option><option value="day">Today</option></select><Pill tone={businessRuleResult(rule, vision, camera.id) === null ? 'neutral' : 'orange'}>{formatBusinessResult(rule, businessRuleResult(rule, vision, camera.id))}</Pill><div className="table-actions"><button title="Duplicate" type="button" onClick={() => updateRules([...camera.configuration.businessRules, { ...rule, id: `${rule.id}-copy-${Date.now()}`, name: `${rule.name} Copy` }])}><Copy size={14} /></button><button title="Delete" type="button" onClick={() => updateRules(camera.configuration.businessRules.filter((item) => item.id !== rule.id))}><Trash2 size={14} /></button></div></div>)}</section>
  </div>;
}

function BusinessRulesPage() {
  const vision = useVision();
  return <BusinessRuleSetup cameraId={vision.activeCameraId} master />;
}

function LegacyAutomationStep() {
  return <div className="wizard-content"><div className="section-heading"><div><span className="eyebrow">STEP 9 OF 10</span><h2>Automations</h2><p>Trigger configured email, WhatsApp, or in-system actions from detection or business rules.</p></div></div><div className="builder-card automation-builder"><FormField label="Automation name"><input defaultValue="Low productivity alert" /></FormField><span className="logic-token if">IF</span><div className="automation-condition"><select><option>Detection Rule</option><option>Business Rule</option></select><select><option>Worker Idle</option><option>Machine Stopped</option></select><select><option>is active</option><option>is below</option></select><input defaultValue="10 minutes" /></div><span className="logic-token then">THEN</span><div className="action-grid"><label><input type="checkbox" defaultChecked /><span><Mail size={18} /><strong>Email</strong><small>SMTP</small></span></label><label><input type="checkbox" /><span><MessageCircle size={18} /><strong>WhatsApp</strong><small>Business API</small></span></label><label><input type="checkbox" defaultChecked /><span><Bell size={18} /><strong>In-system</strong><small>Available</small></span></label></div></div></div>;
}

function TableActions() {
  return <div className="table-actions"><button title="View" type="button"><Eye size={14} /></button><button title="Edit" type="button"><Edit3 size={14} /></button><button title="Duplicate" type="button"><Copy size={14} /></button><button title="Disable" type="button"><Pause size={14} /></button><button title="Delete" type="button"><Trash2 size={14} /></button></div>;
}

function LegacyCamerasPage({ setPage }: { setPage: (page: Page) => void }) {
  return <div className="page-stack"><div className="page-title"><div><span className="eyebrow">SETUP / CAMERAS</span><h2>Configured cameras</h2><p>Manage sources, status, configuration, and live access.</p></div><button className="primary" type="button" onClick={() => setPage('add-camera')}><Plus size={16} /> Add camera</button></div><section className="camera-admin-grid">{cameraCards.map((camera, index) => <article className="panel camera-admin-card" key={camera.name}><div className="camera-card-preview"><EmptyFeed compact /><Pill tone={index === 2 ? 'red' : 'green'}>{camera.status}</Pill></div><div className="camera-card-title"><span><strong>{camera.name}</strong><small><MapPin size={12} /> {camera.location}</small></span><button type="button"><MoreHorizontal size={18} /></button></div><div className="camera-admin-stats"><span><small>Model</small><strong>{index === 2 ? 'Motion Detection' : 'YOLO26n'}</strong></span><span><small>Zones</small><strong>{index + 2}</strong></span><span><small>Signals</small><strong>{index + 4}</strong></span><span><small>Rules</small><strong>{index + 3}</strong></span></div><footer><button className="secondary" type="button" onClick={() => setPage('add-camera')}><Settings2 size={15} /> Configure</button><button className="ghost" type="button" onClick={() => setPage('camera-detail')}>Open feed <ArrowRight size={14} /></button></footer></article>)}</section></div>;
}

function CamerasPage({ setPage }: { setPage: (page: Page) => void }) {
  const vision = useVision();
  return <div className="page-stack"><div className="page-title"><div><span className="eyebrow">SETUP / CAMERAS</span><h2>Configured cameras</h2><p>Each camera has independent source, model, ROI, signals, rules, and Start/Pause state.</p></div><button className="primary" disabled={vision.cameras.length >= 7} type="button" onClick={() => { const id = vision.addCamera(); if (id) setPage('add-camera'); }}><Plus size={16} /> Add camera</button></div><section className="camera-admin-grid">{vision.cameras.map((camera) => { const frame = vision.frames[camera.id]; const activeSignals = frame?.signals.filter((signal) => signal.active).length ?? 0; const activeRules = frame?.rules.filter((rule) => rule.active).length ?? 0; return <article className="panel camera-admin-card" key={camera.id}><div className="camera-card-preview"><EmptyFeed compact cameraId={camera.id} /><Pill tone={camera.sourceStatus === 'ready' ? 'green' : camera.sourceStatus === 'error' ? 'red' : 'neutral'}>{vision.running[camera.id] ? 'Detecting' : camera.sourceStatus === 'ready' ? 'Ready' : camera.sourceStatus === 'error' ? 'Error' : 'Not connected'}</Pill></div><div className="camera-card-title"><span><strong>{camera.name}</strong><small><MapPin size={12} /> {camera.location} · {camera.department}</small></span><button type="button"><MoreHorizontal size={18} /></button></div><div className="camera-admin-stats"><span><small>Models</small><strong>{camera.configuration.selectedModelIds.length || 'Direct'}</strong></span><span><small>Active ROI</small><strong>{camera.configuration.analysisRoiIds.length}</strong></span><span><small>Signals</small><strong>{activeSignals}/{camera.configuration.signals.length}</strong></span><span><small>Rules</small><strong>{activeRules}/{camera.configuration.rules.length}</strong></span></div>{camera.error ? <p className="camera-error-copy">{camera.error}</p> : null}<footer><button className="secondary" type="button" onClick={() => { vision.setActiveCameraId(camera.id); setPage('add-camera'); }}><Settings2 size={15} /> Configure</button><button className="ghost" type="button" onClick={() => { vision.setActiveCameraId(camera.id); setPage('camera-detail'); }}>Open feed <ArrowRight size={14} /></button><button className="ghost" disabled={camera.sourceStatus !== 'ready'} type="button" onClick={() => void vision.toggleEngine(camera.id)}>{vision.running[camera.id] ? <Pause size={14} /> : <Play size={14} />}{vision.running[camera.id] ? 'Pause' : 'Start'}</button></footer></article>; })}</section></div>;
}

function LegacyDefinitionsPage({ type }: { type: 'signals' | 'detection-rules' | 'business-rules' }) {
  const config = type === 'signals'
    ? { title: 'Manage signals', subtitle: 'Reusable answers to: What is happening in the camera feed?', rows: signalRows, headers: ['Name', 'Type', 'Camera', 'Zone', 'Model', 'Status'] }
    : type === 'detection-rules'
      ? { title: 'Manage detection rules', subtitle: 'Configurable meaning created from one or more detection signals.', rows: detectionRuleRows, headers: ['Rule name', 'Signals used', 'Camera', 'Zone', 'Current status', 'Last triggered'] }
      : { title: 'Manage business rules', subtitle: 'Calculated business values built from detection and business rules.', rows: businessRuleRows, headers: ['Rule name', 'Formula', 'Camera', 'Current value', 'Unit'] };
  const [builder, setBuilder] = useState(false);
  return <div className="page-stack"><div className="page-title"><div><span className="eyebrow">SETUP / {config.title.toUpperCase()}</span><h2>{config.title}</h2><p>{config.subtitle}</p></div><button className="primary" type="button" onClick={() => setBuilder(!builder)}><Plus size={16} /> Create {type === 'signals' ? 'signal' : 'rule'}</button></div>{builder && <section className="panel compact-builder"><div className="section-heading"><div><h3>{type === 'signals' ? 'Create signal' : type === 'detection-rules' ? 'Create detection rule' : 'Create business rule'}</h3><p>Use the same no-code builder available during camera setup.</p></div><button className="icon-button" type="button" onClick={() => setBuilder(false)}><X size={17} /></button></div><div className="form-grid"><FormField label="Name"><input placeholder="Enter a clear name" /></FormField><FormField label="Camera"><select><option>Assembly Line 01</option><option>Packaging Line 02</option></select></FormField><FormField label={type === 'signals' ? 'Detection capability' : 'Input rule'}><select><option>{type === 'signals' ? 'Person present' : 'Worker Present'}</option><option>Machine Running</option></select></FormField><FormField label={type === 'business-rules' ? 'Aggregation' : 'Duration'}><select><option>{type === 'business-rules' ? 'SUM' : '5 seconds'}</option><option>{type === 'business-rules' ? 'AVERAGE' : '10 seconds'}</option></select></FormField></div><button className="primary" type="button"><Save size={15} /> Save</button></section>}<section className="panel table-panel"><div className="table-toolbar"><label className="search"><Search size={15} /><input placeholder="Search" /></label><select><option>All cameras</option><option>Assembly Line 01</option></select><select><option>All statuses</option><option>Active</option><option>Disabled</option></select></div><div className="data-table" style={{ ['--columns' as string]: config.headers.length }}>{config.headers.map((header) => <strong className="table-head" key={header}>{header}</strong>)}<strong className="table-head">Actions</strong>{config.rows.flatMap((row, rowIndex) => [row.map((cell, index) => <span key={`${rowIndex}-${index}`}>{index === row.length - 1 && (cell === 'Active' || cell === 'TRUE') ? <Pill tone="green">{cell}</Pill> : index === row.length - 1 && (cell === 'Disabled' || cell === 'FALSE') ? <Pill tone="neutral">{cell}</Pill> : cell}</span>), <TableActions key={`actions-${rowIndex}`} />])}</div></section></div>;
}

function DefinitionsPage({ type }: { type: 'signals' | 'detection-rules' | 'business-rules' }) {
  const vision = useVision();
  const camera = vision.getCamera();
  const config = camera.configuration;
  const [builder, setBuilder] = useState(false);
  const [signalDraft, setSignalDraft] = useState({ name: '', kind: 'object_in_roi' as SignalKind, className: 'person', zoneId: config.zones[0]?.id ?? '', confidence: .35 });
  const [ruleDraft, setRuleDraft] = useState({ name: '', signalId: config.signals[0]?.id ?? '', operator: 'IS_ACTIVE' as RuleDefinition['conditions'][number]['operator'], forSeconds: 0 });
  if (type === 'business-rules') return <BusinessRulesPage />;
  const isSignal = type === 'signals';
  function updateConfig(update: (current: typeof config) => typeof config) { vision.updateConfiguration(camera.id, update); }
  function saveDefinition() {
    if (isSignal) {
      const signal: SignalDefinition = { id: `signal-${Date.now()}`, name: signalDraft.name.trim() || 'New Signal', kind: signalDraft.kind, className: signalDraft.className.trim() || 'person', sourceTask: signalDraft.kind === 'pose_moving' ? 'pose' : 'detect', confidence: signalDraft.confidence, zoneId: signalDraft.zoneId || undefined };
      updateConfig((current) => ({ ...current, signals: [...current.signals, signal] }));
    } else {
      const rule: RuleDefinition = { id: `rule-${Date.now()}`, name: ruleDraft.name.trim() || 'New Rule', output: (ruleDraft.name.trim() || 'NEW_RULE').toUpperCase().replaceAll(/[^A-Z0-9]+/g, '_'), combinator: 'AND', forSeconds: ruleDraft.forSeconds, conditions: [{ id: `condition-${Date.now()}`, signalId: ruleDraft.signalId, operator: ruleDraft.operator }] };
      updateConfig((current) => ({ ...current, rules: [...current.rules, rule] }));
    }
    setBuilder(false);
  }
  return <div className="page-stack"><div className="page-title"><div><span className="eyebrow">SETUP / {isSignal ? 'MANAGE SIGNALS' : 'DETECTION RULES'}</span><h2>{isSignal ? 'Manage signals' : 'Manage detection rules'}</h2><p>{isSignal ? 'Reusable answers to: What is happening in the camera feed?' : 'Configurable meaning created from live detection signals.'}</p></div><div className="definition-actions"><select value={vision.activeCameraId} onChange={(event) => vision.setActiveCameraId(event.target.value)}>{vision.cameras.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select><button className="primary" type="button" onClick={() => setBuilder(!builder)}><Plus size={16} /> Create {isSignal ? 'signal' : 'rule'}</button></div></div>{builder ? <section className="panel compact-builder"><div className="section-heading"><div><h3>{isSignal ? 'Create signal' : 'Create detection rule'}</h3><p>Saved definitions belong only to {camera.name}.</p></div><button className="icon-button" type="button" onClick={() => setBuilder(false)}><X size={17} /></button></div>{isSignal ? <div className="form-grid"><FormField label="Name"><input value={signalDraft.name} onChange={(event) => setSignalDraft({ ...signalDraft, name: event.target.value })} /></FormField><FormField label="Signal kind"><select value={signalDraft.kind} onChange={(event) => setSignalDraft({ ...signalDraft, kind: event.target.value as SignalKind })}>{['object_detected','object_in_roi','object_absent_from_roi','object_count','object_entered_roi','line_crossing_count','objects_near','pose_moving','zone_motion','zone_idle','line_crossing_rate','roi_color_match','object_orientation_match','object_size_check'].map((kind) => <option value={kind} key={kind}>{kind.replaceAll('_',' ')}</option>)}</select></FormField><FormField label="Object class"><input value={signalDraft.className} onChange={(event) => setSignalDraft({ ...signalDraft, className: event.target.value })} /></FormField><FormField label="ROI / Zone"><select value={signalDraft.zoneId} onChange={(event) => setSignalDraft({ ...signalDraft, zoneId: event.target.value })}><option value="">Full frame</option>{config.zones.map((zone) => <option value={zone.id} key={zone.id}>{zone.name}</option>)}</select></FormField><FormField label="Confidence"><input min="0.01" max="1" step="0.01" type="number" value={signalDraft.confidence} onChange={(event) => setSignalDraft({ ...signalDraft, confidence: Number(event.target.value) })} /></FormField></div> : <div className="form-grid"><FormField label="Rule name"><input value={ruleDraft.name} onChange={(event) => setRuleDraft({ ...ruleDraft, name: event.target.value })} /></FormField><FormField label="Signal"><select value={ruleDraft.signalId} onChange={(event) => setRuleDraft({ ...ruleDraft, signalId: event.target.value })}>{config.signals.map((signal) => <option value={signal.id} key={signal.id}>{signal.name}</option>)}</select></FormField><FormField label="Operator"><select value={ruleDraft.operator} onChange={(event) => setRuleDraft({ ...ruleDraft, operator: event.target.value as typeof ruleDraft.operator })}><option value="IS_ACTIVE">is active</option><option value="IS_NOT_ACTIVE">is not active</option><option value="GREATER_THAN">greater than</option><option value="LESS_THAN">less than</option><option value="EQUALS">equals</option><option value="STATE_CHANGE">state changed</option></select></FormField><FormField label="For duration"><div className="input-suffix"><input min="0" type="number" value={ruleDraft.forSeconds} onChange={(event) => setRuleDraft({ ...ruleDraft, forSeconds: Number(event.target.value) })} /><span>seconds</span></div></FormField></div>}<button className="primary" type="button" onClick={saveDefinition}><Save size={15} /> Save</button></section> : null}<section className="panel table-panel"><div className="table-toolbar"><label className="search"><Search size={15} /><input placeholder="Search" /></label><Pill tone={vision.running[camera.id] ? 'green' : 'neutral'}>{vision.running[camera.id] ? 'Live evaluation' : 'Engine paused'}</Pill></div><div className={`engine-definition-table ${isSignal ? 'signals' : 'rules'}`}><div className="definition-head"><span>Name</span><span>{isSignal ? 'Kind / Class' : 'Signal logic'}</span><span>ROI / Duration</span><span>Live state</span><span>Actions</span></div>{isSignal ? config.signals.map((signal) => { const state = vision.frames[camera.id]?.signals.find((item) => item.signalId === signal.id); const zone = config.zones.find((item) => item.id === signal.zoneId); return <div className="definition-row" key={signal.id}><strong>{signal.name}</strong><span>{signal.kind.replaceAll('_',' ')} · {signal.className}</span><span>{zone?.name ?? 'Full frame'}</span><Pill tone={state?.active ? 'green' : 'neutral'}>{state?.active ? `${state.value}` : 'FALSE'}</Pill><div className="table-actions"><button type="button" onClick={() => updateConfig((current) => ({ ...current, signals: [...current.signals, { ...signal, id: `${signal.id}-copy-${Date.now()}`, name: `${signal.name} Copy` }] }))}><Copy size={14} /></button><button type="button" onClick={() => updateConfig((current) => ({ ...current, signals: current.signals.filter((item) => item.id !== signal.id), rules: current.rules.filter((rule) => rule.conditions.every((condition) => condition.signalId !== signal.id)) }))}><Trash2 size={14} /></button></div></div>; }) : config.rules.map((rule) => { const state = vision.frames[camera.id]?.rules.find((item) => item.ruleId === rule.id); return <div className="definition-row" key={rule.id}><strong>{rule.name}</strong><span>{rule.conditions.map((condition) => config.signals.find((signal) => signal.id === condition.signalId)?.name ?? condition.signalId).join(` ${rule.combinator} `)}</span><span>{rule.forSeconds}s</span><Pill tone={state?.active ? 'green' : 'neutral'}>{state?.active ? 'TRUE' : 'FALSE'}</Pill><div className="table-actions"><button type="button" onClick={() => updateConfig((current) => ({ ...current, rules: [...current.rules, { ...rule, id: `${rule.id}-copy-${Date.now()}`, name: `${rule.name} Copy`, conditions: rule.conditions.map((condition) => ({ ...condition, id: `${condition.id}-copy` })) }] }))}><Copy size={14} /></button><button type="button" onClick={() => updateConfig((current) => ({ ...current, rules: current.rules.filter((item) => item.id !== rule.id) }))}><Trash2 size={14} /></button></div></div>; })}</div></section></div>;
}

type DefinitionBuilderMode = 'closed' | 'choice' | 'manual' | 'templates';
type SavedRuleTemplate = {
  id: string;
  name: string;
  description: string;
  rule: RuleDefinition;
  signals: SignalDefinition[];
};

const savedSignalTemplateKey = 'optivision-user-signal-templates-v1';
const savedRuleTemplateKey = 'optivision-user-rule-templates-v1';

function readSavedTemplates<T>(key: string): T[] {
  return readStoredJson<T[]>(key, [], isArray<T>);
}

function uniqueDefinitionId(base: string, used: Set<string>) {
  if (!used.has(base)) return base;
  return `${base}-${Date.now()}`;
}

function DefinitionsPageV2({ type }: { type: 'signals' | 'detection-rules' | 'business-rules' }) {
  const vision = useVision();
  const camera = vision.getCamera();
  const config = camera.configuration;
  const [mode, setMode] = useState<DefinitionBuilderMode>('closed');
  const [search, setSearch] = useState('');
  const [notice, setNotice] = useState('');
  const [savedSignals, setSavedSignals] = useState<SignalTemplate[]>(() => readSavedTemplates<SignalTemplate>(savedSignalTemplateKey));
  const [savedRules, setSavedRules] = useState<SavedRuleTemplate[]>(() => readSavedTemplates<SavedRuleTemplate>(savedRuleTemplateKey));
  const [signalDraft, setSignalDraft] = useState({ name: '', kind: 'object_in_roi' as SignalKind, className: 'person', secondaryClass: 'cell phone', zoneId: config.zones[0]?.id ?? '', confidence: .35 });
  const [ruleDraft, setRuleDraft] = useState({ name: '', signalId: config.signals[0]?.id ?? '', operator: 'IS_ACTIVE' as RuleDefinition['conditions'][number]['operator'], value: 1, forSeconds: 0 });
  if (type === 'business-rules') return <BusinessRulesPage />;
  const isSignal = type === 'signals';
  const classOptions = [...new Set(vision.models.flatMap((model) => model.classes))].sort();
  const updateConfig = (update: (current: typeof config) => typeof config) => vision.updateConfiguration(camera.id, update);

  function saveManual() {
    if (isSignal) {
      const signal: SignalDefinition = {
        id: `signal-${Date.now()}`,
        name: signalDraft.name.trim() || 'New Signal',
        kind: signalDraft.kind,
        className: signalDraft.className.trim() || 'person',
        secondaryClass: signalDraft.kind === 'objects_near' ? signalDraft.secondaryClass.trim() : undefined,
        sourceTask: signalDraft.kind === 'pose_moving' ? 'pose' : 'detect',
        confidence: signalDraft.confidence,
        zoneId: signalDraft.zoneId || undefined,
        lineId: signalDraft.kind === 'line_crossing_count' || signalDraft.kind === 'line_crossing_rate' ? 'conveyor-line' : undefined
      };
      updateConfig((current) => ({ ...current, signals: [...current.signals, signal] }));
    } else {
      const rule: RuleDefinition = {
        id: `rule-${Date.now()}`,
        name: ruleDraft.name.trim() || 'New Rule',
        output: (ruleDraft.name.trim() || 'NEW_RULE').toUpperCase().replaceAll(/[^A-Z0-9]+/g, '_'),
        combinator: 'AND',
        forSeconds: Math.max(0, ruleDraft.forSeconds),
        conditions: [{ id: `condition-${Date.now()}`, signalId: ruleDraft.signalId, operator: ruleDraft.operator, value: ['GREATER_THAN', 'LESS_THAN', 'EQUALS'].includes(ruleDraft.operator) ? ruleDraft.value : undefined }]
      };
      updateConfig((current) => ({ ...current, rules: [...current.rules, rule] }));
    }
    setNotice(`${isSignal ? 'Signal' : 'Rule'} saved for ${camera.name}.`);
    setMode('closed');
  }

  function addSignalTemplate(template: SignalTemplate) {
    updateConfig((current) => {
      if (current.signals.some((signal) => signal.id === template.id || signal.name === template.definition.name)) return current;
      const id = uniqueDefinitionId(template.id, new Set(current.signals.map((signal) => signal.id)));
      return { ...current, signals: [...current.signals, createSignalFromTemplate(template, current.zones, id)] };
    });
    setNotice(`${template.name} added to ${camera.name}.`);
    setMode('closed');
  }

  function addBuiltInRule(template: RuleTemplate) {
    updateConfig((current) => {
      const nextSignals = [...current.signals];
      const usedSignalIds = new Set(nextSignals.map((signal) => signal.id));
      const signalIdByTemplate = new Map<string, string>();
      template.conditions.forEach((condition) => {
        const seed = builtInSignalTemplates.find((item) => item.id === condition.signalTemplateId);
        if (!seed) return;
        const existing = nextSignals.find((signal) => signal.id === seed.id || signal.name === seed.definition.name);
        if (existing) signalIdByTemplate.set(seed.id, existing.id);
        else {
          const id = uniqueDefinitionId(seed.id, usedSignalIds); usedSignalIds.add(id);
          nextSignals.push(createSignalFromTemplate(seed, current.zones, id));
          signalIdByTemplate.set(seed.id, id);
        }
      });
      const id = uniqueDefinitionId(template.id, new Set(current.rules.map((rule) => rule.id)));
      const ruleDefinition: RuleDefinition = {
        id, name: template.name, output: template.output, combinator: template.combinator, forSeconds: template.forSeconds,
        conditions: template.conditions.map((condition, index) => ({ id: `${id}-condition-${index + 1}`, signalId: signalIdByTemplate.get(condition.signalTemplateId) ?? condition.signalTemplateId, operator: condition.operator, value: condition.value }))
      };
      return { ...current, signals: nextSignals, rules: [...current.rules, ruleDefinition] };
    });
    setNotice(`${template.name} and its required signals were added to ${camera.name}.`);
    setMode('closed');
  }

  function addSavedRule(template: SavedRuleTemplate) {
    updateConfig((current) => {
      const nextSignals = [...current.signals];
      const mapping = new Map<string, string>();
      const usedIds = new Set(nextSignals.map((signal) => signal.id));
      template.signals.forEach((signal) => {
        const existing = nextSignals.find((item) => item.name === signal.name);
        if (existing) mapping.set(signal.id, existing.id);
        else { const id = uniqueDefinitionId(signal.id, usedIds); usedIds.add(id); nextSignals.push({ ...signal, id }); mapping.set(signal.id, id); }
      });
      const id = uniqueDefinitionId(template.rule.id, new Set(current.rules.map((rule) => rule.id)));
      return { ...current, signals: nextSignals, rules: [...current.rules, { ...template.rule, id, conditions: template.rule.conditions.map((condition, index) => ({ ...condition, id: `${id}-condition-${index + 1}`, signalId: mapping.get(condition.signalId) ?? condition.signalId })) }] };
    });
    setNotice(`${template.name} restored from your reusable templates.`);
    setMode('closed');
  }

  function saveSignalAsTemplate(signal: SignalDefinition) {
    const zoneKind = config.zones.find((zone) => zone.id === signal.zoneId)?.kind;
    const { id: _id, zoneId: _zoneId, ...definition } = signal;
    const template: SignalTemplate = { id: `saved-signal-${Date.now()}`, name: signal.name, category: 'General', description: `Saved from ${camera.name}.`, definition: { ...definition, zoneKind } };
    const next = [...savedSignals, template]; setSavedSignals(next); writeStoredJson(savedSignalTemplateKey, next); setNotice(`${signal.name} saved as a reusable template.`);
  }

  function saveRuleAsTemplate(rule: RuleDefinition) {
    const signals = rule.conditions.map((condition) => config.signals.find((signal) => signal.id === condition.signalId)).filter((signal): signal is SignalDefinition => Boolean(signal));
    const template: SavedRuleTemplate = { id: `saved-rule-${Date.now()}`, name: rule.name, description: `Saved from ${camera.name}.`, rule: { ...rule, id: `saved-${rule.id}` }, signals };
    const next = [...savedRules, template]; setSavedRules(next); writeStoredJson(savedRuleTemplateKey, next); setNotice(`${rule.name} saved as a reusable template.`);
  }

  const visibleSignals = [...builtInSignalTemplates, ...savedSignals].filter((template) => `${template.name} ${template.category} ${template.description}`.toLowerCase().includes(search.toLowerCase()));
  const visibleRules = builtInRuleTemplates.filter((template) => `${template.name} ${template.category} ${template.description}`.toLowerCase().includes(search.toLowerCase()));
  const visibleSavedRules = savedRules.filter((template) => `${template.name} ${template.description}`.toLowerCase().includes(search.toLowerCase()));

  return <div className="page-stack">
    <div className="page-title"><div><span className="eyebrow">SETUP / {isSignal ? 'MANAGE SIGNALS' : 'DETECTION RULES'}</span><h2>{isSignal ? 'Manage signals' : 'Manage detection rules'}</h2><p>{isSignal ? 'Choose one of 20 ready templates or create your own reusable signal.' : 'Choose one of 20 operational rule templates or build a rule manually.'}</p></div><div className="definition-actions"><select value={vision.activeCameraId} onChange={(event) => { vision.setActiveCameraId(event.target.value); setMode('closed'); }}>{vision.cameras.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select><button className="primary" type="button" onClick={() => setMode('choice')}><Plus size={16} /> Add {isSignal ? 'signal' : 'rule'}</button></div></div>
    {notice ? <div className="training-notice success"><Check size={16} />{notice}</div> : null}
    {mode !== 'closed' ? <section className="panel compact-builder"><div className="section-heading"><div><h3>{mode === 'choice' ? `Add ${isSignal ? 'signal' : 'rule'}` : mode === 'templates' ? `${isSignal ? 'Signal' : 'Rule'} templates` : `Create ${isSignal ? 'signal' : 'rule'} manually`}</h3><p>Definitions added here belong to {camera.name}. Saved templates remain reusable.</p></div><button className="icon-button" type="button" onClick={() => setMode('closed')}><X size={17} /></button></div>
      {mode === 'choice' ? <div className="definition-choice"><button type="button" onClick={() => setMode('templates')}><Sparkles size={24} /><span><strong>Use a template</strong><small>{isSignal ? builtInSignalTemplates.length : builtInRuleTemplates.length} ready manufacturing options</small></span><ChevronRight size={18} /></button><button type="button" onClick={() => setMode('manual')}><Edit3 size={24} /><span><strong>Create manually</strong><small>Build a custom definition for this camera</small></span><ChevronRight size={18} /></button></div> : null}
      {mode === 'templates' ? <><label className="search template-search"><Search size={15} /><input aria-label="Search templates" placeholder="Search worker, machine, counting, safety..." value={search} onChange={(event) => setSearch(event.target.value)} /></label><div className="template-catalog">{isSignal ? visibleSignals.map((template) => <article key={template.id}><span><small>{template.category}</small><strong>{template.name}</strong><p>{template.description}</p></span><button className="secondary" type="button" onClick={() => addSignalTemplate(template)}>Use template</button></article>) : <>{visibleRules.map((template) => <article key={template.id}><span><small>{template.category}</small><strong>{template.name}</strong><p>{template.description}</p></span><button className="secondary" type="button" onClick={() => addBuiltInRule(template)}>Use template</button></article>)}{visibleSavedRules.map((template) => <article key={template.id}><span><small>YOUR TEMPLATE</small><strong>{template.name}</strong><p>{template.description}</p></span><button className="secondary" type="button" onClick={() => addSavedRule(template)}>Use template</button></article>)}</>}</div></> : null}
      {mode === 'manual' ? <>{isSignal ? <div className="form-grid"><FormField label="Name"><input value={signalDraft.name} onChange={(event) => setSignalDraft({ ...signalDraft, name: event.target.value })} /></FormField><FormField label="Signal kind"><select value={signalDraft.kind} onChange={(event) => setSignalDraft({ ...signalDraft, kind: event.target.value as SignalKind })}>{['object_detected','object_in_roi','object_absent_from_roi','object_count','object_entered_roi','line_crossing_count','objects_near','pose_moving','zone_motion','zone_idle','line_crossing_rate','roi_color_match','object_orientation_match','object_size_check'].map((kind) => <option value={kind} key={kind}>{kind.replaceAll('_',' ')}</option>)}</select></FormField><FormField label="Object class (80 COCO + custom)"><input list="model-class-options" value={signalDraft.className} onChange={(event) => setSignalDraft({ ...signalDraft, className: event.target.value })} /><datalist id="model-class-options">{classOptions.map((className) => <option value={className} key={className} />)}</datalist></FormField>{signalDraft.kind === 'objects_near' ? <FormField label="Second object class"><input list="model-class-options" value={signalDraft.secondaryClass} onChange={(event) => setSignalDraft({ ...signalDraft, secondaryClass: event.target.value })} /></FormField> : null}<FormField label="ROI / Zone"><select value={signalDraft.zoneId} onChange={(event) => setSignalDraft({ ...signalDraft, zoneId: event.target.value })}><option value="">Full frame</option>{config.zones.map((zone) => <option value={zone.id} key={zone.id}>{zone.name}</option>)}</select></FormField><FormField label="Confidence"><input min="0.01" max="1" step="0.01" type="number" value={signalDraft.confidence} onChange={(event) => setSignalDraft({ ...signalDraft, confidence: Number(event.target.value) })} /></FormField></div> : <div className="form-grid"><FormField label="Rule name"><input value={ruleDraft.name} onChange={(event) => setRuleDraft({ ...ruleDraft, name: event.target.value })} /></FormField><FormField label="Signal"><select value={ruleDraft.signalId} onChange={(event) => setRuleDraft({ ...ruleDraft, signalId: event.target.value })}>{config.signals.map((signal) => <option value={signal.id} key={signal.id}>{signal.name}</option>)}</select></FormField><FormField label="Operator"><select value={ruleDraft.operator} onChange={(event) => setRuleDraft({ ...ruleDraft, operator: event.target.value as typeof ruleDraft.operator })}><option value="IS_ACTIVE">is active</option><option value="IS_NOT_ACTIVE">is not active</option><option value="GREATER_THAN">greater than</option><option value="LESS_THAN">less than</option><option value="EQUALS">equals</option><option value="STATE_CHANGE">state changed</option></select></FormField>{['GREATER_THAN','LESS_THAN','EQUALS'].includes(ruleDraft.operator) ? <FormField label="Compare value"><input type="number" value={ruleDraft.value} onChange={(event) => setRuleDraft({ ...ruleDraft, value: Number(event.target.value) })} /></FormField> : null}<FormField label="For duration"><div className="input-suffix"><input min="0" type="number" value={ruleDraft.forSeconds} onChange={(event) => setRuleDraft({ ...ruleDraft, forSeconds: Number(event.target.value) })} /><span>seconds</span></div></FormField></div>}<button className="primary" type="button" onClick={saveManual}><Save size={15} /> Save {isSignal ? 'signal' : 'rule'}</button></> : null}
    </section> : null}
    <section className="panel table-panel"><div className="table-toolbar"><label className="search"><Search size={15} /><input placeholder="Search" /></label><Pill tone={vision.running[camera.id] ? 'green' : 'neutral'}>{vision.running[camera.id] ? 'Live evaluation' : 'Engine paused'}</Pill></div><div className={`engine-definition-table ${isSignal ? 'signals' : 'rules'}`}><div className="definition-head"><span>Name</span><span>{isSignal ? 'Kind / Class' : 'Signal logic'}</span><span>ROI / Duration</span><span>Live state</span><span>Actions</span></div>{isSignal ? config.signals.map((signal) => { const state = vision.frames[camera.id]?.signals.find((item) => item.signalId === signal.id); const zone = config.zones.find((item) => item.id === signal.zoneId); return <div className="definition-row" key={signal.id}><strong>{signal.name}</strong><span>{signal.kind.replaceAll('_',' ')} · {signal.className}</span><span>{zone?.name ?? 'Full frame'}</span><Pill tone={state?.active ? 'green' : 'neutral'}>{state?.active ? `${state.value}` : 'FALSE'}</Pill><div className="table-actions"><button title="Save as reusable template" type="button" onClick={() => saveSignalAsTemplate(signal)}><Sparkles size={14} /></button><button title="Duplicate" type="button" onClick={() => updateConfig((current) => ({ ...current, signals: [...current.signals, { ...signal, id: `${signal.id}-copy-${Date.now()}`, name: `${signal.name} Copy` }] }))}><Copy size={14} /></button><button title="Delete" type="button" onClick={() => updateConfig((current) => ({ ...current, signals: current.signals.filter((item) => item.id !== signal.id), rules: current.rules.filter((rule) => rule.conditions.every((condition) => condition.signalId !== signal.id)) }))}><Trash2 size={14} /></button></div></div>; }) : config.rules.map((rule) => { const state = vision.frames[camera.id]?.rules.find((item) => item.ruleId === rule.id); return <div className="definition-row" key={rule.id}><strong>{rule.name}</strong><span>{rule.conditions.map((condition) => config.signals.find((signal) => signal.id === condition.signalId)?.name ?? condition.signalId).join(` ${rule.combinator} `)}</span><span>{rule.forSeconds}s</span><Pill tone={state?.active ? 'green' : 'neutral'}>{state?.active ? 'TRUE' : 'FALSE'}</Pill><div className="table-actions"><button title="Save as reusable template" type="button" onClick={() => saveRuleAsTemplate(rule)}><Sparkles size={14} /></button><button title="Duplicate" type="button" onClick={() => updateConfig((current) => ({ ...current, rules: [...current.rules, { ...rule, id: `${rule.id}-copy-${Date.now()}`, name: `${rule.name} Copy`, conditions: rule.conditions.map((condition) => ({ ...condition, id: `${condition.id}-copy` })) }] }))}><Copy size={14} /></button><button title="Delete" type="button" onClick={() => updateConfig((current) => ({ ...current, rules: current.rules.filter((item) => item.id !== rule.id) }))}><Trash2 size={14} /></button></div></div>; })}</div></section>
  </div>;
}

type AutomationRecord = { id: string; name: string; trigger: string; actions: string[]; recipient: string; active: boolean };
const automationStorageKey = 'optivision-automations-v1';
const defaultAutomations: AutomationRecord[] = [
  { id: 'machine-stopped-response', name: 'Machine stopped response', trigger: 'Machine Stopped = TRUE for 5 minutes', actions: ['WhatsApp', 'Email'], recipient: 'Maintenance Team', active: true },
  { id: 'low-productivity-alert', name: 'Low productivity alert', trigger: 'Worker Productivity < 70%', actions: ['Email', 'In-system'], recipient: 'Production Manager', active: true },
  { id: 'extended-worker-idle', name: 'Extended worker idle', trigger: 'Worker Idle > 10 minutes', actions: ['WhatsApp'], recipient: 'Production Manager', active: true }
];

function loadAutomations(): AutomationRecord[] {
  return readStoredJson<AutomationRecord[]>(automationStorageKey, defaultAutomations, isArray<AutomationRecord>);
}

function AutomationsPage() {
  const [open, setOpen] = useState(false);
  const [automations, setAutomations] = useState<AutomationRecord[]>(loadAutomations);
  const [trigger, setTrigger] = useState('Machine Stopped = TRUE for 5 minutes');
  const [recipient, setRecipient] = useState('Maintenance Team');
  const [actions, setActions] = useState<string[]>(['Email', 'WhatsApp', 'In-system']);
  const [notice, setNotice] = useState('');
  useEffect(() => { writeStoredJson(automationStorageKey, automations); }, [automations]);
  function toggleAction(action: string) { setActions((current) => current.includes(action) ? current.filter((item) => item !== action) : [...current, action]); }
  function saveAutomation() {
    const name = trigger.split(/[=<]/)[0].trim().replace(/\b\w/g, (letter) => letter.toUpperCase());
    setAutomations((current) => [...current, { id: `automation-${Date.now()}`, name: `${name} response`, trigger, actions: actions.length ? actions : ['In-system'], recipient, active: true }]);
    setOpen(false);
    setNotice('Automation saved locally and will remain after refresh.');
  }
  return <div className="page-stack"><div className="page-title"><div><span className="eyebrow">SETUP / AUTOMATIONS</span><h2>Automations</h2><p>Choose what OptiVision should do after a detection or business rule is triggered.</p></div><button className="primary" type="button" onClick={() => setOpen(!open)}><Plus size={16} /> Create automation</button></div>{notice ? <div className="training-notice success"><Check size={16} />{notice}</div> : null}{open && <section className="panel automation-editor"><div className="section-heading"><div><h3>Create automation</h3><p>Configure the trigger, delivery actions, and responsible team.</p></div><button className="icon-button" type="button" onClick={() => setOpen(false)}><X size={17} /></button></div><div className="automation-flow"><div><span>1</span><strong>Trigger</strong><select aria-label="Trigger type"><option>Detection Rule</option><option>Business Rule</option><option>Threshold</option><option>Duration</option></select><select aria-label="Trigger rule" value={trigger} onChange={(event) => setTrigger(event.target.value)}><option>Machine Stopped = TRUE for 5 minutes</option><option>Worker Productivity &lt; 70%</option><option>Production Count &lt; 500</option><option>Worker Idle &gt; 10 minutes</option></select></div><ArrowRight size={20} /><div><span>2</span><strong>Actions</strong>{['Email', 'WhatsApp', 'In-system'].map((action) => <label key={action}><input type="checkbox" checked={actions.includes(action)} onChange={() => toggleAction(action)} /> {action === 'In-system' ? 'In-system notification' : action}</label>)}</div><ArrowRight size={20} /><div><span>3</span><strong>Recipients</strong><select aria-label="Recipient group" value={recipient} onChange={(event) => setRecipient(event.target.value)}><option>Production Manager</option><option>Maintenance Team</option></select><button className="add-inline" type="button"><Plus size={13} /> Add group</button></div></div><button className="primary" type="button" onClick={saveAutomation}><Save size={15} /> Save automation</button></section>}<section className="automation-list">{automations.map((automation) => <article className="panel" key={automation.id}><div className="automation-icon"><Zap size={19} /></div><div><strong>{automation.name}</strong><small>IF</small><p>{automation.trigger}</p></div><ArrowRight size={18} /><div><small>THEN</small><p>{automation.actions.join(' + ')}</p><span>{automation.recipient}</span></div><button className={`automation-status ${automation.active ? 'active' : ''}`} type="button" onClick={() => setAutomations((current) => current.map((item) => item.id === automation.id ? { ...item, active: !item.active } : item))}>{automation.active ? 'Active' : 'Paused'}</button><TableActions /></article>)}</section></div>;
}

function IntegrationsPage() {
  return <div className="page-stack"><div className="page-title"><div><span className="eyebrow">SETUP / INTEGRATIONS</span><h2>Integrations</h2><p>Automation actions appear only after their integration is configured.</p></div></div><section className="integration-grid">{[
    { name: 'Email', icon: Mail, status: 'Connected', detail: 'SMTP · alerts@optivision.ai', fields: ['SMTP / email provider', 'Sender account', 'Authentication'] },
    { name: 'WhatsApp', icon: MessageCircle, status: 'Connected', detail: 'WhatsApp Business API', fields: ['API credentials', 'Phone number', 'Template configuration'] },
    { name: 'In-system notification', icon: Bell, status: 'Available', detail: 'Notification center', fields: ['Camera highlight', 'Dashboard highlight', 'History retention'] }
  ].map((item) => <article className="panel integration-card" key={item.name}><header><span><item.icon size={22} /></span><Pill tone="green"><i /> {item.status}</Pill></header><h3>{item.name}</h3><p>{item.detail}</p><ul>{item.fields.map((field) => <li key={field}><Check size={14} /> {field}</li>)}</ul><footer><button className="secondary" type="button">Configure</button><button className="ghost" type="button"><Play size={14} /> Test {item.name === 'Email' ? 'email' : item.name === 'WhatsApp' ? 'message' : 'notification'}</button></footer></article>)}</section><section className="panel recipients-panel"><div className="section-heading"><div><h2>Reusable recipient groups</h2><p>Add, remove, and reuse recipients across automations.</p></div><button className="secondary" type="button"><Plus size={15} /> Add group</button></div>{[['Production Manager', 'manager@factory.com', '+91 XXXXX XXXXX'], ['Maintenance Team', 'maintenance@factory.com', '+91 XXXXX XXXXX']].map(([name, email, phone]) => <div className="recipient-row" key={name}><span><Users size={18} /></span><strong>{name}</strong><span><Mail size={14} /> {email}</span><span><MessageCircle size={14} /> {phone}</span><TableActions /></div>)}</section></div>;
}

function LegacyTrainingPage() {
  const steps = ['Select Base Model', 'Upload Images', 'Name Classes', 'Label / Mark Objects', 'Train', 'Validate', 'View Accuracy', 'Save Model', 'Available in Camera Setup'];
  const [active, setActive] = useState(0);
  return <div className="page-stack"><div className="page-title"><div><span className="eyebrow">SETUP / MODEL TRAINING</span><h2>Customer model training</h2><p>Create an optional customer-specific model without changing normal camera setup.</p></div><Pill tone="orange">Optional extension</Pill></div><section className="panel training-shell"><div className="training-steps">{steps.map((item, index) => <button className={active === index ? 'active' : index < active ? 'complete' : ''} type="button" key={item} onClick={() => setActive(index)}><span>{index < active ? <Check size={13} /> : index + 1}</span><strong>{item}</strong></button>)}</div><div className="training-stage"><span className="eyebrow">STEP {active + 1} OF {steps.length}</span><h2>{steps[active]}</h2>{active === 0 && <div className="model-choice-large"><button className="selected" type="button"><Cpu size={23} /><strong>YOLO26n</strong><small>Fast general detector · Recommended</small><Check size={16} /></button><button type="button"><Cpu size={23} /><strong>YOLO11m</strong><small>Higher accuracy · More compute</small></button></div>}{active === 1 && <div className="upload-zone"><Upload size={28} /><strong>Drop customer images here</strong><p>JPG or PNG · Include different angles, lighting, packaging, and backgrounds.</p><button className="secondary" type="button">Choose images</button></div>}{active === 2 && <div className="class-list"><article><span>1</span><input defaultValue="My Product" /><input type="color" defaultValue="#ff6b00" /></article><article><span>2</span><input defaultValue="Defective Product" /><input type="color" defaultValue="#ef4444" /></article><button className="add-inline" type="button"><Plus size={14} /> Add class</button></div>}{active === 3 && <div className="label-stage"><div className="label-canvas"><Boxes size={38} /><strong>Image 08 of 42</strong><div className="sample-label">My Product</div></div><aside><button className="primary" type="button">Draw bounding box</button><p>Mark every visible instance and assign the correct class.</p></aside></div>}{active === 4 && <div className="training-progress"><div><span style={{ width: '64%' }} /></div><strong>Epoch 32 / 50</strong><p>Training YOLO26n on 42 labelled images...</p></div>}{active === 5 && <div className="validation-cards"><article><strong>34</strong><small>Training images</small></article><article><strong>8</strong><small>Validation images</small></article><article><strong>2</strong><small>Classes</small></article></div>}{active === 6 && <div className="accuracy-card"><Gauge size={42} /><strong>89.4%</strong><span>mAP50 accuracy</span><div><small>My Product</small><b>92%</b></div><div><small>Defective Product</small><b>86%</b></div></div>}{active === 7 && <div className="form-grid"><FormField label="Model name"><input defaultValue="Packaging Product v1" /></FormField><FormField label="Version"><input defaultValue="1.0" /></FormField><FormField label="Description" wide><textarea defaultValue="Customer-specific product and defect detector for Packaging Line 02." /></FormField></div>}{active === 8 && <div className="save-success"><span><Check size={24} /></span><div><h3>Customer Model is ready</h3><p>Packaging Product v1 now appears alongside pretrained models in Camera Setup.</p></div></div>}<footer><button className="secondary" disabled={active === 0} type="button" onClick={() => setActive(active - 1)}><ArrowLeft size={15} /> Previous</button><button className="primary" disabled={active === steps.length - 1} type="button" onClick={() => setActive(active + 1)}>Continue <ArrowRight size={15} /></button></footer></div></section></div>;
}

function TrainingPage() {
  const vision = useVision();
  const [dashboard, setDashboard] = useState<TrainingState>({ ok: true, projects: [] });
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [selectedImageId, setSelectedImageId] = useState('');
  const [name, setName] = useState('');
  const [classesText, setClassesText] = useState('my_product, defective_product');
  const [description, setDescription] = useState('');
  const [baseModel, setBaseModel] = useState('yolo11n.pt');
  const [epochs, setEpochs] = useState(30);
  const [imageSize, setImageSize] = useState(640);
  const [annotations, setAnnotations] = useState<TrainingAnnotation[]>([]);
  const [selectedClass, setSelectedClass] = useState('');
  const [draftBox, setDraftBox] = useState<{ startX: number; startY: number; endX: number; endY: number } | null>(null);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const annotationRef = useRef<HTMLDivElement | null>(null);
  const selectedProject = dashboard.projects.find((project) => project.id === selectedProjectId) ?? dashboard.projects[0];
  const selectedImage = selectedProject?.images.find((image) => image.id === selectedImageId) ?? selectedProject?.images[0];

  async function refresh() {
    try {
      const next = await trainingApi.list();
      setDashboard(next);
      setSelectedProjectId((current) => next.projects.some((project) => project.id === current) ? current : next.projects[0]?.id ?? '');
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Training projects could not be loaded.');
    }
  }
  useEffect(() => { void refresh(); const timer = window.setInterval(() => void refresh(), 2500); return () => window.clearInterval(timer); }, []);
  useEffect(() => {
    setSelectedImageId((current) => selectedProject?.images.some((image) => image.id === current) ? current : selectedProject?.images[0]?.id ?? '');
    setSelectedClass(selectedProject?.classes[0] ?? '');
  }, [selectedProject?.id]);
  useEffect(() => setAnnotations(selectedImage?.annotations.map((annotation) => ({ ...annotation })) ?? []), [selectedImage?.id, selectedImage?.annotations]);

  async function runAction(key: string, action: () => Promise<TrainingState>, success: string) {
    setBusy(key); setError(''); setNotice('');
    try {
      const next = await action(); setDashboard(next); setNotice(success); return next;
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Action failed.'); return null;
    } finally { setBusy(''); }
  }
  async function createProject() {
    const classes = classesText.split(',').map((item) => item.trim()).filter(Boolean);
    const next = await runAction('create', () => trainingApi.create({ name, description, classes, baseModel }), 'Training project created. Upload and label the customer images.');
    if (next?.projects.length) { const created = next.projects.at(-1)!; setSelectedProjectId(created.id); setSelectedImageId(''); setName(''); }
  }
  async function uploadImages(files: FileList | null) {
    if (!selectedProject || !files?.length) return;
    const selected = Array.from(files);
    setBusy('upload'); setError('');
    try {
      const images = await Promise.all(selected.map(async (file) => ({ fileName: file.name, data: await fileToDataUrl(file) })));
      const next = await trainingApi.upload(selectedProject.id, images); setDashboard(next); setNotice(`${selected.length} image${selected.length === 1 ? '' : 's'} uploaded.`);
    } catch (uploadError) { setError(uploadError instanceof Error ? uploadError.message : 'Upload failed.'); } finally { setBusy(''); }
  }
  function pointer(event: ReactPointerEvent<HTMLDivElement>) {
    const bounds = annotationRef.current?.getBoundingClientRect();
    if (!bounds) return { x: 0, y: 0 };
    return { x: Math.max(0, Math.min(100, (event.clientX - bounds.left) / bounds.width * 100)), y: Math.max(0, Math.min(100, (event.clientY - bounds.top) / bounds.height * 100)) };
  }
  function normalizeBox(box: { startX: number; startY: number; endX: number; endY: number }) {
    return { x: Math.min(box.startX, box.endX), y: Math.min(box.startY, box.endY), width: Math.abs(box.endX - box.startX), height: Math.abs(box.endY - box.startY) };
  }
  function startBox(event: ReactPointerEvent<HTMLDivElement>) { if (!selectedClass) return; event.currentTarget.setPointerCapture(event.pointerId); const point = pointer(event); setDraftBox({ startX: point.x, startY: point.y, endX: point.x, endY: point.y }); }
  function moveBox(event: ReactPointerEvent<HTMLDivElement>) { if (!draftBox) return; const point = pointer(event); setDraftBox({ ...draftBox, endX: point.x, endY: point.y }); }
  function finishBox(event: ReactPointerEvent<HTMLDivElement>) { if (!draftBox || !selectedClass) return; const box = normalizeBox({ ...draftBox, endX: pointer(event).x, endY: pointer(event).y }); setDraftBox(null); if (box.width < .5 || box.height < .5) return; setAnnotations((current) => [...current, { id: `box-${Date.now()}`, className: selectedClass, ...box }]); }
  async function saveBoxes(reviewed: boolean) { if (!selectedProject || !selectedImage) return; await runAction('save', () => trainingApi.saveAnnotations(selectedProject.id, selectedImage.id, annotations, reviewed), reviewed ? 'Annotations saved and image reviewed.' : 'Annotation draft saved.'); }

  const reviewed = selectedProject?.images.filter((image) => image.reviewed).length ?? 0;
  const instances = selectedProject?.images.reduce((sum, image) => sum + image.annotations.length, 0) ?? 0;
  const canTrain = Boolean(selectedProject && reviewed >= 4 && selectedProject.classes.every((className) => selectedProject.images.some((image) => image.annotations.some((annotation) => annotation.className === className))));
  const normalizedDraft = draftBox ? normalizeBox(draftBox) : null;
  return <div className="page-stack"><div className="page-title"><div><span className="eyebrow">SETUP / MODEL TRAINING</span><h2>Customer model training</h2><p>The original OptiVision 2 upload, annotation, epoch, validation, activation, and deletion workflow.</p></div><Pill tone={vision.workerStatus === 'online' ? 'green' : 'red'}>{vision.workerStatus === 'online' ? 'Training worker online' : 'Worker offline'}</Pill></div>{error ? <div className="training-notice error"><AlertTriangle size={16} />{error}</div> : null}{notice ? <div className="training-notice success"><Check size={16} />{notice}</div> : null}<section className="panel real-training-shell"><aside className="real-training-sidebar"><div className="training-sidebar-heading"><Database size={17} /><span><strong>Model projects</strong><small>{dashboard.projects.length} local</small></span></div><div className="training-projects">{dashboard.projects.map((project) => <button className={project.id === selectedProject?.id ? 'active' : ''} type="button" key={project.id} onClick={() => setSelectedProjectId(project.id)}><i className={project.status} /><span><strong>{project.name}</strong><small>{project.images.length} images · {project.classes.length} classes</small></span></button>)}{!dashboard.projects.length ? <p>No customer models yet.</p> : null}</div><div className="training-create"><h3>New project</h3><FormField label="Project name"><input value={name} onChange={(event) => setName(event.target.value)} placeholder="Packaging defect model" /></FormField><FormField label="Classes, comma separated"><input value={classesText} onChange={(event) => setClassesText(event.target.value)} /></FormField><FormField label="Description"><textarea value={description} onChange={(event) => setDescription(event.target.value)} /></FormField><FormField label="Pretrained base"><select value={baseModel} onChange={(event) => setBaseModel(event.target.value)}><option value="yolo11n.pt">YOLO11n · fastest trial</option><option value="yolov8n.pt">YOLOv8n · compatible</option><option value="yolo26n.pt">YOLO26n · newest</option></select></FormField><button className="primary" disabled={!name.trim() || busy === 'create'} type="button" onClick={() => void createProject()}><Plus size={15} /> Create project</button></div></aside><div className="real-training-main">{selectedProject ? <><header className="training-project-header"><div><span className="eyebrow">{selectedProject.baseModel} · {selectedProject.status}</span><h2>{selectedProject.name}</h2><p>{selectedProject.description || 'Customer-specific model'}</p></div><div><label className="secondary training-file-button"><Upload size={15} /> {busy === 'upload' ? 'Uploading…' : 'Add images'}<input accept="image/jpeg,image/png,image/webp" multiple type="file" onChange={(event) => void uploadImages(event.target.files)} /></label><button className="danger-button" disabled={busy === 'delete'} type="button" onClick={() => void runAction('delete', () => trainingApi.delete(selectedProject.id), 'Training project deleted.')}><Trash2 size={15} /> Delete</button></div></header><div className="training-stat-grid"><article><strong>{selectedProject.images.length}</strong><small>Images</small></article><article><strong>{reviewed}</strong><small>Reviewed</small></article><article><strong>{instances}</strong><small>Object boxes</small></article><article><strong>{selectedProject.versions.length}</strong><small>Versions</small></article></div>{selectedProject.images.length < 20 ? <div className="training-guidance"><AlertTriangle size={16} /><span><strong>Experimental dataset</strong><small>Training is allowed after 4 reviewed images, but use 20–50 varied images before trusting production results.</small></span></div> : null}<div className="annotation-workbench"><div className="image-gallery"><h3>1. Choose image</h3><div>{selectedProject.images.map((image) => <button className={image.id === selectedImage?.id ? 'active' : ''} type="button" key={image.id} onClick={() => setSelectedImageId(image.id)}><img alt={image.fileName} src={trainingApi.imageUrl(selectedProject.id, image.id)} /><span>{image.reviewed ? <Check size={12} /> : image.annotations.length}</span></button>)}</div></div><div className="annotator"><header><span><h3>2. Draw bounding boxes</h3><small>Drag around every target object</small></span><select value={selectedClass} onChange={(event) => setSelectedClass(event.target.value)}>{selectedProject.classes.map((className) => <option key={className}>{className}</option>)}</select></header>{selectedImage ? <><div className="annotation-canvas" onPointerDown={startBox} onPointerMove={moveBox} onPointerUp={finishBox} ref={annotationRef} style={{ aspectRatio: `${selectedImage.width || 16} / ${selectedImage.height || 9}` }}><img alt={`Annotate ${selectedImage.fileName}`} draggable={false} src={trainingApi.imageUrl(selectedProject.id, selectedImage.id)} />{annotations.map((annotation) => <div className="annotation-box" key={annotation.id} style={{ left: `${annotation.x}%`, top: `${annotation.y}%`, width: `${annotation.width}%`, height: `${annotation.height}%` }}><span>{annotation.className}</span><button type="button" onClick={(event) => { event.stopPropagation(); setAnnotations((current) => current.filter((item) => item.id !== annotation.id)); }}><X size={11} /></button></div>)}{normalizedDraft ? <div className="annotation-box draft" style={{ left: `${normalizedDraft.x}%`, top: `${normalizedDraft.y}%`, width: `${normalizedDraft.width}%`, height: `${normalizedDraft.height}%` }}><span>{selectedClass}</span></div> : null}</div><footer><button className="secondary" disabled={busy === 'save'} type="button" onClick={() => void saveBoxes(false)}>Save draft</button><button className="primary" disabled={busy === 'save'} type="button" onClick={() => void saveBoxes(true)}><Check size={15} /> Save &amp; mark reviewed</button></footer></> : <div className="annotator-empty"><Upload size={26} /><strong>Upload images to start annotation</strong></div>}</div></div><section className="training-run"><div><h3>3. Train candidate</h3><p>Training remains separate from active camera models until manual activation.</p></div><div className="training-settings-row"><FormField label="Custom epochs (1–500)"><input min="1" max="500" type="number" value={epochs} onChange={(event) => setEpochs(Math.max(1, Math.min(500, Number(event.target.value))))} /></FormField><FormField label="Image size"><select value={imageSize} onChange={(event) => setImageSize(Number(event.target.value))}>{[320,416,512,640,800,960].map((size) => <option key={size} value={size}>{size}px</option>)}</select></FormField><button className="primary" disabled={!canTrain || busy === 'train' || selectedProject.training?.status === 'running'} type="button" onClick={() => void runAction('train', () => trainingApi.train(selectedProject.id, epochs, imageSize), 'Training queued. Progress updates automatically.')}><Play size={15} /> {selectedProject.training?.status === 'running' ? 'Training in progress' : 'Start training'}</button></div>{!canTrain ? <small>Review at least 4 images and label every class before training.</small> : null}{selectedProject.training ? <div className="training-progress-live"><span><i style={{ width: `${selectedProject.training.progress}%` }} /></span><strong>{Math.round(selectedProject.training.progress)}%</strong><small>Epoch {selectedProject.training.epoch}/{selectedProject.training.totalEpochs}</small></div> : null}</section><section className="training-versions"><h3>4. Review and activate</h3>{selectedProject.versions.map((version) => <article key={version.id}><span><strong>{version.id}</strong><small>{new Date(version.createdAt * 1000).toLocaleString()}</small></span><div>{Object.entries(version.metrics).slice(0,3).map(([key,value]) => <span key={key}><small>{key}</small><strong>{Number(value).toFixed(3)}</strong></span>)}</div><button className={version.active ? 'secondary' : 'primary'} disabled={version.active || busy === `activate-${version.id}`} type="button" onClick={() => void runAction(`activate-${version.id}`, async () => { const next = await trainingApi.activate(selectedProject.id, version.id); await vision.refreshModels(); return next; }, 'Model activated and added to Camera Setup.')}><Check size={14} /> {version.active ? 'Active' : 'Activate'}</button></article>)}{!selectedProject.versions.length ? <p>No completed candidates yet.</p> : null}</section></> : <div className="training-empty"><Cpu size={40} /><h2>Create the first customer model</h2><p>Define classes, upload customer examples, label objects, then train and validate a separate YOLO candidate.</p></div>}</div></section></div>;
}

function LegacyMonitoringPage({ setPage }: { setPage: (page: Page) => void }) {
  const [grid, setGrid] = useState('3');
  return <div className="page-stack"><div className="page-title"><div><span className="eyebrow">USER MONITORING</span><h2>Live camera operations</h2><p>See only configured intelligence and the values that matter for each camera.</p></div><div className="page-controls"><select defaultValue="all"><option value="all">All cameras</option><option>Plant A</option><option>Plant B</option></select><select value={grid} onChange={(event) => setGrid(event.target.value)}><option value="1">1 camera</option><option value="2">2 cameras</option><option value="3">3 cameras</option></select></div></div><section className={`monitor-grid columns-${grid}`}>{cameraCards.map((camera, index) => <button className="monitor-card" type="button" key={camera.name} onClick={() => setPage('camera-detail')}><div className="monitor-feed"><EmptyFeed compact /><span className={`camera-status ${index === 2 ? 'stopped' : ''}`}><i /> {camera.status}</span><span className="expand"><Maximize2 size={15} /></span></div><div className="monitor-title"><span><strong>{camera.name}</strong><small>{camera.location}</small></span><ChevronRight size={18} /></div><div className="camera-parameters"><span><small>Worker present</small><strong>{camera.workers}</strong></span><span><small>Workers working</small><strong>{camera.working}</strong></span><span><small>Workers idle</small><strong>{camera.idle}</strong></span><span><small>Output count</small><strong>{camera.output}</strong></span><span><small>Productivity</small><strong>{camera.productivity}%</strong></span><span><small>Machine status</small><strong className={index === 2 ? 'danger-text' : 'success-text'}>{camera.status.toUpperCase()}</strong></span></div></button>)}</section></div>;
}

function ConfiguredMetricGrid({ cameraId, onConfigure }: { cameraId: string; onConfigure: () => void }) {
  const vision = useVision();
  const camera = vision.getCamera(cameraId);
  const frame = vision.frames[cameraId];
  const session = vision.metrics[cameraId];
  const bindings = camera.configuration.operationalMetrics.bindings;
  const present = frame ? resolveMetricBinding(bindings.workerPresent, frame) : { state: 'unknown' as const, value: null };
  const working = frame ? resolveMetricBinding(bindings.workerWorking, frame) : { state: 'unknown' as const, value: null };
  const idle = frame ? resolveMetricBinding(bindings.workerIdle, frame) : { state: 'unknown' as const, value: null };
  const personSummary = summarizePersonActivity(vision.personActivity[cameraId] ?? []);
  const hasTrackedPeople = Boolean(frame && (vision.personActivity[cameraId]?.length ?? 0));
  const people = hasTrackedPeople ? personSummary.visible : present.value ?? 0;
  const observed = (session?.activeSeconds ?? 0) + (session?.idleSeconds ?? 0);
  const metrics = camera.configuration.monitoringMetrics;
  const hasLiveData = camera.sourceStatus === 'ready' && vision.workerStatus === 'online' && vision.running[cameraId] && Boolean(frame);
  function value(metric: CameraCardMetric) {
    if (!hasLiveData) return 'UNKNOWN';
    if (metric.id === 'worker-present') return present.state === 'unknown' ? 'UNKNOWN' : String(people);
    if (metric.id === 'workers-working') return hasTrackedPeople ? String(personSummary.working) : working.state === 'unknown' ? 'UNKNOWN' : String(working.state === 'active' ? people : 0);
    if (metric.id === 'workers-idle') return hasTrackedPeople ? String(personSummary.idle) : idle.state === 'unknown' ? 'UNKNOWN' : String(idle.state === 'active' ? people : 0);
    if (metric.id === 'output-count') return session?.lastOutputValue === null || session?.lastOutputValue === undefined ? 'NO DATA' : String(Math.round(session.outputCount));
    if (metric.id === 'productivity') return observed ? `${Math.round((session?.activeSeconds ?? 0) / observed * 100)}%` : 'NO DATA';
    if (metric.id === 'machine-status') return session?.machineState.toUpperCase() ?? 'UNKNOWN';
    if (metric.source === 'signal') {
      const state = frame?.signals.find((item) => item.signalId === metric.sourceId);
      return metric.format === 'status' ? (state?.active ? 'ACTIVE' : 'INACTIVE') : String(Number(state?.value ?? 0));
    }
    if (metric.source === 'rule') return frame?.rules.find((item) => item.ruleId === metric.sourceId)?.active ? 'TRUE' : 'FALSE';
    if (metric.source === 'business') {
      const rule = camera.configuration.businessRules.find((item) => item.id === metric.sourceId);
      if (!rule) return '—';
      return formatBusinessResult(rule, businessRuleResult(rule, vision, cameraId));
    }
    return '—';
  }
  return <section className="configured-parameters"><header><span><strong>User parameters</strong><small>{metrics.length ? hasLiveData ? `${metrics.length} live values` : 'Waiting for valid live evidence' : 'Nothing selected yet'}</small></span><button type="button" onClick={onConfigure}><Settings2 size={13} /> Choose parameters</button></header>{metrics.length ? <div className={`camera-parameters ${hasLiveData ? '' : 'no-data'}`}>{metrics.map((metric) => { const displayed = value(metric); return <span key={metric.id}><small>{metric.label}</small><strong className={metric.sourceId === 'machine_status' && displayed === 'RUNNING' ? 'success-text' : metric.sourceId === 'machine_status' && displayed === 'STOPPED' ? 'danger-text' : displayed === 'UNKNOWN' || displayed === 'NO DATA' ? 'unknown-text' : ''}>{displayed}</strong></span>; })}</div> : <div className="camera-parameters-empty"><Gauge size={19} /><span><strong>No monitoring parameters</strong><small>Choose Workers working, Productivity, or another configured value.</small></span></div>}</section>;
}

function PersonActivityPanel({ cameraId, compact = false }: { cameraId: string; compact?: boolean }) {
  const vision = useVision();
  const records = vision.personActivity[cameraId] ?? [];
  const summary = summarizePersonActivity(records);
  const sorted = [...records].sort((left, right) => {
    const leftVisible = left.state === 'not_visible' ? 0 : 1;
    const rightVisible = right.state === 'not_visible' ? 0 : 1;
    return rightVisible - leftVisible || right.lastSeenAt - left.lastSeenAt;
  });
  const visibleRecords = sorted;
  return <section className={`person-activity-panel ${compact ? 'compact' : 'panel'}`}>
    <header>
      <span><Users size={16} /><span><strong>Tracked people</strong><small>{records.length ? `${summary.visible} visible · ${records.length} IDs this session` : 'Waiting for confirmed person tracks'}</small></span></span>
      {records.length ? <div className="person-summary"><b>{summary.working} working</b><b>{summary.idle} idle</b><b>{summary.present} unclassified</b></div> : null}
    </header>
    {visibleRecords.length ? <div className="person-activity-list">{visibleRecords.map((record) => {
      const stateClass = record.state.replace('_', '-');
      const detail = record.state === 'not_visible'
        ? `Last seen ${new Date(record.lastSeenAt * 1000).toLocaleTimeString()}`
        : `${formatActivityDuration(currentVisitDuration(record))} in current visit`;
      if (compact) return <div className="person-activity-row" key={record.trackId}>
        <strong className="person-id">Person {record.displayId}</strong>
        <span><b className={`person-state ${stateClass}`}>{personStateLabel(record.state)}</b><small>{detail} · {formatActivityDuration(record.presentSeconds)} total</small><span className="person-visit-segments">{record.visits.slice(-3).map((visit, index) => <em key={visit.id}>Visit {Math.max(1, record.visits.length - 2 + index)}: {formatActivityDuration(visit.presentSeconds)}{visit.endedAt ? '' : ' now'}</em>)}</span></span>
      </div>;
      return <details className="person-activity-detail" key={record.trackId} open={record.state !== 'not_visible'}>
        <summary><strong className="person-id">Person {record.displayId}</strong><b className={`person-state ${stateClass}`}>{personStateLabel(record.state)}</b><span><small>Current visit</small><strong>{record.state === 'not_visible' ? '—' : formatActivityDuration(currentVisitDuration(record))}</strong></span><span><small>Total present</small><strong>{formatActivityDuration(record.presentSeconds)}</strong></span><span><small>Working</small><strong>{formatActivityDuration(record.workingSeconds)}</strong></span><span><small>Idle</small><strong>{formatActivityDuration(record.idleSeconds)}</strong></span><span><small>Visits</small><strong>{record.visits.length}</strong></span></summary>
        <div className="person-visit-list">{[...record.visits].reverse().map((visit, index) => <div key={visit.id}><span><strong>Visit {record.visits.length - index}</strong><small>{new Date(visit.startedAt * 1000).toLocaleString()} — {visit.endedAt ? new Date(visit.endedAt * 1000).toLocaleTimeString() : 'visible now'}</small></span><span><small>Present</small><strong>{formatActivityDuration(visit.presentSeconds)}</strong></span><span><small>Working</small><strong>{formatActivityDuration(visit.workingSeconds)}</strong></span><span><small>Idle</small><strong>{formatActivityDuration(visit.idleSeconds)}</strong></span></div>)}</div>
      </details>;
    })}</div> : <div className="person-activity-empty"><Users size={18} /><span><strong>No confirmed person IDs yet</strong><small>IDs appear after ByteTrack confirms a person inside the Worker Zone.</small></span></div>}
  </section>;
}

function MonitoringCameraCard({ camera, setPage, onError }: { camera: CameraRecord; setPage: (page: Page) => void; onError: (message: string) => void }) {
  const vision = useVision();
  const lpr = useLpr();
  const [actionError, setActionError] = useState('');
  const cameraName = camera.name.trim() || camera.id;
  const frame = vision.frames[camera.id];
  const machineState = vision.metrics[camera.id]?.machineState ?? 'unknown';
  const assignment = lpr.processes.flatMap((process) => process.stages.map((stage) => ({ process, stage }))).find((item) => item.stage.cameraId === camera.id);
  async function toggle() { onError(''); setActionError(''); try { await vision.toggleEngine(camera.id); } catch (error) { const message = error instanceof Error ? error.message : 'Could not start the camera.'; setActionError(message); onError(message); } }
  function openSourceSetup() {
    const legacyStepKey = `optivision-camera-wizard-step:${camera.id}`;
    const draft = readSetupDraft(camera.id, legacyStepKey, wizardSteps.length - 1);
    writeSetupDraft({ ...draft, selectedPlantId: camera.plantId, currentStep: 1, updatedAt: Date.now() });
    vision.setSelectedPlantId(camera.plantId);
    vision.setActiveCameraId(camera.id);
    setPage('add-camera');
  }
  function openParameterSetup() {
    const legacyStepKey = `optivision-camera-wizard-step:${camera.id}`;
    const draft = readSetupDraft(camera.id, legacyStepKey, wizardSteps.length - 1);
    writeSetupDraft({ ...draft, selectedPlantId: camera.plantId, currentStep: 6, updatedAt: Date.now() });
    vision.setSelectedPlantId(camera.plantId);
    vision.setActiveCameraId(camera.id);
    setPage('add-camera');
  }
  const sourceReady = camera.sourceStatus === 'ready';
  const statusLabel = vision.running[camera.id] && vision.workerStatus !== 'online' ? 'Worker offline' : vision.running[camera.id] ? 'Detecting' : sourceReady ? 'Paused' : camera.sourceStatus === 'error' ? 'Source missing' : 'Not connected';
  return <article className="monitor-card live-card"><button className="monitor-open" type="button" onClick={() => { vision.setActiveCameraId(camera.id); setPage('camera-detail'); }}><div className="monitor-feed"><EmptyFeed compact cameraId={camera.id} /><span className={`camera-status ${!sourceReady || machineState === 'stopped' ? 'stopped' : machineState === 'unknown' ? 'unknown' : ''}`}><i />{statusLabel}</span><span className="expand"><Maximize2 size={15} /></span></div><div className="monitor-title"><span><strong>{cameraName}</strong><small>{camera.location} · {camera.department}</small><em><Route size={12} />{assignment ? `${assignment.stage.name} · ${assignment.process.name}` : 'No station mapping'}</em></span><ChevronRight size={18} /></div></button><ConfiguredMetricGrid cameraId={camera.id} onConfigure={openParameterSetup} /><PersonActivityPanel cameraId={camera.id} compact /><footer className="monitor-controls"><button className="secondary" type="button" onClick={() => { vision.setActiveCameraId(camera.id); setPage('add-camera'); }}><Settings2 size={14} />Configure</button>{sourceReady ? <button className={vision.running[camera.id] ? 'secondary' : 'primary'} type="button" onClick={() => void toggle()}>{vision.running[camera.id] ? <Pause size={14} /> : <Play size={14} />}{vision.running[camera.id] ? 'Pause engine' : 'Start engine'}</button> : <button className="primary" type="button" onClick={openSourceSetup}><Upload size={14} />Connect feed</button>}</footer>{actionError || camera.error ? <p className="camera-error-copy" role="alert">{actionError || camera.error}</p> : null}</article>;
}

function MonitoringPage({ setPage }: { setPage: (page: Page) => void }) {
  const vision = useVision();
  const lpr = useLpr();
  const [grid, setGrid] = useState(() => readStoredString('optivision-monitor-grid-v1', '3'));
  const [error, setError] = useState('');
  useEffect(() => { writeStoredString('optivision-monitor-grid-v1', grid); }, [grid]);
  const plantCameras = vision.cameras.filter((camera) => camera.plantId === vision.selectedPlantId);
  const mappedCameraIds = new Set(lpr.processes.flatMap((process) => process.stages.filter((stage) => stage.cameraId).map((stage) => stage.cameraId)));
  const readyCount = plantCameras.filter((camera) => camera.sourceStatus === 'ready').length;
  const runningCount = plantCameras.filter((camera) => vision.running[camera.id]).length;
  return <div className="page-stack"><div className="page-title"><div><span className="eyebrow">USER MONITORING</span><h2>Live camera operations</h2><p>Review every configured camera in the selected plant. Select a camera image to open its full preview.</p></div><div className="page-controls"><select aria-label="Plant" value={vision.selectedPlantId} onChange={(event) => vision.setSelectedPlantId(event.target.value)}>{vision.plants.map((plant) => <option value={plant.id} key={plant.id}>{plant.name}</option>)}</select><select className="grid-column-select" aria-label="Camera grid columns" value={grid} onChange={(event) => setGrid(event.target.value)}><option value="1">1 column</option><option value="2">2 columns</option><option value="3">3 columns</option></select></div></div><section className="monitor-summary panel"><div><small>Configured</small><strong>{plantCameras.length}</strong><span>in selected plant</span></div><div><small>Connected</small><strong>{readyCount}</strong><span>feeds ready</span></div><div><small>Monitoring</small><strong>{runningCount}</strong><span>engines active</span></div><div><small>Station mapped</small><strong>{plantCameras.filter((camera) => mappedCameraIds.has(camera.id)).length}</strong><span>LPR checkpoints</span></div></section>{error ? <div className="training-notice error"><AlertTriangle size={16} />{error}</div> : null}{plantCameras.length ? <section className={`monitor-grid columns-${grid}`}>{plantCameras.map((camera) => <MonitoringCameraCard camera={camera} key={camera.id} onError={setError} setPage={setPage} />)}</section> : <section className="panel setup-empty-state"><Camera size={28} /><strong>No cameras in this plant</strong><p>Open Setup to add or assign a camera.</p><button className="primary" type="button" onClick={() => setPage('add-camera')}>Open setup</button></section>}</div>;
}

function MonitoringPageLegacy({ setPage }: { setPage: (page: Page) => void }) {
  const vision = useVision();
  const lpr = useLpr();
  const [grid, setGrid] = useState(() => readStoredString('optivision-monitor-grid-v1', '3'));
  const [error, setError] = useState('');
  useEffect(() => { writeStoredString('optivision-monitor-grid-v1', grid); }, [grid]);
  async function toggle(camera: CameraRecord) { setError(''); try { await vision.toggleEngine(camera.id); } catch (toggleError) { setError(toggleError instanceof Error ? toggleError.message : 'Could not start the camera.'); } }
  const mappedCameraIds = new Set(lpr.processes.flatMap((process) => process.stages.filter((stage) => stage.cameraId).map((stage) => stage.cameraId)));
  const readyCount = vision.cameras.filter((camera) => camera.sourceStatus === 'ready').length;
  const runningCount = vision.cameras.filter((camera) => vision.running[camera.id]).length;
  return <div className="page-stack"><div className="page-title"><div><span className="eyebrow">USER MONITORING</span><h2>Live camera operations</h2><p>Review each configured camera, its station assignment, connection state, and current operational results.</p></div><div className="page-controls"><select aria-label="Focused camera" value={vision.activeCameraId} onChange={(event) => vision.setActiveCameraId(event.target.value)}>{vision.cameras.map((camera) => <option value={camera.id} key={camera.id}>{camera.name}</option>)}</select><select aria-label="Camera grid size" value={grid} onChange={(event) => setGrid(event.target.value)}><option value="1">1 camera</option><option value="2">2 cameras</option><option value="3">3 cameras</option></select></div></div><section className="monitor-summary panel"><div><small>Configured</small><strong>{vision.cameras.length}</strong><span>camera{vision.cameras.length === 1 ? '' : 's'}</span></div><div><small>Connected</small><strong>{readyCount}</strong><span>feed{readyCount === 1 ? '' : 's'} ready</span></div><div><small>Monitoring</small><strong>{runningCount}</strong><span>engine{runningCount === 1 ? '' : 's'} active</span></div><div><small>Station mapped</small><strong>{mappedCameraIds.size}</strong><span>LPR checkpoint{mappedCameraIds.size === 1 ? '' : 's'}</span></div></section>{error ? <div className="training-notice error"><AlertTriangle size={16} />{error}</div> : null}<section className={`monitor-grid columns-${grid}`}>{vision.cameras.slice(0, Number(grid)).map((camera) => { const frame = vision.frames[camera.id]; const session = vision.metrics[camera.id]; const observed = (session?.activeSeconds ?? 0) + (session?.idleSeconds ?? 0) + (session?.absentSeconds ?? 0); const productivity = observed ? Math.round((session?.activeSeconds ?? 0) / observed * 100) : 0; const people = frame?.detections.filter((detection) => detection.className === 'person').length ?? 0; const working = frame?.rules.some((rule) => rule.output === 'WORKER_WORKING' && rule.active) ? people : 0; const idle = frame?.rules.some((rule) => rule.output === 'WORKER_IDLE' && rule.active) ? people : 0; const counter = frame?.signals.find((signal) => signal.kind === 'line_crossing_count'); const count = Number(counter?.evidence.totalCount ?? counter?.value ?? 0); const machineStopped = frame?.signals.some((signal) => signal.signalId === 'machine-idle' && signal.active); const processAssignment = lpr.processes.flatMap((process) => process.stages.map((stage) => ({ process, stage }))).find((assignment) => assignment.stage.cameraId === camera.id); return <article className="monitor-card live-card" key={camera.id}><button className="monitor-open" type="button" onClick={() => { vision.setActiveCameraId(camera.id); setPage('camera-detail'); }}><div className="monitor-feed"><EmptyFeed compact cameraId={camera.id} /><span className={`camera-status ${camera.sourceStatus !== 'ready' || machineStopped ? 'stopped' : ''}`}><i /> {vision.running[camera.id] ? 'Detecting' : camera.sourceStatus === 'ready' ? 'Paused' : 'Not connected'}</span><span className="expand"><Maximize2 size={15} /></span></div><div className="monitor-title"><span><strong>{camera.name}</strong><small>{camera.location} · {camera.department}</small><em><Route size={12} />{processAssignment ? `${processAssignment.stage.name} · ${processAssignment.process.name}` : 'No station mapping'}</em></span><ChevronRight size={18} /></div></button><div className="camera-parameters"><span><small>Worker present</small><strong>{people}</strong></span><span><small>Workers working</small><strong>{working}</strong></span><span><small>Workers idle</small><strong>{idle}</strong></span><span><small>Output count</small><strong>{count}</strong></span><span><small>Productivity</small><strong>{productivity}%</strong></span><span><small>Machine status</small><strong className={machineStopped ? 'danger-text' : 'success-text'}>{machineStopped ? 'STOPPED' : frame ? 'RUNNING' : 'WAITING'}</strong></span></div><footer className="monitor-controls"><button className="secondary" type="button" onClick={() => { vision.setActiveCameraId(camera.id); setPage('add-camera'); }}><Settings2 size={14} /> Configure</button><button className={vision.running[camera.id] ? 'secondary' : 'primary'} disabled={camera.sourceStatus !== 'ready'} type="button" onClick={() => void toggle(camera)}>{vision.running[camera.id] ? <Pause size={14} /> : <Play size={14} />}{vision.running[camera.id] ? 'Pause engine' : 'Start engine'}</button></footer>{camera.error ? <p className="camera-error-copy">{camera.error}</p> : null}</article>; })}</section><section className="panel engine-summary"><div><span className={`engine-dot ${vision.workerStatus}`} /><strong>{vision.workerStatus === 'online' ? 'OptiVision 2 engine online' : 'Signal worker offline'}</strong><small>{vision.workerDetail}</small></div><span>Ultralytics inference</span><span>Supervision ByteTrack</span><span>Strict ROI filtering</span><span>Direct-motion counting</span></section></div>;
}

function LegacyCameraDetail({ setPage }: { setPage: (page: Page) => void }) {
  return <div className="page-stack"><button className="back-link" type="button" onClick={() => setPage('monitoring')}><ArrowLeft size={15} /> All cameras</button><div className="detail-heading"><div><span><i /> LIVE</span><h2>Assembly Line 01</h2><p>Plant A · Assembly · Line 01</p></div><div><button className="secondary" type="button"><Maximize2 size={15} /> Full screen</button><button className="icon-button" type="button"><MoreHorizontal size={18} /></button></div></div><section className="camera-detail-layout"><div className="panel detail-feed"><EmptyFeed /></div><aside className="panel intelligence-panel"><div className="panel-tabs"><button className="active" type="button">Rules</button><button type="button">Business values</button></div><span className="eyebrow">DETECTION RULES</span>{[['Worker Present', 'TRUE'], ['Worker Working', 'TRUE'], ['Worker Idle', 'FALSE'], ['Machine Running', 'TRUE'], ['Material Present', 'TRUE']].map(([name, value]) => <div className="rule-status" key={name}><span>{name}</span><Pill tone={value === 'TRUE' ? 'green' : 'neutral'}>{value}</Pill></div>)}<span className="eyebrow business-label">BUSINESS RULES</span>{[['Worker Productivity', '86%'], ['Machine Utilization', '91%'], ['Output Count', '427']].map(([name, value]) => <div className="business-value" key={name}><span>{name}</span><strong>{value}</strong></div>)}</aside></section><section className="panel event-history"><div className="section-heading"><div><span className="eyebrow">EVENT HISTORY</span><h2>Camera timeline</h2><p>Detection rules, business changes, automation triggers, and alerts.</p></div><select><option>All events</option><option>Alerts only</option><option>Automation only</option></select></div>{[
    ['10:43:12', 'Machine Stopped > 5m', 'Automation triggered', 'WhatsApp + Email sent', 'critical'],
    ['10:38:20', 'Machine Stopped', 'Detection rule changed', 'Evidence available', 'warning'],
    ['10:32:15', 'Worker Idle · Worker 04', 'Duration: 5m', 'Detection rule trigger', 'neutral'],
    ['10:20:04', 'Output Count reached 400', 'Business rule changed', 'No action configured', 'success']
  ].map(([time, event, detail, action, tone]) => <button className="timeline-row" type="button" key={time}><time>{time}</time><i className={tone} /><span><strong>{event}</strong><small>{detail}</small></span><Pill tone={tone === 'critical' ? 'red' : tone === 'warning' ? 'orange' : tone === 'success' ? 'green' : 'neutral'}>{action}</Pill><ChevronRight size={16} /></button>)}</section></div>;
}

function CameraDetail({ setPage }: { setPage: (page: Page) => void }) {
  const vision = useVision();
  const camera = vision.getCamera();
  const frame = vision.frames[camera.id];
  const session = vision.metrics[camera.id];
  const workerObserved = (session?.activeSeconds ?? 0) + (session?.idleSeconds ?? 0);
  const machineObserved = (session?.uptimeSeconds ?? 0) + (session?.downtimeSeconds ?? 0);
  const productivity = workerObserved ? Math.round((session?.activeSeconds ?? 0) / workerObserved * 100) : null;
  const utilization = machineObserved ? Math.round((session?.uptimeSeconds ?? 0) / machineObserved * 100) : null;
  const counter = frame?.signals.find((signal) => signal.kind === 'line_crossing_count');
  const count = session?.lastOutputValue === null || session?.lastOutputValue === undefined ? null : Math.round(session.outputCount);
  const cameraEvents = vision.events.filter((event) => event.cameraId === camera.id).slice(0, 50);
  const formatDuration = (seconds: number) => `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m ${Math.floor(seconds % 60)}s`;
  const [error, setError] = useState('');
  async function toggle() { setError(''); try { await vision.toggleEngine(camera.id); } catch (toggleError) { setError(toggleError instanceof Error ? toggleError.message : 'Could not start the engine.'); } }
  return <div className="page-stack"><button className="back-link" type="button" onClick={() => setPage('monitoring')}><ArrowLeft size={15} /> All cameras</button><div className="detail-heading"><div><span><i /> {vision.running[camera.id] ? 'DETECTING' : camera.sourceStatus === 'ready' ? 'PAUSED' : 'NOT CONNECTED'}</span><h2>{camera.name}</h2><p>{camera.location} · {camera.department} · {camera.productionLine}</p></div><div><button className="secondary" type="button" onClick={() => void vision.resetCamera(camera.id)}><TimerReset size={15} /> Reset session</button><button className={vision.running[camera.id] ? 'secondary' : 'primary'} disabled={camera.sourceStatus !== 'ready'} type="button" onClick={() => void toggle()}>{vision.running[camera.id] ? <Pause size={15} /> : <Play size={15} />}{vision.running[camera.id] ? 'Pause engine' : 'Start engine'}</button><button className="icon-button" type="button" onClick={() => setPage('add-camera')}><Settings2 size={18} /></button></div></div>{error ? <div className="training-notice error"><AlertTriangle size={16} />{error}</div> : null}<section className="camera-detail-layout"><div className="panel detail-feed"><EmptyFeed cameraId={camera.id} /></div><aside className="panel intelligence-panel"><div className="panel-tabs"><button className="active" type="button">Rules</button><button type="button">Business values</button></div><span className="eyebrow">DETECTION SIGNALS</span>{camera.configuration.signals.map((signal) => { const state = frame?.signals.find((item) => item.signalId === signal.id); return <div className="rule-status" key={signal.id}><span>{signal.name}</span><Pill tone={state?.active ? 'green' : 'neutral'}>{state ? state.active ? String(state.value).toUpperCase() : 'FALSE' : 'UNKNOWN'}</Pill></div>; })}<span className="eyebrow business-label">DETECTION RULES</span>{camera.configuration.rules.map((rule) => { const state = frame?.rules.find((item) => item.ruleId === rule.id); return <div className="rule-status" key={rule.id}><span>{rule.name}</span><Pill tone={state?.active ? 'green' : 'neutral'}>{state ? state.active ? 'TRUE' : 'FALSE' : 'UNKNOWN'}</Pill></div>; })}</aside></section><section className="business-kpis"><article className="panel"><small>Worker productivity</small><strong>{productivity === null ? 'No data' : `${productivity}%`}</strong><p>{session ? `${formatDuration(session.activeSeconds)} active · ${session.workerState}` : 'Waiting for evidence'}</p></article><article className="panel"><small>Machine utilization</small><strong>{utilization === null ? 'No data' : `${utilization}%`}</strong><p>{session ? `${formatDuration(session.downtimeSeconds)} stopped · ${session.machineState}` : 'Waiting for evidence'}</p></article><article className="panel"><small>Output count</small><strong>{count ?? 'No data'}</strong><p>{Number(counter?.evidence.ratePerMinute ?? 0).toFixed(0)} per minute</p></article><article className="panel"><small>Live detections</small><strong>{frame?.detections.length ?? 0}</strong><p>{frame?.detections.filter((detection) => detection.trackConfirmed).length ?? 0} tracked</p></article></section>{counter ? <section className="panel conveyor-evidence"><header><div><span className="eyebrow">SUPERVISION CONVEYOR COUNTING</span><h2>Direct motion pass evidence</h2></div><Pill tone="green">{String(frame?.pipeline.lineCrossing ?? 'Supervision LineZone')}</Pill></header><div><span><small>Inbound</small><strong>{Number(counter.evidence.inboundCount ?? 0)}</strong></span><span><small>Outbound</small><strong>{Number(counter.evidence.outboundCount ?? 0)}</strong></span><span><small>Live tracks</small><strong>{counter.evidence.liveTracks?.length ?? 0}</strong></span><span><small>Foreground</small><strong>{Number(counter.evidence.foregroundPercent ?? 0).toFixed(1)}%</strong></span></div>{counter.evidence.motionMask ? <img alt="Grey and white foreground motion mask" src={String(counter.evidence.motionMask)} /> : null}</section> : null}<section className="panel event-history"><div className="section-heading"><div><span className="eyebrow">EVENT HISTORY</span><h2>Camera timeline</h2><p>Live signal state changes, rule outputs, errors, and counted passes.</p></div><Pill>{cameraEvents.length} events</Pill></div>{cameraEvents.length ? cameraEvents.map((event) => <div className="timeline-row" key={event.id}><time>{new Date(event.timestamp * 1000).toLocaleTimeString()}</time><i className={event.type === 'error' ? 'critical' : event.type === 'count' ? 'success' : 'warning'} /><span><strong>{event.title}</strong><small>{event.detail}</small></span><Pill tone={event.type === 'error' ? 'red' : event.type === 'count' ? 'green' : 'orange'}>{event.type}</Pill><ChevronRight size={16} /></div>) : <div className="timeline-empty">Start the camera engine to build its event history.</div>}</section></div>;
}

const widgetTypes = ['Camera Feed', 'KPI', 'Number', 'Percentage', 'Counter', 'Chart', 'Trend', 'Table', 'Event List', 'Alert List', 'Rule Status', 'Business Rule', 'Formula', 'Comparison', 'Heatmap'];

function DashboardPage() {
  const vision = useVision();
  const dashboardCamera = vision.getCamera();
  const dashboardFrame = vision.frames[dashboardCamera.id];
  const dashboardMetrics = vision.metrics[dashboardCamera.id];
  const workerObserved = (dashboardMetrics?.activeSeconds ?? 0) + (dashboardMetrics?.idleSeconds ?? 0);
  const machineObserved = (dashboardMetrics?.uptimeSeconds ?? 0) + (dashboardMetrics?.downtimeSeconds ?? 0);
  const workerProductivity = workerObserved ? Math.round((dashboardMetrics?.activeSeconds ?? 0) / workerObserved * 100) : null;
  const machineUtilization = machineObserved ? Math.round((dashboardMetrics?.uptimeSeconds ?? 0) / machineObserved * 100) : null;
  const outputCount = dashboardMetrics?.lastOutputValue === null || dashboardMetrics?.lastOutputValue === undefined ? null : Math.round(dashboardMetrics.outputCount);
  const recentDashboardEvents = vision.events.slice(0, 3);
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState('KPI');
  const [widgets, setWidgets] = useState<string[]>(loadDashboardWidgets);
  useEffect(() => { writeStoredJson(dashboardWidgetsStorageKey, widgets); }, [widgets]);
  return <div className="page-stack"><div className="page-title"><div><span className="eyebrow">MAIN DASHBOARD</span><h2>Operations overview</h2><p>Live business values calculated from the selected camera’s signal and rule results.</p></div><div className="definition-actions"><select value={vision.activeCameraId} onChange={(event) => vision.setActiveCameraId(event.target.value)}>{vision.cameras.map((camera) => <option value={camera.id} key={camera.id}>{camera.name}</option>)}</select><button className="primary" type="button" onClick={() => setAdding(true)}><Plus size={16} /> Add Widget</button></div></div><section className="dashboard-grid">{widgets.map((widget, index) => <article className={`dashboard-widget panel widget-${index}`} key={`${widget}-${index}`}><header><span><small>{index < 3 ? 'CURRENT SESSION' : 'LIVE OPERATIONS'}</small><strong>{widget}</strong></span><button type="button"><MoreHorizontal size={17} /></button></header>{index === 0 && <div className="big-kpi"><strong>{workerProductivity === null ? 'No data' : `${workerProductivity}%`}</strong><Pill tone={vision.running[dashboardCamera.id] ? 'green' : 'neutral'}>{vision.running[dashboardCamera.id] ? 'Live' : 'Paused'}</Pill><small>Working time / presence time</small></div>}{index === 1 && <div className="big-kpi"><strong>{machineUtilization === null ? 'No data' : `${machineUtilization}%`}</strong><Pill tone={vision.running[dashboardCamera.id] ? 'green' : 'neutral'}>{vision.running[dashboardCamera.id] ? 'Live' : 'Paused'}</Pill><small>Running time / observed time</small></div>}{index === 2 && <div className="big-kpi"><strong>{outputCount ?? 'No data'}</strong><Pill tone="orange">Current session</Pill><small>Confirmed conveyor passes</small></div>}{index === 3 && <EmptyFeed cameraId={dashboardCamera.id} compact />}{index === 4 && <div className="chart"><div className="chart-bars">{[42, 58, 51, 72, 68, Math.max(5, workerProductivity ?? 0), 77, Math.max(5, machineUtilization ?? 0), 86, Math.max(5, Math.min(100, outputCount ?? 0))].map((height, bar) => <i key={bar} style={{ height: `${height}%` }} />)}</div><div><span>Start</span><span>Current session</span><span>Now</span></div></div>}{index === 5 && <div className="mini-alerts">{recentDashboardEvents.length ? recentDashboardEvents.map((event) => <span key={event.id}><i className={event.type === 'error' ? 'red' : event.type === 'count' ? 'green' : 'orange'} /><strong>{event.title}</strong><small>{new Date(event.timestamp * 1000).toLocaleTimeString()}</small></span>) : <span><i className="green" /><strong>No live events yet</strong><small>Start the engine</small></span>}</div>}</article>)}</section>{adding && <div className="modal-backdrop"><section className="widget-modal"><header><div><span className="eyebrow">DASHBOARD BUILDER</span><h2>Add Widget</h2><p>Select the widget and configure its data.</p></div><button className="icon-button" type="button" onClick={() => setAdding(false)}><X size={18} /></button></header><div className="widget-modal-body"><div className="widget-types">{widgetTypes.map((type) => <button className={selected === type ? 'selected' : ''} type="button" key={type} onClick={() => setSelected(type)}>{type === 'Camera Feed' ? <Camera size={17} /> : type === 'Chart' || type === 'Trend' ? <LineChart size={17} /> : <Gauge size={17} />}<span><strong>{type}</strong><small>Configured operational value</small></span>{selected === type && <Check size={14} />}</button>)}</div><div className="widget-config"><h3>Configure {selected}</h3><FormField label="Title"><input defaultValue={selected} /></FormField><FormField label="Data source"><select><option>Business Rule</option><option>Detection Rule</option><option>Camera</option></select></FormField><FormField label="Camera"><select value={vision.activeCameraId} onChange={(event) => vision.setActiveCameraId(event.target.value)}>{vision.cameras.map((camera) => <option value={camera.id} key={camera.id}>{camera.name}</option>)}</select></FormField><FormField label="Rule"><select><option>Worker Productivity</option><option>Machine Utilization</option><option>Output Count</option>{dashboardCamera.configuration.rules.map((rule) => <option key={rule.id}>{rule.name}</option>)}</select></FormField><FormField label="Time period"><select><option>Current session</option><option>Current shift</option><option>Today</option></select></FormField><FormField label="Formula"><input defaultValue="Current value" /></FormField><div className="form-grid"><FormField label="Refresh interval"><select><option>Live</option><option>5 seconds</option><option>1 minute</option></select></FormField><FormField label="Display format"><select><option>Number</option><option>Percentage</option></select></FormField><FormField label="Size"><select><option>Medium</option><option>Small</option><option>Large</option></select></FormField></div></div></div><footer><button className="secondary" type="button" onClick={() => setAdding(false)}>Cancel</button><button className="primary" type="button" onClick={() => { setWidgets([...widgets, selected]); setAdding(false); }}><Plus size={15} /> Add Widget</button></footer></section></div>}</div>;
}

function NotificationsPage({ setPage }: { setPage: (page: Page) => void }) {
  const vision = useVision();
  const [readBefore, setReadBefore] = useState(0);
  const visibleEvents = distinctNotificationEvents(vision.events.filter((event) => event.timestamp > readBefore));
  return <div className="page-stack"><div className="page-title"><div><span className="eyebrow">NOTIFICATION CENTER</span><h2>Operational notifications</h2><p>Live signal transitions, rule outputs, conveyor counts, and engine errors stay linked to their camera.</p></div><button className="secondary" disabled={!visibleEvents.length} type="button" onClick={() => setReadBefore(Date.now() / 1000)}>Mark all as read</button></div>{vision.workerStatus === 'offline' ? <div className="training-notice error"><AlertTriangle size={16} /><span><strong>Python analysis worker is offline</strong><small>The repeated “Failed to fetch” entries were connection attempts to the unavailable worker. New analysis requests are paused until it is online again.</small></span></div> : null}<section className="panel notifications-list">{visibleEvents.map((event) => {
    const tone = event.type === 'error' ? 'critical' : event.type === 'count' ? 'success' : 'warning';
    const camera = vision.getCamera(event.cameraId);
    return <button type="button" key={event.id} onClick={() => { vision.setActiveCameraId(event.cameraId); setPage('camera-detail'); }}><span className={`notification-icon ${tone}`}>{tone === 'critical' ? <AlertTriangle size={19} /> : tone === 'warning' ? <TimerReset size={19} /> : <Check size={19} />}</span><span><strong>{event.title}</strong><p>{camera.name} · {event.detail}</p><small>{new Date(event.timestamp * 1000).toLocaleString()}</small></span><ChevronRight size={17} /></button>;
  })}{!visibleEvents.length ? <div className="notifications-empty"><Bell size={28} /><strong>No unread operational notifications</strong><p>Start a camera engine to evaluate its signals and rules.</p></div> : null}</section></div>;
}

function LegacyLifecycleSetupRedirect({ setPage }: { setPage: (page: Page) => void }) {
  const vision = useVision();
  useEffect(() => {
    const camera = vision.getCamera();
    const legacyStepKey = `optivision-camera-wizard-step:${camera.id}`;
    const draft = readSetupDraft(camera.id, legacyStepKey, wizardSteps.length - 1);
    writeSetupDraft({ ...draft, selectedPlantId: vision.selectedPlantId, currentStep: 10, updatedAt: Date.now() });
    setPage('add-camera');
  }, []);
  return <section className="panel setup-empty-state"><Route size={26} /><strong>Opening lifecycle setup</strong><p>Your saved station configuration is being opened in the unified Setup flow.</p></section>;
}

export function App() {
  const [page, setPage] = useState<Page>(loadStoredPage);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  useEffect(() => { writeStoredString(pageStorageKey, page); }, [page]);
  const content = useMemo(() => {
    if (page === 'setup-home') return <SetupHome setPage={setPage} />;
    if (page === 'add-camera') return <CameraWizard setPage={setPage} />;
    if (page === 'cameras') return <CamerasPage setPage={setPage} />;
    if (page === 'signals') return <DefinitionsPageV2 type="signals" />;
    if (page === 'detection-rules') return <DefinitionsPageV2 type="detection-rules" />;
    if (page === 'business-rules') return <DefinitionsPageV2 type="business-rules" />;
    if (page === 'automations') return <AutomationsPage />;
    if (page === 'integrations') return <IntegrationsPage />;
    if (page === 'training') return <TrainingPage />;
    if (page === 'camera-detail') return <CameraDetail setPage={setPage} />;
    if (page === 'dashboard') return <DashboardPage />;
    if (page === 'lpr-cycle') return <LegacyLifecycleSetupRedirect setPage={setPage} />;
    if (page === 'lpr-tracking') return <LprTrackingPage onManageStages={() => setPage('lpr-cycle')} />;
    if (page === 'notifications') return <NotificationsPage setPage={setPage} />;
    return <MonitoringPage setPage={setPage} />;
  }, [page]);
  return <div className="app-shell"><Sidebar page={page} setPage={(next) => { setPage(next); setSidebarOpen(false); }} open={sidebarOpen} /><div className="workspace"><AppHeader page={page} setPage={setPage} sidebarOpen={sidebarOpen} setSidebarOpen={setSidebarOpen} /><main className="content">{content}</main></div></div>;
}
