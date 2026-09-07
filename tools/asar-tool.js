#!/usr/bin/env node
/*
 * Minimal dependency-free asar tool.
 *   node asar-tool.js extract <app.asar> <outDir>
 *   node asar-tool.js pack    <original.asar> <stagingDir> <out.asar>
 *   node asar-tool.js list    <app.asar>
 *
 * pack() reuses the ORIGINAL archive's header as a template: every file keeps its packed/unpacked
 * status, packed files are re-read from <stagingDir> (so patched files are picked up), and
 * integrity blocks are dropped (this app's fuses do not validate them). Unpacked files continue to
 * live in <out.asar>.unpacked next to the archive, untouched.
 */
"use strict";
const fs = require("fs");
const path = require("path");

function readHeader(asarPath) {
  const fd = fs.openSync(asarPath, "r");
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  // Pickle layout: [u32 4][u32 headerPickleSize][u32 headerPayloadSize][u32 jsonLength][json...]
  const headerPickleSize = head.readUInt32LE(4);
  const jsonLength = head.readUInt32LE(12);
  const jsonBuffer = Buffer.alloc(jsonLength);
  fs.readSync(fd, jsonBuffer, 0, jsonLength, 16);
  return { fd, header: JSON.parse(jsonBuffer.toString("utf8")), dataBase: 8 + headerPickleSize };
}

/* Unpacked files live in <archive>.unpacked. For a renamed backup (app.asar.orig) fall back to the
 * sibling app.asar.unpacked directory, which the backup shares with the live archive. */
function unpackedRootFor(asarPath) {
  const candidates = [`${asarPath}.unpacked`, path.join(path.dirname(asarPath), "app.asar.unpacked")];
  return candidates.find((dir) => fs.existsSync(dir)) ?? candidates[0];
}

function walk(node, relPath, visit) {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const rel = relPath ? `${relPath}/${name}` : name;
    if (entry.files) {
      visit(rel, entry, true);
      walk(entry, rel, visit);
    } else {
      visit(rel, entry, false);
    }
  }
}

function copyRange(fdIn, position, size, fdOut) {
  const chunk = Buffer.alloc(Math.min(size, 8 * 1024 * 1024));
  let remaining = size;
  while (remaining > 0) {
    const n = fs.readSync(fdIn, chunk, 0, Math.min(remaining, chunk.length), position);
    if (n <= 0) throw new Error("short read");
    fs.writeSync(fdOut, chunk, 0, n);
    remaining -= n;
    position += n;
  }
}

function extract(asarPath, outDir) {
  const { fd, header, dataBase } = readHeader(asarPath);
  const unpackedRoot = unpackedRootFor(asarPath);
  let files = 0;
  let unpacked = 0;
  let bytes = 0;
  fs.mkdirSync(outDir, { recursive: true });
  walk(header, "", (rel, entry, isDir) => {
    const target = path.join(outDir, rel);
    if (isDir) {
      fs.mkdirSync(target, { recursive: true });
      return;
    }
    if (entry.link) return;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (entry.unpacked) {
      const source = path.join(unpackedRoot, rel);
      if (!fs.existsSync(source)) {
        console.warn(`warning: unpacked file missing: ${source}`);
        return;
      }
      fs.copyFileSync(source, target);
      unpacked += 1;
      bytes += entry.size;
      return;
    }
    const out = fs.openSync(target, "w");
    copyRange(fd, dataBase + Number(entry.offset), entry.size, out);
    fs.closeSync(out);
    files += 1;
    bytes += entry.size;
  });
  fs.closeSync(fd);
  console.log(`extracted ${files} packed + ${unpacked} unpacked files (${(bytes / 1024 / 1024).toFixed(1)} MB) to ${outDir}`);
}

function pack(originalAsar, stagingDir, outAsar) {
  const { fd, header } = readHeader(originalAsar);
  fs.closeSync(fd);
  const plan = [];
  let offset = 0;
  walk(header, "", (rel, entry, isDir) => {
    if (isDir || entry.link) return;
    delete entry.integrity;
    const source = path.join(stagingDir, rel);
    if (entry.unpacked) {
      // Unpacked files are not written into the archive; they stay in app.asar.unpacked untouched.
      if (fs.existsSync(source)) entry.size = fs.statSync(source).size;
      return;
    }
    if (!fs.existsSync(source)) throw new Error(`staging file missing: ${source}`);
    const size = fs.statSync(source).size;
    entry.size = size;
    entry.offset = String(offset);
    plan.push({ source, size });
    offset += size;
  });
  const json = Buffer.from(JSON.stringify(header), "utf8");
  const padded = Math.ceil(json.length / 4) * 4;
  const headerPickle = Buffer.alloc(8 + padded);
  headerPickle.writeUInt32LE(4 + padded, 0); // pickle payload size
  headerPickle.writeUInt32LE(json.length, 4); // string length
  json.copy(headerPickle, 8);
  const sizePickle = Buffer.alloc(8);
  sizePickle.writeUInt32LE(4, 0);
  sizePickle.writeUInt32LE(headerPickle.length, 4);

  const tmp = `${outAsar}.tmp`;
  const out = fs.openSync(tmp, "w");
  fs.writeSync(out, sizePickle);
  fs.writeSync(out, headerPickle);
  for (const item of plan) {
    const src = fs.openSync(item.source, "r");
    copyRange(src, 0, item.size, out);
    fs.closeSync(src);
  }
  fs.closeSync(out);
  fs.renameSync(tmp, outAsar);
  console.log(`packed ${plan.length} files (${(offset / 1024 / 1024).toFixed(1)} MB payload) -> ${outAsar}`);
}

function cat(asarPath, relPath) {
  const { fd, header, dataBase } = readHeader(asarPath);
  const wanted = relPath.replace(/\\/g, "/");
  let found = null;
  walk(header, "", (rel, entry, isDir) => {
    if (!isDir && rel === wanted) found = entry;
  });
  if (!found) {
    fs.closeSync(fd);
    throw new Error(`not in archive: ${relPath}`);
  }
  if (found.unpacked) {
    fs.closeSync(fd);
    process.stdout.write(fs.readFileSync(path.join(unpackedRootFor(asarPath), wanted)));
    return;
  }
  const buffer = Buffer.alloc(found.size);
  fs.readSync(fd, buffer, 0, found.size, dataBase + Number(found.offset));
  fs.closeSync(fd);
  process.stdout.write(buffer);
}

function list(asarPath) {
  const { fd, header } = readHeader(asarPath);
  fs.closeSync(fd);
  let packed = 0;
  let unpacked = 0;
  walk(header, "", (rel, entry, isDir) => {
    if (isDir || entry.link) return;
    if (entry.unpacked) unpacked += 1;
    else packed += 1;
    console.log(`${entry.unpacked ? "U" : "P"} ${String(entry.size).padStart(10)} ${rel}`);
  });
  console.error(`${packed} packed, ${unpacked} unpacked`);
}

const [, , command, ...args] = process.argv;
try {
  if (command === "extract" && args.length === 2) extract(args[0], args[1]);
  else if (command === "pack" && args.length === 3) pack(args[0], args[1], args[2]);
  else if (command === "list" && args.length === 1) list(args[0]);
  else if (command === "cat" && args.length === 2) cat(args[0], args[1]);
  else {
    console.error("usage: asar-tool.js extract <asar> <outDir> | pack <original.asar> <stagingDir> <out.asar> | list <asar> | cat <asar> <path>");
    process.exit(2);
  }
} catch (error) {
  console.error(`asar-tool failed: ${error.message}`);
  process.exit(1);
}
