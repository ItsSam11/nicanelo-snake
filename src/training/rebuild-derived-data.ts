import {
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildReplayCorpus,
  GAME_SUMMARY_SCHEMA_VERSION,
  parseOfficialReplayJsonl,
  validateChampionshipReplay,
  type GameArtifactSource,
  type ReplayBuildOptions,
} from "./replay-corpus.js";

async function filesRecursively(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const child = join(path, entry.name);
    return entry.isDirectory() ? filesRecursively(child) : [child];
  }));
  return nested.flat();
}

function legacyOptions(path: string, text: string): ReplayBuildOptions {
  const value = JSON.parse(text) as Record<string, unknown>;
  const inferredSource: GameArtifactSource = path.includes("/live/")
    ? "live"
    : "gym";
  const source = value.source === "live" || value.source === "gym"
    ? value.source
    : inferredSource;
  return {
    source,
    ...(typeof value.runId === "string" ? { runId: value.runId } : {}),
    ...(typeof value.seed === "number" && Number.isSafeInteger(value.seed)
      ? { seed: value.seed }
      : {}),
    ...(Array.isArray(value.modelVersions) &&
        value.modelVersions.every((item) => typeof item === "string")
      ? { modelVersions: value.modelVersions as string[] }
      : {}),
  };
}

async function atomicReplace(path: string, text: string): Promise<void> {
  const temporary = `${path}.v${GAME_SUMMARY_SCHEMA_VERSION}.tmp`;
  await writeFile(temporary, text, { flag: "wx" });
  try {
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function rebuildDerivedData(
  rawRoot: string,
): Promise<{ upgraded: number; current: number }> {
  const records = (await filesRecursively(rawRoot))
    .filter((path) => path.endsWith("/record.jsonl"))
    .sort();
  let upgraded = 0;
  let current = 0;
  for (const recordPath of records) {
    const directory = dirname(recordPath);
    const summaryPath = join(directory, "summary.json");
    const observationsPath = join(directory, "observations.jsonl");
    const [recordText, previousSummaryText] = await Promise.all([
      readFile(recordPath, "utf8"),
      readFile(summaryPath, "utf8"),
    ]);
    const previousSummary = JSON.parse(previousSummaryText) as
      Record<string, unknown>;
    if (previousSummary.schemaVersion === GAME_SUMMARY_SCHEMA_VERSION) {
      current += 1;
      continue;
    }
    const replay = parseOfficialReplayJsonl(recordText);
    validateChampionshipReplay(replay);
    const corpus = buildReplayCorpus(
      replay,
      legacyOptions(recordPath, previousSummaryText),
    );
    await atomicReplace(
      summaryPath,
      `${JSON.stringify(corpus.summary, null, 2)}\n`,
    );
    await atomicReplace(
      observationsPath,
      corpus.observations.map((item) => JSON.stringify(item)).join("\n") + "\n",
    );
    upgraded += 1;
  }
  return { upgraded, current };
}

async function main(): Promise<void> {
  const [rawRoot] = process.argv.slice(2);
  if (rawRoot === undefined) {
    throw new Error("Usage: rebuild-derived-data <telemetry-raw-root>");
  }
  console.log(JSON.stringify(await rebuildDerivedData(rawRoot)));
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
