import {
  AGENT_EVENT_PROVIDERS,
  AGENT_EVENT_TYPES,
  FIELD_LIMITS,
  PROTOCOL_VERSION,
  type AgentEventProvider,
  type AgentEventType,
  type AgentNotificationEvent,
} from './agentEvent';

export type ParseResult =
  | { ok: true; event: AgentNotificationEvent }
  | { ok: false; errors: string[] };

/**
 * Last-line redaction for text that may appear on a lock screen.
 *
 * Keeping secrets out of payloads is the SENDER's responsibility — this cannot
 * catch everything and is not a substitute for a well-behaved notifier. It
 * removes the few shapes that leak most often from agent tooling: absolute
 * file paths and obvious key-like tokens.
 */
const REDACTIONS: readonly RegExp[] = [
  // Windows absolute paths, e.g. C:\Users\me\project\secret.ts
  /[A-Za-z]:\\[^\s"']+/g,
  // POSIX home paths, e.g. /Users/me/... or /home/me/...
  /\/(?:Users|home)\/[^\s"']+/g,
  // Provider-style API keys, e.g. sk-..., pk-...
  /\b(?:sk|pk)-[A-Za-z0-9_-]{8,}\b/g,
  // Bearer tokens written inline.
  /\bBearer\s+[A-Za-z0-9._-]{8,}\b/gi,
  // Long opaque blobs that are almost certainly a token or hash.
  /\b[A-Za-z0-9_-]{40,}\b/g,
];

export function redactSensitive(value: string): string {
  return REDACTIONS.reduce((acc, pattern) => acc.replace(pattern, '[redacted]'), value);
}

/** Collapses whitespace and strips control characters that would break layout. */
function clean(value: string): string {
  return value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function readString(
  source: Record<string, unknown>,
  key: string,
  errors: string[],
  options: { required: boolean; max: number; truncate?: boolean; redact?: boolean },
): string | undefined {
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

/**
 * Validates untrusted input and rebuilds it field by field.
 *
 * This is an allow-list, not a filter: the returned object is constructed from
 * scratch, so any unknown field in the incoming payload is silently discarded
 * and can never reach application state.
 */
export function parseAgentNotificationEvent(input: unknown): ParseResult {
  const errors: string[] = [];

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: ['payload must be a JSON object'] };
  }

  const source = input as Record<string, unknown>;

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
  // `title` and `message` are the only fields rendered verbatim, so they are
  // the only ones that need redacting.
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
  // Project identity is optional and rebuilt like every other field, so an
  // older sender that omits it validates exactly as before. `projectName` is
  // displayed, so it gets the same redaction as title/message: if a sender
  // ever put a full path here by mistake, it would arrive as "[redacted]"
  // rather than leaking a directory structure onto the phone.
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
  // Subtask scope (a subagent). Requires the parent taskId so a child can
  // never be misread as a task of its own. agentType is displayed → redacted.
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
  if (typeof type !== 'string' || !AGENT_EVENT_TYPES.includes(type as AgentEventType)) {
    errors.push(`"type" must be one of: ${AGENT_EVENT_TYPES.join(', ')}`);
  }

  let provider: AgentEventProvider | undefined;
  if (source.provider !== undefined && source.provider !== null) {
    if (
      typeof source.provider !== 'string' ||
      !AGENT_EVENT_PROVIDERS.includes(source.provider as AgentEventProvider)
    ) {
      errors.push(`"provider" must be one of: ${AGENT_EVENT_PROVIDERS.join(', ')}`);
    } else {
      provider = source.provider as AgentEventProvider;
    }
  }

  const rawTimestamp = source.timestamp;
  let timestamp: string | undefined;
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

  // Every field below is proven present by the checks above.
  const event: AgentNotificationEvent = {
    version: PROTOCOL_VERSION,
    eventId: eventId as string,
    agentId: agentId as string,
    agentName: agentName as string,
    type: type as AgentEventType,
    title: title as string,
    message: message as string,
    timestamp: timestamp as string,
  };

  // Optional fields are only attached when valid, keeping the object minimal.
  if (taskId) event.taskId = taskId;
  if (provider) event.provider = provider;
  if (projectId) event.projectId = projectId;
  if (projectName) event.projectName = projectName;
  if (subtaskId) event.subtaskId = subtaskId;
  if (agentType) event.agentType = agentType;

  return { ok: true, event };
}
