import { parentPort, workerData } from "node:worker_threads";
import { convertGerberBoards } from "./geometry";
import { convertBundle, inspectBundle } from "./bundle";

void (async () => {
  if (workerData.inspect) return { summary: inspectBundle(workerData.archive) };
  const boards = workerData.archive
    ? await convertBundle(workerData.archive, { thicknessMm: workerData.thickness, engraveDepthMm: workerData.depth, toleranceMm: workerData.tolerance, sides: workerData.sides, includeDrills: workerData.includeDrills })
    : await convertGerberBoards(workerData.text, workerData.thickness, workerData.tolerance, workerData.depth, workerData.splitGap);
  return { bytes: boards[0], additional: boards.slice(1) };
})().then(
  result => parentPort!.postMessage(result),
  error => parentPort!.postMessage({ error: error instanceof Error ? error.message : String(error) })
);
