import { normalizeOperationalMetricConfiguration } from './operationalMetrics.js';

export interface PlantRecord {
  id: string;
  name: string;
}

export type MonitoringMetricSource = 'system' | 'signal' | 'rule' | 'business';
export type MonitoringMetricFormat = 'number' | 'percent' | 'duration' | 'status';

export interface CameraCardMetric {
  id: string;
  label: string;
  source: MonitoringMetricSource;
  sourceId: string;
  format: MonitoringMetricFormat;
}

export interface SetupDraftRecord {
  flowVersion: number;
  cameraId: string;
  selectedPlantId?: string;
  currentStep: number;
  sourceType?: string;
  externalUrl?: string;
  activeZoneId?: string;
  drawMode?: 'zone' | 'line';
  signalMode?: 'existing' | 'new';
  newSignal?: Record<string, unknown>;
  updatedAt: number;
}

export interface MigratedLifecycleAutomation {
  id: string;
  name: string;
  audience: string;
  trigger: string;
  channels: string[];
  processId: string;
  stationIds: string[];
  unresolvedStationNames: string[];
  shareImage: boolean;
  active: boolean;
}

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const nonEmptyString = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim());
const normalizedName = (value: string) => value.trim().replace(/\s+/g, ' ').toLocaleLowerCase();

function stableHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function plantIdForName(name: string) {
  const normalized = normalizedName(name || 'Unassigned Plant');
  const slug = normalized.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 36) || 'plant';
  return `plant-${slug}-${stableHash(normalized)}`;
}

export function defaultCameraCardMetrics(): CameraCardMetric[] {
  return [
    { id: 'worker-present', label: 'Worker present', source: 'system', sourceId: 'worker_present', format: 'number' },
    { id: 'workers-working', label: 'Workers working', source: 'rule', sourceId: 'worker-working', format: 'number' },
    { id: 'workers-idle', label: 'Workers idle', source: 'rule', sourceId: 'worker-idle', format: 'number' },
    { id: 'output-count', label: 'Output count', source: 'business', sourceId: 'output-count', format: 'number' },
    { id: 'productivity', label: 'Productivity', source: 'business', sourceId: 'worker-productivity', format: 'percent' },
    { id: 'machine-status', label: 'Machine status', source: 'system', sourceId: 'machine_status', format: 'status' }
  ];
}

function isCameraCardMetric(value: unknown): value is CameraCardMetric {
  if (!isRecord(value)) return false;
  return nonEmptyString(value.id)
    && nonEmptyString(value.label)
    && ['system', 'signal', 'rule', 'business'].includes(String(value.source))
    && nonEmptyString(value.sourceId)
    && ['number', 'percent', 'duration', 'status'].includes(String(value.format));
}

export function migratePlantsAndCameras(rawCameras: unknown, rawPlants: unknown) {
  const cameras = Array.isArray(rawCameras) ? rawCameras.filter(isRecord) : [];
  const plants: PlantRecord[] = [];

  if (Array.isArray(rawPlants)) rawPlants.forEach((item) => {
    if (!isRecord(item) || !nonEmptyString(item.name)) return;
    const name = item.name.trim().replace(/\s+/g, ' ');
    const id = nonEmptyString(item.id) ? item.id : plantIdForName(name);
    if (!plants.some((plant) => plant.id === id || normalizedName(plant.name) === normalizedName(name))) plants.push({ id, name });
  });

  const migratedCameras = cameras.map((camera) => {
    const location = nonEmptyString(camera.location) ? camera.location.trim().replace(/\s+/g, ' ') : 'Unassigned Plant';
    const existingPlant = plants.find((plant) => plant.id === camera.plantId)
      ?? plants.find((plant) => normalizedName(plant.name) === normalizedName(location));
    const plant = existingPlant ?? { id: plantIdForName(location), name: location };
    if (!existingPlant) plants.push(plant);

    const configuration = isRecord(camera.configuration) ? camera.configuration : {};
    const existingMetrics = Array.isArray(configuration.monitoringMetrics)
      ? configuration.monitoringMetrics.filter(isCameraCardMetric)
      : [];

    return {
      ...camera,
      plantId: plant.id,
      location: plant.name,
      configuration: {
        ...configuration,
        monitoringMetrics: existingMetrics.length ? existingMetrics : defaultCameraCardMetrics(),
        operationalMetrics: normalizeOperationalMetricConfiguration(configuration.operationalMetrics)
      }
    };
  });

  return { cameras: migratedCameras, plants };
}

export function migrateLprProcesses(rawProcesses: unknown): UnknownRecord[] {
  if (!Array.isArray(rawProcesses)) return [];
  return rawProcesses.filter(isRecord).map<UnknownRecord>((process) => {
    const stages = Array.isArray(process.stages) ? process.stages.filter(isRecord) : [];
    return {
      ...process,
      stages: stages.map((stage, index) => ({ ...stage, order: index }))
    };
  });
}

export function migrateLifecycleAutomations(rawAutomations: unknown, rawProcesses: unknown): MigratedLifecycleAutomation[] {
  const processes = migrateLprProcesses(rawProcesses);
  if (!Array.isArray(rawAutomations)) return [];

  return rawAutomations.filter(isRecord).map((automation, index) => {
    const process = processes.find((item) => item.id === automation.processId) ?? processes[0];
    const stages = process && Array.isArray(process.stages) ? process.stages.filter(isRecord) : [];
    const stationReferences = [
      ...(Array.isArray(automation.stationIds) ? automation.stationIds : []),
      ...(Array.isArray(automation.stations) ? automation.stations : [])
    ].filter(nonEmptyString);
    const stationIds: string[] = [];
    const unresolvedStationNames: string[] = [];

    stationReferences.forEach((reference) => {
      const stage = stages.find((item) => item.id === reference)
        ?? stages.find((item) => nonEmptyString(item.name) && normalizedName(item.name) === normalizedName(reference));
      if (stage && nonEmptyString(stage.id)) {
        if (!stationIds.includes(stage.id)) stationIds.push(stage.id);
      } else if (!unresolvedStationNames.includes(reference)) {
        unresolvedStationNames.push(reference);
      }
    });

    if (Array.isArray(automation.unresolvedStationNames)) automation.unresolvedStationNames.filter(nonEmptyString).forEach((name) => {
      if (!unresolvedStationNames.includes(name)) unresolvedStationNames.push(name);
    });

    return {
      id: nonEmptyString(automation.id) ? automation.id : `automation-${index + 1}`,
      name: nonEmptyString(automation.name) ? automation.name : 'Lifecycle automation',
      audience: nonEmptyString(automation.audience) ? automation.audience : 'Admin / Workshop Manager',
      trigger: nonEmptyString(automation.trigger) ? automation.trigger : 'Vehicle reached station',
      channels: Array.isArray(automation.channels) ? automation.channels.filter(nonEmptyString) : [],
      processId: process && nonEmptyString(process.id) ? process.id : '',
      stationIds,
      unresolvedStationNames,
      shareImage: automation.shareImage === true,
      active: automation.active !== false
    };
  });
}

export function isReadableJourney(value: unknown) {
  if (!isRecord(value)) return false;
  if (!nonEmptyString(value.id) || !nonEmptyString(value.processId) || !nonEmptyString(value.currentStageId)) return false;
  if (!Array.isArray(value.visits) || !Array.isArray(value.events)) return false;
  return value.visits.every((visit) => isRecord(visit) && nonEmptyString(visit.stageId));
}
