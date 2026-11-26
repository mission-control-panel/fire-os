import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeState } from '../../types/state';
import { stripRuntime } from './proposal';
import { persistedStateFingerprint, recordAssistantUndo, undoLastAssistantAction } from './undo';

describe('assistant action undo', () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal('sessionStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
  });

  it('undoes only the matching assistant action', () => {
    const state = initializeState();
    const beforeState = { ...state, profile: { ...state.profile, fiTarget: 1 } };
    const before = JSON.parse(JSON.stringify(stripRuntime(beforeState)));
    state.profile.fiTarget = 2;
    recordAssistantUndo('scope', before, persistedStateFingerprint(state));
    expect(undoLastAssistantAction('scope', state)).toBe(true);
    expect(state.profile.fiTarget).toBe(1);
  });

  it('refuses to undo after an unrelated edit changes the fingerprint', () => {
    const state = initializeState();
    const before = JSON.parse(JSON.stringify(stripRuntime(state)));
    state.profile.fiTarget = 2;
    recordAssistantUndo('scope', before, persistedStateFingerprint(state));
    state.profile.name = 'Unrelated edit';
    expect(undoLastAssistantAction('scope', state)).toBe(false);
    expect(state.profile.name).toBe('Unrelated edit');
  });

  it('rejects malformed undo snapshots without mutating state', () => {
    const state = initializeState();
    const storage = sessionStorage as Storage;
    storage.setItem('scope:assistant-undo', JSON.stringify([{ before: { profile: {} }, afterFingerprint: persistedStateFingerprint(state) }]));
    expect(undoLastAssistantAction('scope', state)).toBe(false);
    expect(state.profile.name).toBe(initializeState().profile.name);
  });

  it('does not mutate state when removing the undo entry fails', () => {
    const state = initializeState();
    const before = JSON.parse(JSON.stringify(stripRuntime(state)));
    state.profile.fiTarget = 2;
    recordAssistantUndo('scope', before, persistedStateFingerprint(state));
    const storage = sessionStorage as Storage;
    storage.setItem = () => { throw new Error('quota'); };
    expect(undoLastAssistantAction('scope', state)).toBe(false);
    expect(state.profile.fiTarget).toBe(2);
  });
});
