import { performance } from "node:perf_hooks";
import { parentPort } from "node:worker_threads";
import { MctsMemory, searchMove } from "./mcts.js";
import {
  remainingSearchBudgetMs,
  type SearchWorkerRequest,
  type SearchWorkerResponse,
} from "./search-worker-protocol.js";

if (parentPort === null) {
  throw new Error("The search worker must run inside a worker thread");
}

const port = parentPort;
const memory = new MctsMemory();

port.on("message", (message: SearchWorkerRequest) => {
  if (message.type === "clear-game") {
    memory.clearGame(message.gameId);
    return;
  }
  if (message.type === "clear-all") {
    memory.clear();
    return;
  }

  try {
    const cancellationFlag = new Int32Array(message.cancellationBuffer);
    if (Atomics.load(cancellationFlag, 0) !== 0) {
      return;
    }
    const maximumBudgetMs = message.options.timeBudgetMs ?? 0;
    const timeBudgetMs = remainingSearchBudgetMs(
      message.deadlineEpochMs,
      maximumBudgetMs,
    );
    const now = (): number =>
      Atomics.load(cancellationFlag, 0) === 0
        ? performance.now()
        : Number.MAX_VALUE;
    const result = searchMove(
      message.state,
      message.fallbackMove,
      message.weights,
      { ...message.options, timeBudgetMs, now },
      memory,
    );
    const response: SearchWorkerResponse = {
      type: "result",
      requestId: message.requestId,
      result,
    };
    port.postMessage(response);
  } catch (error) {
    const response: SearchWorkerResponse = {
      type: "error",
      requestId: message.requestId,
      error: error instanceof Error ? error.message : "Unknown worker error",
    };
    port.postMessage(response);
  }
});

port.postMessage({ type: "ready" } satisfies SearchWorkerResponse);
