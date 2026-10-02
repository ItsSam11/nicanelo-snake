import { DefaultAzureCredential } from "@azure/identity";
import {
  createCluster,
  type RedisClusterType,
} from "@redis/client";
import {
  EntraIdCredentialsProviderFactory,
  REDIS_SCOPE_DEFAULT,
} from "@redis/entraid";
import { isIP } from "node:net";
import type { PersistenceLogger } from "./async-queue.js";
import type { HotGameSummary, HotStateStore } from "./types.js";

function gameKeyComponent(gameId: string): string {
  return gameId.replace(/[{}]/gu, "_");
}

function parseEndpoint(endpoint: string): { host: string; port: number } {
  const separator = endpoint.lastIndexOf(":");
  if (separator <= 0 || separator === endpoint.length - 1) {
    throw new Error("REDIS_ENDPOINT must use host:port");
  }
  const host = endpoint.slice(0, separator);
  const port = Number.parseInt(endpoint.slice(separator + 1), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("REDIS_ENDPOINT contains an invalid port");
  }
  return { host, port };
}

export interface AzureRedisHotStateStoreOptions {
  endpoint: string;
  keyPrefix?: string;
  ttlSeconds?: number;
  connectTimeoutMs?: number;
  logger?: PersistenceLogger;
}

/** Shared summaries only; complete MCTS trees always remain process-local. */
export class AzureRedisHotStateStore implements HotStateStore {
  private readonly endpoint: string;
  private readonly host: string;
  private readonly keyPrefix: string;
  private readonly ttlSeconds: number;
  private readonly connectTimeoutMs: number;
  private readonly logger: PersistenceLogger;
  private client: RedisClusterType | undefined;
  private connecting: Promise<RedisClusterType> | undefined;

  constructor(options: Readonly<AzureRedisHotStateStoreOptions>) {
    const { host, port } = parseEndpoint(options.endpoint);
    this.endpoint = `${host}:${port}`;
    this.host = host;
    this.keyPrefix = (options.keyPrefix ?? "battlesnake")
      .replace(/:+$/gu, "");
    this.ttlSeconds = options.ttlSeconds ?? 1_800;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 1_500;
    this.logger = options.logger ?? (() => undefined);
    if (!Number.isInteger(this.ttlSeconds) || this.ttlSeconds < 1) {
      throw new Error("REDIS_TTL_SECONDS must be a positive integer");
    }
    if (!Number.isInteger(this.connectTimeoutMs) || this.connectTimeoutMs < 1) {
      throw new Error("REDIS_CONNECT_TIMEOUT_MS must be a positive integer");
    }
  }

  async write(summary: Readonly<HotGameSummary>): Promise<void> {
    const client = await this.connectedClient();
    const { latest, opponents } = this.keys(summary.gameId);
    const transaction = client.multi(latest);
    transaction.set(latest, JSON.stringify(summary), { EX: this.ttlSeconds });
    for (const observation of summary.observedOpponentMoves) {
      transaction.hIncrBy(
        opponents,
        `${observation.snakeId}:${observation.move}`,
        1,
      );
    }
    transaction.expire(opponents, this.ttlSeconds);
    await transaction.exec();
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.connecting = undefined;
    if (client?.isOpen === true) {
      client.destroy();
    }
  }

  private keys(gameId: string): { latest: string; opponents: string } {
    const taggedGame = `{${gameKeyComponent(gameId)}}`;
    return {
      latest: `${this.keyPrefix}:game:${taggedGame}:latest`,
      opponents: `${this.keyPrefix}:game:${taggedGame}:opponents`,
    };
  }

  private async connectedClient(): Promise<RedisClusterType> {
    if (this.client?.isReady === true) {
      return this.client;
    }
    if (this.connecting === undefined) {
      const credential = new DefaultAzureCredential();
      const credentialsProvider =
        EntraIdCredentialsProviderFactory.createForDefaultAzureCredential({
          credential,
          scopes: REDIS_SCOPE_DEFAULT,
          options: {},
          tokenManagerConfig: { expirationRefreshRatio: 0.8 },
        });
      const client = createCluster({
        rootNodes: [{ url: `rediss://${this.endpoint}` }],
        defaults: {
          credentialsProvider,
          socket: {
            connectTimeout: this.connectTimeoutMs,
            tls: true,
            reconnectStrategy: () => new Error("Redis unavailable"),
          },
        },
        nodeAddressMap: (incomingAddress) => {
          const separator = incomingAddress.lastIndexOf(":");
          const incomingHost = incomingAddress.slice(0, separator);
          const incomingPort = Number.parseInt(
            incomingAddress.slice(separator + 1),
            10,
          );
          return {
            host: isIP(incomingHost) !== 0 ? this.host : incomingHost,
            port: incomingPort,
          };
        },
      });
      client.on("error", (error: Error) => {
        this.logger({
          event: "redis_client_error",
          error: error.message,
        });
      });
      this.client = client;
      this.connecting = client.connect()
        .then(() => client)
        .catch((error: unknown) => {
          this.connecting = undefined;
          this.client = undefined;
          client.destroy();
          throw error;
        });
    }
    return this.connecting;
  }
}
