import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { performance } from "node:perf_hooks";
import type { GameState, InfoResponse } from "./api/types.js";
import {
  createPersistenceCoordinatorFromEnvironment,
  PersistenceCoordinator,
} from "./persistence/coordinator.js";
import { SearchCoordinator } from "./search/search-pool.js";

const MAX_BODY_BYTES = 1_000_000;

function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  const serialized = JSON.stringify(body);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(serialized),
  });
  response.end(serialized);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;

    if (totalBytes > MAX_BODY_BYTES) {
      throw new Error("Request body is too large");
    }

    chunks.push(buffer);
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

export function snakeInfo(): InfoResponse {
  return {
    apiversion: "1",
    author: process.env.SNAKE_AUTHOR ?? "",
    color: process.env.SNAKE_COLOR ?? "#16A34A",
    head: process.env.SNAKE_HEAD ?? "default",
    tail: process.env.SNAKE_TAIL ?? "default",
    version: process.env.SNAKE_VERSION ?? "0.1.0",
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  searchCoordinator: SearchCoordinator,
  persistenceCoordinator: PersistenceCoordinator,
): Promise<void> {
  const method = request.method ?? "GET";
  const path = new URL(request.url ?? "/", "http://localhost").pathname;

  if (method === "GET" && path === "/") {
    sendJson(response, 200, snakeInfo());
    return;
  }

  if (method !== "POST" || !["/start", "/move", "/end"].includes(path)) {
    sendJson(response, 404, { error: "Not found" });
    return;
  }

  try {
    const state = (await readJson(request)) as GameState;

    if (path === "/move") {
      const startedAt = performance.now();
      const { response: result, diagnostics } =
        await searchCoordinator.chooseMove(state);
      const elapsedMs = performance.now() - startedAt;
      console.log(
        JSON.stringify({
          event: "move",
          gameId: state.game.id,
          turn: state.turn,
          move: result.move,
          elapsedMs: Number(elapsedMs.toFixed(3)),
          iterations: diagnostics.iterations,
          priorVisits: diagnostics.priorVisits,
          reusedTree: diagnostics.reusedTree,
          cacheHits: diagnostics.cacheHits,
          cacheMisses: diagnostics.cacheMisses,
          workersCompleted: diagnostics.workersCompleted,
          workersRequested: diagnostics.workersRequested,
          fallbackProtected: diagnostics.fallbackProtected,
          deadlineReached: diagnostics.deadlineReached,
          rootSafety: diagnostics.rootSafety,
          rootStatistics: diagnostics.rootStatistics,
        }),
      );
      sendJson(response, 200, result);
      persistenceCoordinator.recordMove({
        state,
        diagnostics,
        requestElapsedMs: elapsedMs,
      });
      return;
    }

    if (path === "/start") {
      searchCoordinator.startGame(state.game.id);
      persistenceCoordinator.recordStart(state);
    } else {
      searchCoordinator.endGame(state.game.id);
      persistenceCoordinator.recordEnd(state);
    }
    console.log(
      JSON.stringify({
        event: path === "/start" ? "game_start" : "game_end",
        gameId: state.game.id,
        turn: state.turn,
      }),
    );
    sendJson(response, 200, { ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request";
    sendJson(response, 400, { error: message });
  }
}

export function createBattlesnakeServer(
  searchCoordinator = new SearchCoordinator(),
  persistenceCoordinator = createPersistenceCoordinatorFromEnvironment(),
): Server {
  const server = createHttpServer((request, response) => {
    void handleRequest(
      request,
      response,
      searchCoordinator,
      persistenceCoordinator,
    );
  });
  server.once("close", () => {
    void Promise.all([
      searchCoordinator.close(),
      persistenceCoordinator.close(),
    ]);
  });
  return server;
}
