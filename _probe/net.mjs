const targets = [
  'https://api.github.com',
  'https://github.com',
  'https://objects.githubusercontent.com',
  'https://registry.npmjs.org',
  'https://ghproxy.net',
  'https://mirror.ghproxy.com',
];
for (const t of targets) {
  const started = Date.now();
  try {
    const r = await fetch(t, { signal: AbortSignal.timeout(8000) });
    console.log(`${t} -> ${r.status} (${Date.now() - started}ms)`);
  } catch (e) {
    console.log(`${t} -> ERR ${e.cause?.code || e.message} (${Date.now() - started}ms)`);
  }
}
