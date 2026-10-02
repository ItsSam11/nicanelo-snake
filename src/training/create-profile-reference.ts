import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { evaluateEligibility } from "./corpus-manifest.js";
import {
  buildProfileReference,
  serializeProfileReference,
  type ProfileReference,
} from "./profile-reference.js";
import { parseReplaySummary } from "./replay-corpus.js";

async function filesRecursively(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const child = join(path, entry.name);
    return entry.isDirectory() ? filesRecursively(child) : [child];
  }));
  return nested.flat();
}

export async function createProfileReference(
  telemetryRoot: string,
  referenceVersion: string,
  createdAt?: string,
): Promise<{ path: string; reference: ProfileReference }> {
  const summaries = (await filesRecursively(join(telemetryRoot, "raw")))
    .filter((path) => path.endsWith("/summary.json"))
    .sort();
  const profiles = [];
  for (const path of summaries) {
    const summary = parseReplaySummary(await readFile(path, "utf8"));
    if (evaluateEligibility(summary).eligible) {
      profiles.push(...summary.profiles);
    }
  }
  const reference = buildProfileReference(
    profiles,
    referenceVersion,
    createdAt,
  );
  const directory = join(telemetryRoot, "references");
  const path = join(directory, `${referenceVersion}.json`);
  await mkdir(directory, { recursive: true });
  await writeFile(path, serializeProfileReference(reference), { flag: "wx" });
  return { path, reference };
}

async function main(): Promise<void> {
  const [telemetryRoot, referenceVersion] = process.argv.slice(2);
  if (telemetryRoot === undefined || referenceVersion === undefined) {
    throw new Error(
      "Usage: create-profile-reference <telemetry-root> <reference-version>",
    );
  }
  const result = await createProfileReference(telemetryRoot, referenceVersion);
  console.log(JSON.stringify({
    path: result.path,
    referenceVersion: result.reference.referenceVersion,
    sampleCount: result.reference.sampleCount,
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
