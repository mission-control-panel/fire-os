import type { FireOSState } from '../../types/state';
import { isPersistedPortfolioData } from '../../types/state';

const MAX_ASSISTANT_UNDO = 10;
const UNDO_SUFFIX = ':assistant-undo';
type PersistedSnapshot = Record<string, unknown>;
interface AssistantUndoEntry { before: PersistedSnapshot; afterFingerprint: string }

function getStorage(): Storage | null { return typeof sessionStorage === 'undefined' ? null : sessionStorage; }
function key(storageKey: string): string { return `${storageKey}${UNDO_SUFFIX}`; }
function readEntries(storageKey: string): AssistantUndoEntry[] {
  try {
    const raw = getStorage()?.getItem(key(storageKey));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is AssistantUndoEntry =>
      typeof entry === 'object' && entry !== null &&
      typeof (entry as AssistantUndoEntry).afterFingerprint === 'string' &&
      typeof (entry as AssistantUndoEntry).before === 'object' &&
      (entry as AssistantUndoEntry).before !== null &&
      isPersistedPortfolioData((entry as AssistantUndoEntry).before));
  } catch { return []; }
}

export function persistedStateFingerprint(state: FireOSState): string {
  const { currentUser, _lastSavedAt, _syncMetadata, ...persisted } = state;
  void currentUser; void _lastSavedAt; void _syncMetadata;
  return JSON.stringify(persisted);
}

export function recordAssistantUndo(storageKey: string, before: PersistedSnapshot, afterFingerprint: string): boolean {
  const storage = getStorage();
  if (!storage) return false;
  const entries = readEntries(storageKey);
  entries.push({ before, afterFingerprint });
  try {
    storage.setItem(key(storageKey), JSON.stringify(entries.slice(-MAX_ASSISTANT_UNDO)));
    return true;
  } catch {
    return false;
  }
}

/** Restore only the most recent assistant action when no intervening edit occurred. */
export function undoLastAssistantAction(storageKey: string, state: FireOSState): boolean {
  const storage = getStorage();
  const entries = readEntries(storageKey);
  const entry = entries[entries.length - 1];
  if (!storage || !entry || persistedStateFingerprint(state) !== entry.afterFingerprint) return false;
  try {
    storage.setItem(key(storageKey), JSON.stringify(entries.slice(0, -1)));
  } catch {
    return false;
  }
  const currentUser = state.currentUser;
  const syncMetadata = state._syncMetadata;
  Object.keys(state).forEach((field) => {
    if (field !== 'currentUser' && field !== '_syncMetadata' && field !== '_lastSavedAt') delete state[field as keyof FireOSState];
  });
  Object.assign(state, entry.before, { currentUser, _syncMetadata: syncMetadata });
  return true;
}

export function canUndoAssistantAction(storageKey: string, state: FireOSState): boolean {
  const entries = readEntries(storageKey);
  const entry = entries[entries.length - 1];
  return Boolean(entry && persistedStateFingerprint(state) === entry.afterFingerprint);
}
