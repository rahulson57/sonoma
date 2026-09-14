/** Local Read-Only Inspector (SPEC-012, `ckpt ui`) public surface. */
export { startInspector, CONTENT_SECURITY_POLICY } from './server.js';
export { readRunRecords } from './run-records.js';
export { MAX_INLINE_DISPLAY_BYTES, displayEvent, payloadRef } from './display.js';
export { InspectorError, InspectorViews, TOOL_NAME_KEYS, checkpointRefText } from './views.js';
export {
  DEFAULT_HOST,
  DEFAULT_PORT,
  type CheckpointDiff,
  type CheckpointPanes,
  type InspectorBackend,
  type InspectorEngine,
  type InspectorEvent,
  type InspectorHandle,
  type InspectorOptions,
  type ListRuns,
  type PayloadRef,
  type TimelineNode,
} from './types.js';
