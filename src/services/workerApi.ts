const DEFAULT_WORKER_URL = 'http://127.0.0.1:8770';
const DEFAULT_TIMEOUT_MS = 15_000;

type ViteImportMeta = ImportMeta & {
  env?: {
    VITE_OPTIVISION_WORKER_URL?: string;
    VITE_OPTIVISION_REQUEST_TIMEOUT_MS?: string;
    VITE_OPTIVISION_ANALYSIS_INTERVAL_MS?: string;
    VITE_OPTIVISION_MAX_CONCURRENT_ANALYSES?: string;
  };
};

const runtimeEnv = (import.meta as ViteImportMeta).env;
const configuredWorkerUrl = runtimeEnv?.VITE_OPTIVISION_WORKER_URL?.trim();

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, Math.round(parsed))) : fallback;
}

export const workerUrl = (configuredWorkerUrl || DEFAULT_WORKER_URL).replace(/\/$/, '');
export const visionRuntimeConfig = {
  requestTimeoutMs: boundedInteger(runtimeEnv?.VITE_OPTIVISION_REQUEST_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1_000, 120_000),
  analysisIntervalMs: boundedInteger(runtimeEnv?.VITE_OPTIVISION_ANALYSIS_INTERVAL_MS, 500, 200, 10_000),
  maxConcurrentAnalyses: boundedInteger(runtimeEnv?.VITE_OPTIVISION_MAX_CONCURRENT_ANALYSES, 2, 1, 7),
} as const;

export interface WorkerRequestOptions extends RequestInit {
  timeoutMs?: number;
}

export class WorkerRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status = 0, code = 'WORKER_REQUEST_FAILED') {
    super(message);
    this.name = 'WorkerRequestError';
    this.status = status;
    this.code = code;
  }
}

interface WorkerErrorPayload {
  ok?: boolean;
  error?: string;
  message?: string;
  code?: string;
}

export async function requestJson<T>(path: string, options: WorkerRequestOptions = {}): Promise<T> {
  const { timeoutMs = visionRuntimeConfig.requestTimeoutMs, signal, ...init } = options;
  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  signal?.addEventListener('abort', forwardAbort, { once: true });
  const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${workerUrl}${path}`, { ...init, signal: controller.signal });
    const responseText = await response.text();
    let payload: WorkerErrorPayload & T;
    try {
      payload = (responseText ? JSON.parse(responseText) : {}) as WorkerErrorPayload & T;
    } catch {
      throw new WorkerRequestError(
        `Worker returned an invalid response (${response.status}).`,
        response.status,
        'INVALID_WORKER_RESPONSE',
      );
    }
    if (!response.ok || payload.ok === false) {
      throw new WorkerRequestError(
        payload.error || payload.message || `Worker returned ${response.status}.`,
        response.status,
        payload.code || 'WORKER_REQUEST_FAILED',
      );
    }
    return payload as T;
  } catch (error) {
    if (error instanceof WorkerRequestError) throw error;
    if (controller.signal.aborted) {
      if (signal?.aborted) throw new WorkerRequestError('Worker request was cancelled.', 0, 'WORKER_REQUEST_CANCELLED');
      throw new WorkerRequestError(`Worker did not respond within ${Math.round(timeoutMs / 1000)} seconds.`, 0, 'WORKER_TIMEOUT');
    }
    throw new WorkerRequestError(error instanceof Error ? error.message : 'Could not reach the AI worker.', 0, 'WORKER_OFFLINE');
  } finally {
    globalThis.clearTimeout(timeout);
    signal?.removeEventListener('abort', forwardAbort);
  }
}
