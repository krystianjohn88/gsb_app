// Prosty serwer HTTP bez zależności: serwuje frontend z ./public
// oraz „bazę danych” z pliku JSON (./data/points.json).
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'points.json');

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

// Plik czytany przy każdym żądaniu – edycja JSON-a działa bez restartu kontenera.
async function readPoints() {
  const raw = await fs.readFile(DATA_FILE, 'utf8');
  const points = JSON.parse(raw);
  if (!Array.isArray(points)) throw new Error('points.json musi zawierać tablicę');
  return points.sort((a, b) => a.id - b.id);
}

async function handleApi(req, res, url) {
  if (url.pathname === '/api/points') {
    let points = await readPoints();
    const part = url.searchParams.get('part');
    if (part) points = points.filter((p) => p.name_mountain_part === part);
    return send(res, 200, JSON.stringify(points), MIME['.json']);
  }
  if (url.pathname === '/api/parts') {
    // Pasma w kolejności występowania na szlaku + liczba punktów.
    const parts = [];
    for (const p of await readPoints()) {
      const last = parts[parts.length - 1];
      if (last && last.name === p.name_mountain_part) last.count++;
      else parts.push({ name: p.name_mountain_part, count: 1 });
    }
    return send(res, 200, JSON.stringify(parts), MIME['.json']);
  }
  return send(res, 404, JSON.stringify({ error: 'Not found' }), MIME['.json']);
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
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      return await handleStatic(res, url.pathname);
    } catch (err) {
      console.error(err);
      send(res, 500, JSON.stringify({ error: err.message }), MIME['.json']);
    }
  })
  .listen(PORT, () => console.log(`GSB app: http://localhost:${PORT}`));
