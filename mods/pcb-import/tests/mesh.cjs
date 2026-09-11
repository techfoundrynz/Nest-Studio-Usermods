const assert = require('node:assert/strict');
function mesh(bytes) {
  const b = Buffer.from(bytes), count = b.readUInt32LE(80);
  assert.equal(b.length, 84 + count * 50);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  const edges = new Map();
  let volume = 0;
  for (let i = 0; i < count; i++) {
    const v = Array.from({ length: 3 }, (_, j) => Array.from({ length: 3 }, (_, k) => b.readFloatLE(84 + i * 50 + 12 + j * 12 + k * 4)));
    for (const p of v) p.forEach((n, k) => { assert.ok(Number.isFinite(n)); min[k] = Math.min(min[k], n); max[k] = Math.max(max[k], n); });
    for (let j = 0; j < 3; j++) {
      const a = v[j].join(','), c = v[(j + 1) % 3].join(',');
      assert.notEqual(a, c, 'nondegenerate edge');
      const key = [a, c].sort().join('|');
      const e = edges.get(key) || { count: 0, balance: 0 };
      e.count++; e.balance += a < c ? 1 : -1; edges.set(key, e);
    }
    const [a, c, d] = v;
    volume += (a[0] * (c[1] * d[2] - c[2] * d[1]) + a[1] * (c[2] * d[0] - c[0] * d[2]) + a[2] * (c[0] * d[1] - c[1] * d[0])) / 6;
  }
  for (const e of edges.values()) { assert.equal(e.count, 2, 'closed manifold'); assert.equal(e.balance, 0, 'consistent winding'); }
  assert.ok(volume > 0);
  return { min, max, volume, count };
}
module.exports = mesh;
