import {
  loadStrategyModelFromEnvironment,
  modelSearchOptions,
} from "./model/strategy-model.js";
import { PersistentSearchPool, SearchCoordinator } from "./search/search-pool.js";
import { createBattlesnakeServer } from "./server.js";

async function main(): Promise<void> {
  const model = await loadStrategyModelFromEnvironment();
  process.env.MODEL_VERSION = model.modelVersion;
  const searchCoordinator = new SearchCoordinator(
    new PersistentSearchPool(),
    model.evaluationWeights,
    modelSearchOptions(model),
  );
  try {
    await searchCoordinator.ready();
  } catch (error) {
    await searchCoordinator.close();
    throw error;
  }
  const server = createBattlesnakeServer(searchCoordinator);
  const host = "0.0.0.0";
  const port = Number.parseInt(process.env.PORT ?? "8000", 10);

  server.listen(port, host, () => {
    console.log(
      JSON.stringify({
        event: "server_started",
        address: `http://${host}:${port}`,
        modelVersion: model.modelVersion,
      }),
    );
  });

  const shutdown = (signal: string): void => {
    console.log(`Received ${signal}; shutting down`);
    server.close((error) => {
      if (error) {
        console.error(error);
        process.exitCode = 1;
      }
    });
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
