/**
 * Relay-side port of AgentManager's `src/protocol/validateAgentEvent.ts`.
 *
 * WHY A SECOND COPY
 *   The app's validator remains the trust boundary — every event is validated
 *   again inside the PWA before it reaches the store, exactly as it is today.
 *   This copy exists so the relay refuses to *send* malformed or oversized
 *   input in the first place, rather than pushing junk to Apple and letting the
 *   phone sort it out. Defence in depth, not a replacement.
 *
 *   It must stay behaviourally identical to the TypeScript original. The tests
 *   in test/validate.test.mjs pin the shared cases.
 *
 * Like the original this is an ALLOW-LIST: the returned object is rebuilt field
 * by field, so any unknown property in the input is discarded and can never
 * travel onward.
 */

export const PROTOCOL_VERSION = 1;

export const AGENT_EVENT_TYPES = [
  'started',
  'running',
  'idle',
  'completed',
  'needs_approval',
  'needs_input',
  'failed',
];

export const AGENT_EVENT_PROVIDERS = ['claude', 'openai', 'custom'];

export const FIELD_LIMITS = {
  eventId: 128,
  agentId: 128,
  agentName: 80,
  taskId: 128,
  title: 120,
  message: 500,
  projectId: 64,
  projectName: 80,
  subtaskId: 64,
  agentType: 40,
};

/** Mirrors REDACTIONS in the TypeScript validator, in the same order. */
const REDACTIONS = [
  /[A-Za-z]:\\[^\s"']+/g,
  /\/(?:Users|home)\/[^\s"']+/g,
  /\b(?:sk|pk)-[A-Za-z0-9_-]{8,}\b/g,
  /\bBearer\s+[A-Za-z0-9._-]{8,}\b/gi,
  /\b[A-Za-z0-9_-]{40,}\b/g,
];

export function redactSensitive(value) {
  return REDACTIONS.reduce((acc, pattern) => acc.replace(pattern, '[redacted]'), value);
}

function clean(value) {
  return value
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function readString(source, key, errors, options) {
  const raw = source[key];

  if (raw === undefined || raw === null) {
    if (options.required) errors.push(`"${key}" is required`);
    return undefined;
  }
  if (typeof raw !== 'string') {
    errors.push(`"${key}" must be a string`);
    return undefined;
  }

  const value = options.redact ? redactSensitive(clean(raw)) : clean(raw);
  if (value.length === 0) {
    if (options.required) errors.push(`"${key}" must not be empty`);
    return undefined;
  }

  if (value.length > options.max) {
    if (options.truncate) return `${value.slice(0, options.max - 1)}…`;
    errors.push(`"${key}" exceeds ${options.max} characters`);
    return undefined;
  }

  return value;
}

export function parseAgentNotificationEvent(input) {
  const errors = [];

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: ['payload must be a JSON object'] };
  }

  const source = input;

  if (source.version !== PROTOCOL_VERSION) {
    errors.push(`"version" must be ${PROTOCOL_VERSION}`);
  }

  const eventId = readString(source, 'eventId', errors, {
    required: true,
    max: FIELD_LIMITS.eventId,
  });
  const agentId = readString(source, 'agentId', errors, {
    required: true,
    max: FIELD_LIMITS.agentId,
  });
  const agentName = readString(source, 'agentName', errors, {
    required: true,
    max: FIELD_LIMITS.agentName,
    truncate: true,
  });
  const title = readString(source, 'title', errors, {
    required: true,
    max: FIELD_LIMITS.title,
    truncate: true,
    redact: true,
  });
  const message = readString(source, 'message', errors, {
    required: true,
    max: FIELD_LIMITS.message,
    truncate: true,
    redact: true,
  });
  const taskId = readString(source, 'taskId', errors, {
    required: false,
    max: FIELD_LIMITS.taskId,
  });
  // Optional project identity. This validator is an allow-list that rebuilds
  // the event, so without these two lines the relay would silently STRIP the
  // fields and the phone would never see a project. Same rules as the app's
  // validator: projectName is displayed, so it is redacted like title/message.
  const projectId = readString(source, 'projectId', errors, {
    required: false,
    max: FIELD_LIMITS.projectId,
  });
  const projectName = readString(source, 'projectName', errors, {
    required: false,
    max: FIELD_LIMITS.projectName,
    truncate: true,
    redact: true,
  });
  // Subtask scope: child activity of taskId (a subagent). Presence of
  // subtaskId is the scope marker; it requires a parent taskId so it can never
  // be misread as a task of its own. agentType is displayed, so it is redacted.
  const subtaskId = readString(source, 'subtaskId', errors, {
    required: false,
    max: FIELD_LIMITS.subtaskId,
  });
  const agentType = readString(source, 'agentType', errors, {
    required: false,
    max: FIELD_LIMITS.agentType,
    truncate: true,
    redact: true,
  });
  if (subtaskId && !taskId) errors.push('"subtaskId" requires "taskId"');

  const type = source.type;
  if (typeof type !== 'string' || !AGENT_EVENT_TYPES.includes(type)) {
    errors.push(`"type" must be one of: ${AGENT_EVENT_TYPES.join(', ')}`);
  }

  let provider;
  if (source.provider !== undefined && source.provider !== null) {
    if (typeof source.provider !== 'string' || !AGENT_EVENT_PROVIDERS.includes(source.provider)) {
      errors.push(`"provider" must be one of: ${AGENT_EVENT_PROVIDERS.join(', ')}`);
    } else {
      provider = source.provider;
    }
  }

  const rawTimestamp = source.timestamp;
  let timestamp;
  if (typeof rawTimestamp !== 'string') {
    errors.push('"timestamp" must be an ISO 8601 string');
  } else {
    const parsed = new Date(rawTimestamp);
    if (Number.isNaN(parsed.getTime())) {
      errors.push('"timestamp" is not a valid date');
    } else {
      timestamp = parsed.toISOString();
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  const event = {
    version: PROTOCOL_VERSION,
    eventId,
    agentId,
    agentName,
    type,
    title,
    message,
    timestamp,
  };

  if (taskId) event.taskId = taskId;
  if (provider) event.provider = provider;
  // THE PROJECT BELONGS TO THE MAIN SESSION. A child (subagent) event never
  // carries project identity onward, even if a sender put one there: a
  // subagent may run in another directory and must never establish or move
  // the parent's project. The receiver attaches the child by taskId.
  if (projectId && !subtaskId) event.projectId = projectId;
  if (projectName && !subtaskId) event.projectName = projectName;
  if (subtaskId) event.subtaskId = subtaskId;
  if (agentType) event.agentType = agentType;

  return { ok: true, event };
}
