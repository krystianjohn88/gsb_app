// Prosty serwer HTTP bez zależności: serwuje frontend z ./public
// oraz „bazę danych” z plików JSON w ./data (trails.json + plik punktów każdego szlaku).
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
  res.end(body);
}

const sendJson = (res, status, data) => send(res, status, JSON.stringify(data), MIME['.json']);

// Pliki czytane przy każdym żądaniu – edycja JSON-a działa bez restartu kontenera.
async function readJson(file) {
  return JSON.parse(await fs.readFile(path.join(DATA_DIR, file), 'utf8'));
}

async function readPoints(trailId) {
  const trails = await readJson('trails.json');
  const trail = trailId ? trails.find((t) => t.id === trailId) : trails[0];
  if (!trail) return null;
  return (await readJson(trail.file)).sort((a, b) => a.id - b.id);
}

async function handleApi(res, url) {
  if (url.pathname === '/api/trails') return sendJson(res, 200, await readJson('trails.json'));

  const points = await readPoints(url.searchParams.get('trail'));
  if (!points) return sendJson(res, 404, { error: 'Nieznany szlak' });

  if (url.pathname === '/api/points') {
    const part = url.searchParams.get('part');
    return sendJson(res, 200, part ? points.filter((p) => p.name_mountain_part === part) : points);
  }
  if (url.pathname === '/api/parts') {
    // Pasma w kolejności występowania na szlaku + liczba punktów.
    const parts = [];
    for (const p of points) {
      const known = parts.find((x) => x.name === p.name_mountain_part);
      if (known) known.count++;
      else parts.push({ name: p.name_mountain_part, count: 1 });
    }
    return sendJson(res, 200, parts);
  }
  return sendJson(res, 404, { error: 'Not found' });
}

// GET /data/<plik>.json – te same pliki, które w wersji statycznej leżą obok strony.
async function handleData(res, pathname) {
  const name = path.basename(decodeURIComponent(pathname));
  if (!name.endsWith('.json')) return send(res, 404, 'Not found');
  try {
    send(res, 200, await fs.readFile(path.join(DATA_DIR, name)), MIME['.json']);
  } catch {
    send(res, 404, 'Not found');
  }
}

async function handleStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, 'Forbidden');
  try {
    const body = await fs.readFile(file);
    send(res, 200, body, MIME[path.extname(file)] || 'application/octet-stream');
  } catch {
    send(res, 404, 'Not found');
  }
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    try {
      if (req.method !== 'GET') return send(res, 405, 'Method not allowed');
      if (url.pathname.startsWith('/api/')) return await handleApi(res, url);
      if (url.pathname.startsWith('/data/')) return await handleData(res, url.pathname);
      return await handleStatic(res, url.pathname);
    } catch (err) {
      console.error(err);
      sendJson(res, 500, { error: err.message });
    }
  })
  .listen(PORT, () => console.log(`Szlaki długodystansowe Beskidów: http://localhost:${PORT}`));
