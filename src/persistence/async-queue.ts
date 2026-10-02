export type PersistenceLogger = (entry: Readonly<Record<string, unknown>>) => void;

interface QueuedJob {
  label: string;
  run: () => Promise<void>;
}

export interface BestEffortQueueOptions {
  capacity?: number;
  concurrency?: number;
  logger?: PersistenceLogger;
}

export interface BestEffortQueueStatistics {
  accepted: number;
  completed: number;
  failed: number;
  dropped: number;
  pending: number;
}

/** Bounded background queue. Callers never await work on the request path. */
export class BestEffortQueue {
  private readonly capacity: number;
  private readonly concurrency: number;
  private readonly logger: PersistenceLogger;
  private readonly jobs: QueuedJob[] = [];
  private readonly drainWaiters: Array<() => void> = [];
  private active = 0;
  private accepting = true;
  private accepted = 0;
  private completed = 0;
  private failed = 0;
  private dropped = 0;

  constructor(options: Readonly<BestEffortQueueOptions> = {}) {
    this.capacity = options.capacity ?? 512;
    this.concurrency = options.concurrency ?? 1;
    this.logger = options.logger ?? (() => undefined);
    if (!Number.isInteger(this.capacity) || this.capacity < 1) {
      throw new Error("Persistence queue capacity must be a positive integer");
    }
    if (!Number.isInteger(this.concurrency) || this.concurrency < 1) {
      throw new Error("Persistence queue concurrency must be a positive integer");
    }
  }

  get statistics(): BestEffortQueueStatistics {
    return {
      accepted: this.accepted,
      completed: this.completed,
      failed: this.failed,
      dropped: this.dropped,
      pending: this.jobs.length + this.active,
    };
  }

  enqueue(label: string, run: () => Promise<void>): boolean {
    if (!this.accepting || this.jobs.length + this.active >= this.capacity) {
      this.dropped += 1;
      this.logger({
        event: "persistence_drop",
        label,
        pending: this.jobs.length + this.active,
      });
      return false;
    }

    this.accepted += 1;
    this.jobs.push({ label, run });
    queueMicrotask(() => this.pump());
    return true;
  }

  async close(): Promise<void> {
    this.accepting = false;
    if (this.jobs.length === 0 && this.active === 0) {
      return;
    }
    await new Promise<void>((resolve) => this.drainWaiters.push(resolve));
  }

  private pump(): void {
    while (this.active < this.concurrency) {
      const job = this.jobs.shift();
      if (job === undefined) {
        break;
      }
      this.active += 1;
      void Promise.resolve()
        .then(job.run)
        .then(() => {
          this.completed += 1;
        })
        .catch((error: unknown) => {
          this.failed += 1;
          this.logger({
            event: "persistence_error",
            label: job.label,
            error: error instanceof Error ? error.message : "Unknown error",
          });
        })
        .finally(() => {
          this.active -= 1;
          this.pump();
          this.resolveDrainIfIdle();
        });
    }
    this.resolveDrainIfIdle();
  }

  private resolveDrainIfIdle(): void {
    if (this.jobs.length !== 0 || this.active !== 0) {
      return;
    }
    for (const resolve of this.drainWaiters.splice(0)) {
      resolve();
    }
  }
}
