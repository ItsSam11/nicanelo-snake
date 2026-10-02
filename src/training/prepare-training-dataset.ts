import { pathToFileURL } from "node:url";
import { prepareTrainingDataset } from "./prepared-training.js";

interface CliOptions {
  corpusManifest: string;
  outputDirectory: string;
  workers?: number;
  maximumGames?: number;
}

function positiveInteger(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

export function parsePrepareTrainingDatasetOptions(
  argv: readonly string[],
): CliOptions {
  const values: Partial<CliOptions> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`Missing value for ${flag ?? "argument"}`);
    switch (flag) {
      case "--corpus-manifest":
        values.corpusManifest = value;
        break;
      case "--output":
        values.outputDirectory = value;
        break;
      case "--workers":
        values.workers = positiveInteger(value, flag);
        break;
      case "--max-games":
        values.maximumGames = positiveInteger(value, flag);
        break;
      default:
        throw new Error(`Unknown argument ${flag}`);
    }
    index += 1;
  }
  if (values.corpusManifest === undefined) {
    throw new Error("--corpus-manifest is required");
  }
  if (values.outputDirectory === undefined) {
    throw new Error("--output is required");
  }
  return values as CliOptions;
}

async function main(): Promise<void> {
  const startedAt = performance.now();
  const options = parsePrepareTrainingDatasetOptions(process.argv.slice(2));
  const result = await prepareTrainingDataset(options);
  console.log(JSON.stringify({
    event: "training_dataset_prepared",
    manifestPath: result.manifestPath,
    corpusGames: result.dataset.corpusGames,
    trainingGames: result.dataset.totals.training.games,
    validationGames: result.dataset.totals.validation.games,
    trainingSamples:
      result.dataset.totals.training.policyPrior +
      result.dataset.totals.training.opponentPolicy +
      result.dataset.totals.training.value,
    validationSamples:
      result.dataset.totals.validation.policyPrior +
      result.dataset.totals.validation.opponentPolicy +
      result.dataset.totals.validation.value,
    shards: result.dataset.shards.length,
    elapsedMs: Number((performance.now() - startedAt).toFixed(3)),
    rssBytes: process.memoryUsage().rss,
  }));
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(invokedPath).href
) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
