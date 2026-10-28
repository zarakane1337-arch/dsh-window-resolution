import { mkdir, writeFile } from 'node:fs/promises';

const dir = 'C:/Users/zarak/Desktop/dsh-plugin/_probe/gh';
await mkdir(dir, { recursive: true });
const rel = await (await fetch('https://api.github.com/repos/cli/cli/releases/tags/v2.103.3', {
  headers: { 'user-agent': 'dsh-plugin-resolution' },
  signal: AbortSignal.timeout(20000),
})).json();
const asset = rel.assets.find((a) => a.name === 'gh_2.103.3_windows_amd64.zip');
console.log('asset', asset.id, asset.size, 'begins');
const started = Date.now();
const res = await fetch(asset.url, {
  headers: { 'user-agent': 'dsh-plugin-resolution', accept: 'application/octet-stream' },
  signal: AbortSignal.timeout(900000),
});
console.log('status', res.status, 'after', Date.now() - started, 'ms');
if (!res.ok) throw new Error(`HTTP ${res.status}`);
const buf = Buffer.from(await res.arrayBuffer());
await writeFile(`${dir}/gh.zip`, buf);
console.log(`done ${buf.length} bytes in ${Date.now() - started}ms`);
