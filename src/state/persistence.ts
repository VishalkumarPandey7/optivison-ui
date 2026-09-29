export type StorageValidator<T> = (value: unknown) => value is T;

export function readStoredJson<T>(key: string, fallback: T, validator?: StorageValidator<T>): T {
  try {
    const value = window.localStorage.getItem(key);
    if (value === null) return fallback;
    const parsed: unknown = JSON.parse(value);
    return !validator || validator(parsed) ? parsed as T : fallback;
  } catch {
    return fallback;
  }
}

export function writeStoredJson(key: string, value: unknown): boolean {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function readStoredString(key: string, fallback = ''): string {
  try {
    return window.localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

export function writeStoredString(key: string, value: string): boolean {
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function backupStoredValue(sourceKey: string, backupKey: string): boolean {
  try {
    if (window.localStorage.getItem(backupKey) !== null) return true;
    const value = window.localStorage.getItem(sourceKey);
    if (value === null) return true;
    window.localStorage.setItem(backupKey, value);
    return true;
  } catch {
    return false;
  }
}

export const isArray = <T>(value: unknown): value is T[] => Array.isArray(value);
