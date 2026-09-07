#!/usr/bin/env node
/*
 *   nest-asar extract <app.asar> <outDir>
 *   nest-asar pack    <original.asar> <stagingDir> <out.asar>
 *   nest-asar list    <app.asar>
 *   nest-asar cat     <app.asar> <path/inside/archive>
 */
import { extract, list, pack, readEntry } from "./index";

const [, , command, ...args] = process.argv;
const mb = (n: number): string => (n / 1024 / 1024).toFixed(1);
try {
  if (command === "extract" && args.length === 2) {
    const r = extract(args[0]!, args[1]!);
    for (const missing of r.missingUnpacked) console.warn(`warning: unpacked file missing: ${missing}`);
    console.log(`extracted ${r.packed} packed + ${r.unpacked} unpacked files (${mb(r.bytes)} MB) to ${args[1]}`);
  } else if (command === "pack" && args.length === 3) {
    const r = pack(args[0]!, args[1]!, args[2]!);
    console.log(`packed ${r.files} files (${mb(r.payloadBytes)} MB payload) -> ${args[2]}`);
  } else if (command === "list" && args.length === 1) {
    const entries = list(args[0]!);
    for (const e of entries) console.log(`${e.unpacked ? "U" : "P"} ${String(e.size).padStart(10)} ${e.path}`);
    console.error(`${entries.filter((e) => !e.unpacked).length} packed, ${entries.filter((e) => e.unpacked).length} unpacked`);
  } else if (command === "cat" && args.length === 2) {
    process.stdout.write(readEntry(args[0]!, args[1]!));
  } else {
    console.error("usage: nest-asar extract <asar> <outDir> | pack <original.asar> <stagingDir> <out.asar> | list <asar> | cat <asar> <path>");
    process.exit(2);
  }
} catch (error) {
  console.error(`nest-asar failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
