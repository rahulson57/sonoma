import { describe, expect, it } from 'vitest';
import {
  LEDGER_ACTORS,
  LEDGER_EVENT_TYPES,
  isLedgerActor,
  isLedgerEventType,
} from '../../../src/ledger/event-types.js';

// Transcribed from SPEC-004 "Event types (v1)" — the test's own copy, so an edit to the enum
// that is not also a spec change fails here.
const SPEC_004_V1_TYPES = [
  'run.created',
  'agent.started',
  'context.built',
  'model.requested',
  'model.responded',
  'tool.requested',
  'tool.completed',
  'tool.failed',
  'workspace.changed',
  'workspace.file_skipped',
  'side_effect.requested',
  'side_effect.committed',
  'checkpoint.created',
  'agent.interrupted',
  'agent.resumed',
  'agent.forked',
  'agent.rolled_back',
  'distill.completed',
  'export.unsafe',
];

describe('ledger event-type enum (SPEC-004 v1)', () => {
  it('contains exactly the 19 v1 types listed in the spec', () => {
    expect(LEDGER_EVENT_TYPES).toHaveLength(19);
    expect(new Set(LEDGER_EVENT_TYPES).size).toBe(19);
    expect([...LEDGER_EVENT_TYPES].sort()).toEqual([...SPEC_004_V1_TYPES].sort());
  });

  it('includes agent.rolled_back', () => {
    expect(LEDGER_EVENT_TYPES).toContain('agent.rolled_back');
    expect(isLedgerEventType('agent.rolled_back')).toBe(true);
  });

  it('accepts every listed type', () => {
    for (const type of SPEC_004_V1_TYPES) expect(isLedgerEventType(type)).toBe(true);
  });

  it('rejects anything outside the enum', () => {
    for (const bad of ['state.declared', 'agent.suspended', 'tool.Completed', 'tool.completed ', '', 'run', 7, null, undefined, {}]) {
      expect(isLedgerEventType(bad)).toBe(false);
    }
  });

  it('actors are exactly agent, runtime, human', () => {
    expect([...LEDGER_ACTORS]).toEqual(['agent', 'runtime', 'human']);
    expect(isLedgerActor('human')).toBe(true);
    expect(isLedgerActor('adapter')).toBe(false);
    expect(isLedgerActor('sdk')).toBe(false);
  });
});
