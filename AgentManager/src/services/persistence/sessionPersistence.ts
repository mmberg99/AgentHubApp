import type { PersistedSnapshot, PersistenceAdapter } from './types';

/**
 * Session-only persistence: holds the snapshot in module memory.
 *
 * LIMITATION, stated plainly: this does NOT survive an app reload, a Metro
 * refresh, or the app being killed. Agent history is session-only today. The
 * bridge's queue is also memory-only, so events already consumed cannot be
 * replayed after a reload.
 *
 * It is deliberately not backed by `localStorage`: that would work in the web
 * preview and silently do nothing on a real iPhone, which is worse than an
 * honest no-op.
 */
class SessionPersistence implements PersistenceAdapter {
  readonly id = 'session';
  readonly durable = false;

  private snapshot: PersistedSnapshot | null = null;

  async load(): Promise<PersistedSnapshot | null> {
    return this.snapshot;
  }

  async save(snapshot: PersistedSnapshot): Promise<void> {
    this.snapshot = snapshot;
  }

  async clear(): Promise<void> {
    this.snapshot = null;
  }
}

export const sessionPersistence: PersistenceAdapter = new SessionPersistence();
