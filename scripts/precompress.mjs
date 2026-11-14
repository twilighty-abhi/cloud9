// Writes .br and .gz next to each compressible file in the web build so @fastify/static (preCompressed: true)
// can serve them without compressing per request. Usage: node scripts/precompress.mjs [dir=dist/web]
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { brotliCompressSync, gzipSync, constants } from 'node:zlib';

const dir = process.argv[2] ?? 'dist/web';
const EXT = new Set(['.html', '.js', '.mjs', '.css', '.svg', '.json', '.txt', '.csv', '.map', '.webmanifest', '.xml', '.ico']);
const MIN_BYTES = 1024;
let files = 0, before = 0, afterBr = 0;

function walk(d) {
  for (const name of readdirSync(d)) {
    const p = join(d, name);
    if (statSync(p).isDirectory()) { walk(p); continue; }
    if (!EXT.has(extname(name)) || statSync(p).size < MIN_BYTES) continue;
    const buf = readFileSync(p);
    const br = brotliCompressSync(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: buf.length } });
    const gz = gzipSync(buf, { level: 9 });
    if (br.length < buf.length) writeFileSync(p + '.br', br);
    if (gz.length < buf.length) writeFileSync(p + '.gz', gz);
    files++; before += buf.length; afterBr += Math.min(br.length, buf.length);
  }
}
walk(dir);
console.log(`[precompress] ${files} file(s) in ${dir}: ${(before / 1024).toFixed(1)} KB → ${(afterBr / 1024).toFixed(1)} KB brotli`);
