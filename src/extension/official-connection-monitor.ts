import { basename } from 'node:path';

import type { Disposable } from 'vscode';

import {
  parseOfficialConnectionEvents,
  selectOfficialConnectionObservation,
  type OfficialConnectionObservation,
} from '../core/logs/official-connection.js';
import { readOfficialConnectionLogDocuments } from '../core/logs/official-connection-files.js';
import type { OfficialConnectionLogCache } from '../core/logs/official-connection-files.js';

export interface OfficialConnectionMonitorProject {
  root: string;
}

export interface OfficialConnectionMonitorOptions {
  /** The current extension host's context.logUri.fsPath. */
  logPath: string;
  listProjects(): readonly OfficialConnectionMonitorProject[];
  onObservation(root: string, observation: OfficialConnectionObservation): void;
  enabled?: boolean;
  pollMilliseconds?: number;
  now?(): Date;
}

const DEFAULT_POLL_MILLISECONDS = 2_000;

function sameObservation(left: OfficialConnectionObservation | undefined, right: OfficialConnectionObservation): boolean {
  return left?.state === right.state
    && left?.observedAt === right.observedAt
    && left?.projectName === right.projectName
    && left?.source === right.source;
}

/**
 * Bridges the official extension's current-window output log to the private
 * status model. It is deliberately read-only, bounded, and disposable.
 */
export class OfficialConnectionLogMonitor implements Disposable {
  readonly #options: OfficialConnectionMonitorOptions;
  readonly #observations = new Map<string, OfficialConnectionObservation>();
  #timer: ReturnType<typeof setInterval> | null = null;
  #enabled = false;
  #refreshing = false;
  #logCache: OfficialConnectionLogCache = { signature: null, documents: [] };

  constructor(options: OfficialConnectionMonitorOptions) {
    this.#options = options;
    this.setEnabled(options.enabled ?? true);
  }

  setEnabled(enabled: boolean): void {
    if (this.#enabled === enabled) return;
    this.#enabled = enabled;
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    if (!enabled) {
      this.#logCache = { signature: null, documents: [] };
      for (const root of this.#observations.keys()) {
        this.#publish(root, {
          state: 'unknown',
          observedAt: null,
          projectName: null,
          source: 'official-output-log',
        });
      }
      return;
    }
    void this.refresh();
    this.#timer = setInterval(() => { void this.refresh(); }, this.#options.pollMilliseconds ?? DEFAULT_POLL_MILLISECONDS);
  }

  async refresh(): Promise<void> {
    if (!this.#enabled || this.#refreshing) return;
    this.#refreshing = true;
    try {
      const projects = [...this.#options.listProjects()];
      if (projects.length === 0) return;
      const roots = new Set(projects.map((project) => project.root));
      for (const root of this.#observations.keys()) {
        if (!roots.has(root)) this.#observations.delete(root);
      }
      const documents = await readOfficialConnectionLogDocuments(this.#options.logPath, this.#logCache);
      const events = parseOfficialConnectionEvents(documents);
      // An unscoped official event is safe only when this window has one
      // managed project. Multi-root workspaces must have a project hint.
      const scopedEvents = projects.length === 1
        ? events
        : events.filter((event) => event.projectName !== null);
      const now = this.#options.now?.() ?? new Date();
      for (const project of projects) {
        const projectName = basename(project.root) || null;
        const selected = selectOfficialConnectionObservation(scopedEvents, { projectName, now });
        this.#publish(project.root, selected);
      }
    } catch {
      // A rotating/locked VS Code log is expected occasionally. Keep the last
      // observation instead of turning a transient read failure into offline.
    } finally {
      this.#refreshing = false;
    }
  }

  dispose(): void {
    this.setEnabled(false);
    this.#observations.clear();
    this.#logCache = { signature: null, documents: [] };
  }

  #publish(root: string, observation: OfficialConnectionObservation): void {
    // Refresh the short-lived cross-process handoff even when the parsed event
    // is unchanged. The CLI/MCP process must not keep an old window's state.
    if (sameObservation(this.#observations.get(root), observation)) {
      this.#options.onObservation(root, observation);
      return;
    }
    this.#observations.set(root, observation);
    this.#options.onObservation(root, observation);
  }
}
