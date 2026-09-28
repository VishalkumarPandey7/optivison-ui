import { requestJson, workerUrl } from './workerApi';

export interface TrainingAnnotation {
  id: string;
  className: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TrainingImage {
  id: string;
  fileName: string;
  width: number;
  height: number;
  reviewed: boolean;
  annotations: TrainingAnnotation[];
}

export interface TrainingVersion {
  id: string;
  createdAt: number;
  active: boolean;
  metrics: Record<string, number>;
}

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

export interface TrainingState {
  ok: boolean;
  projects: TrainingProject[];
  activatedModel?: { id: string; name: string; classes: string[] };
  deletedModelIds?: string[];
}

const jsonPost = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
} satisfies RequestInit);

export const trainingApi = {
  list: () => requestJson<TrainingState>('/training/projects'),
  create: (input: { name: string; description: string; classes: string[]; baseModel: string }) =>
    requestJson<TrainingState>('/training/projects/create', jsonPost(input)),
  upload: (projectId: string, images: Array<{ fileName: string; data: string }>) =>
    requestJson<TrainingState>('/training/images/upload', { ...jsonPost({ projectId, images }), timeoutMs: 120_000 }),
  saveAnnotations: (projectId: string, imageId: string, annotations: TrainingAnnotation[], reviewed: boolean) =>
    requestJson<TrainingState>('/training/annotations/save', jsonPost({ projectId, imageId, annotations, reviewed })),
  train: (projectId: string, epochs: number, imageSize: number) =>
    requestJson<TrainingState>('/training/start', jsonPost({ projectId, epochs, imageSize })),
  activate: (projectId: string, versionId: string) =>
    requestJson<TrainingState>('/training/activate', jsonPost({ projectId, versionId })),
  delete: (projectId: string) =>
    requestJson<TrainingState>('/training/projects/delete', jsonPost({ projectId })),
  imageUrl: (projectId: string, imageId: string) =>
    `${workerUrl}/training/image?projectId=${encodeURIComponent(projectId)}&imageId=${encodeURIComponent(imageId)}`,
};

export function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('File could not be read.'));
    reader.readAsDataURL(file);
  });
}

