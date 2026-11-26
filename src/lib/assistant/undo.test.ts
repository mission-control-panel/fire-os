import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeState } from '../../types/state';
import { persistedStateFingerprint, recordAssistantUndo, undoLastAssistantAction } from './undo';

describe('assistant action undo', () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal('sessionStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
  });

  it('undoes only the matching assistant action', () => {
    const state = initializeState();
    const before = JSON.parse(JSON.stringify({ ...state, profile: { ...state.profile, fiTarget: 1 } }));
    delete before.currentUser;
    delete before._lastSavedAt;
    delete before._syncMetadata;
    state.profile.fiTarget = 2;
    recordAssistantUndo('scope', before, persistedStateFingerprint(state));
    expect(undoLastAssistantAction('scope', state)).toBe(true);
    expect(state.profile.fiTarget).toBe(1);
  });

  it('refuses to undo after an unrelated edit changes the fingerprint', () => {
    const state = initializeState();
    const before = JSON.parse(JSON.stringify({ ...state }));
    delete before.currentUser;
    delete before._lastSavedAt;
    delete before._syncMetadata;
    state.profile.fiTarget = 2;
    recordAssistantUndo('scope', before, persistedStateFingerprint(state));
    state.profile.name = 'Unrelated edit';
    expect(undoLastAssistantAction('scope', state)).toBe(false);
    expect(state.profile.name).toBe('Unrelated edit');
  });
});
