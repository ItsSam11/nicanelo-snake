import { appendFile, mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import type { PersistenceRecord, TelemetrySink } from "./types.js";

/**
 * Process-local telemetry for controlled simulations.
 *
 * Each snake process must receive a unique file. Exclusive creation prevents a
 * retry or a second process from silently mixing two runs.
 */
export class JsonlFileTelemetrySink implements TelemetrySink {
  private readonly path: string;
  private initializePromise: Promise<void> | undefined;

  constructor(path: string) {
    if (path.trim().length === 0) {
      throw new Error("FILE_TELEMETRY_PATH must be non-empty");
    }
    this.path = path;
  }

  async write(record: Readonly<PersistenceRecord>): Promise<void> {
    await this.initialize();
    await appendFile(this.path, `${JSON.stringify(record)}\n`, "utf8");
  }

  async close(): Promise<void> {
    await this.initializePromise;
  }

  private async initialize(): Promise<void> {
    if (this.initializePromise === undefined) {
      this.initializePromise = (async () => {
        await mkdir(dirname(this.path), { recursive: true });
        const handle = await open(this.path, "wx");
        await handle.close();
      })().catch((error: unknown) => {
        this.initializePromise = undefined;
        throw error;
      });
    }
    await this.initializePromise;
  }
}
