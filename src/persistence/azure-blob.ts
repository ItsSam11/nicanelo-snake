import { DefaultAzureCredential } from "@azure/identity";
import { BlobServiceClient, type ContainerClient } from "@azure/storage-blob";
import type { PersistenceRecord, TelemetrySink } from "./types.js";

function safePathComponent(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]/gu, "_");
  return sanitized.length > 0 ? sanitized : "unknown";
}

function blobName(record: Readonly<PersistenceRecord>, prefix: string): string {
  const day = record.recordedAt.slice(0, 10);
  const gameId = safePathComponent(record.gameId);
  const order = String(record.turn).padStart(6, "0");
  return [
    prefix,
    day,
    gameId,
    `${order}-${record.event}-${record.eventId}.json`,
  ].filter((part) => part.length > 0).join("/");
}

export interface AzureBlobTelemetrySinkOptions {
  accountUrl: string;
  containerName: string;
  prefix?: string;
}

/** One immutable blob per event avoids cross-replica append races. */
export class AzureBlobTelemetrySink implements TelemetrySink {
  private readonly container: ContainerClient;
  private readonly prefix: string;
  private initializePromise: Promise<void> | undefined;

  constructor(options: Readonly<AzureBlobTelemetrySinkOptions>) {
    const accountUrl = options.accountUrl.replace(/\/$/u, "");
    if (!accountUrl.startsWith("https://")) {
      throw new Error("AZURE_STORAGE_ACCOUNT_URL must use HTTPS");
    }
    if (!/^[a-z0-9-]{3,63}$/u.test(options.containerName)) {
      throw new Error("AZURE_STORAGE_CONTAINER is invalid");
    }
    const service = new BlobServiceClient(
      accountUrl,
      new DefaultAzureCredential(),
    );
    this.container = service.getContainerClient(options.containerName);
    this.prefix = (options.prefix ?? "telemetry/raw/live").replace(
      /^\/+|\/+$/gu,
      "",
    );
  }

  async write(record: Readonly<PersistenceRecord>): Promise<void> {
    await this.initialize();
    const body = `${JSON.stringify(record)}\n`;
    const client = this.container.getBlockBlobClient(
      blobName(record, this.prefix),
    );
    await client.upload(body, Buffer.byteLength(body), {
      blobHTTPHeaders: { blobContentType: "application/x-ndjson" },
      conditions: { ifNoneMatch: "*" },
    });
  }

  async close(): Promise<void> {
    // Azure SDK clients do not own sockets that require explicit shutdown.
  }

  private async initialize(): Promise<void> {
    if (this.initializePromise === undefined) {
      this.initializePromise = this.container.createIfNotExists()
        .then(() => undefined)
        .catch((error: unknown) => {
          this.initializePromise = undefined;
          throw error;
        });
    }
    await this.initializePromise;
  }
}
