#!/usr/bin/env node
'use strict';
// Whistler Media Center — optional server.
// The page runs on its own in Chrome/Edge (File System Access API). This script exists for
// two cases: watching from another device on the LAN, and browsers without folder access.
// Zero dependencies. All parsing lives in public/parsers.js, shared with the page.
//
//   node server.js                 -> http://127.0.0.1:7401
//   node server.js --port 8080
//   node server.js --host 0.0.0.0  -> reachable from the LAN (your whole disk, mind)
//   node server.js --open          -> also launch the default browser

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const P = require('./public/parsers.js');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA, 'state.json');
const TAGCACHE_FILE = path.join(DATA, 'tags.json');

const argv = process.argv.slice(2);
const argOf = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const PORT = parseInt(argOf('--port') || '7401', 10);
const HOST = argOf('--host') || '127.0.0.1';
const IS_WIN = process.platform === 'win32';

const STATIC_MIME = { html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8', svg: 'image/svg+xml', png: 'image/png', ico: 'image/x-icon', woff2: 'font/woff2', webmanifest: 'application/manifest+json' };
const mimeOf = (name) => { const m = P.mimeOf(name); return m === 'application/octet-stream' ? (STATIC_MIME[P.extOf(name)] || m) : m; };

// ---------------------------------------------------------------- paths
function safePath(p) {
  if (typeof p !== 'string' || !p || p.includes('\0')) return null;
  const r = path.resolve(p);
  if (IS_WIN ? !/^[A-Za-z]:\\/.test(r) : !r.startsWith('/')) return null;
  return r;
}
const SKIP_DIRS = new Set(['$recycle.bin', 'system volume information', 'node_modules', '.git', 'windows', 'program files', 'program files (x86)',
  'programdata', '$windows.~bt', 'recovery', 'appdata', 'perflogs', '.cache', '__pycache__', 'obj', 'bin']);

// ---------------------------------------------------------------- state
let state = { roots: { videos: [], music: [], pictures: [] }, resume: {}, settings: {} };
function exists(p) { try { fs.accessSync(p); return true; } catch { return false; } }
function loadState() {
  try { state = Object.assign(state, JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))); } catch { /* first run */ }
  state.roots = state.roots || { videos: [], music: [], pictures: [] }; state.resume = state.resume || {}; state.settings = state.settings || {};
  if (!state.seeded) {
    const home = os.homedir();
    const cand = (n) => [path.join(home, n), path.join(home, 'OneDrive', n)].filter(exists);
    for (const [k, n] of [['videos', 'Videos'], ['music', 'Music'], ['pictures', 'Pictures']]) state.roots[k] = [...new Set(state.roots[k].concat(cand(n)))];
    state.seeded = true; saveState();
  }
}
let saveTimer = null;
function saveState() { clearTimeout(saveTimer); saveTimer = setTimeout(() => { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }, 150); }

// ---------------------------------------------------------------- readers & caches
const TAG_VERSION = 3;
let tagCache = {}; try { tagCache = JSON.parse(fs.readFileSync(TAGCACHE_FILE, 'utf8')); } catch { /* none */ }
let tagCacheDirty = false;
setInterval(() => { if (!tagCacheDirty) return; tagCacheDirty = false; fs.mkdirSync(DATA, { recursive: true }); fs.writeFile(TAGCACHE_FILE, JSON.stringify(tagCache), () => {}); }, 4000).unref();

async function withReader(file, fn) {
  const fd = await fsp.open(file, 'r'); const st = await fd.stat();
  const reader = new P.Reader(async (pos, len) => { const b = Buffer.alloc(len); const { bytesRead } = await fd.read(b, 0, len, pos); return b.subarray(0, bytesRead); }, st.size);
  try { return await fn(reader, st); } finally { await fd.close(); }
}
const folderCoverCache = new Map();
async function folderCover(dir) {
  if (folderCoverCache.has(dir)) return folderCoverCache.get(dir);
  let found = null;
  try { const names = await fsp.readdir(dir); const lower = new Map(names.map((n) => [n.toLowerCase(), n])); for (const c of P.COVER_NAMES) if (lower.has(c)) { found = path.join(dir, lower.get(c)); break; } } catch { /* */ }
  folderCoverCache.set(dir, found); return found;
}
async function tagsFor(file) {
  let st; try { st = await fsp.stat(file); } catch { return null; }
  const c = tagCache[file];
  if (c && c.v === TAG_VERSION && c.mtime === st.mtimeMs && c.size === st.size) return c.tags;
  try {
    const tags = await withReader(file, (r) => P.readTags(r, path.basename(file), false));
    tagCache[file] = { v: TAG_VERSION, mtime: st.mtimeMs, size: st.size, tags }; tagCacheDirty = true;
    return tags;
  } catch { return {}; }
}
const subCache = new Map();
async function cachedSubs(file, trackNo, mtime) {
  const key = `${file}|${trackNo}|${mtime}`;
  if (subCache.has(key)) return subCache.get(key);
  const dir = path.join(DATA, 'subs'); fs.mkdirSync(dir, { recursive: true });
  const disk = path.join(dir, crypto.createHash('sha1').update(key).digest('hex') + '.vtt');
  let vtt = null;
  try { vtt = await fsp.readFile(disk, 'utf8'); }
  catch { vtt = await withReader(file, (r) => P.mkvExtractSubs(r, trackNo)); if (vtt) fs.writeFile(disk, vtt, () => {}); }
  if (subCache.size > 40) subCache.delete(subCache.keys().next().value);
  subCache.set(key, vtt); return vtt;
}

// ---------------------------------------------------------------- drives & listing
async function listDrives() {
  if (!IS_WIN) { const st = await fsp.statfs('/').catch(() => null); return [{ name: '/', path: '/', total: st ? st.blocks * st.bsize : 0, free: st ? st.bavail * st.bsize : 0 }]; }
  const out = [];
  for (let c = 65; c <= 90; c++) {
    const root = String.fromCharCode(c) + ':\\';
    try { await fsp.access(root); const st = await fsp.statfs(root).catch(() => null); out.push({ name: String.fromCharCode(c) + ':', path: root, total: st ? st.blocks * st.bsize : 0, free: st ? st.bavail * st.bsize : 0 }); } catch { /* */ }
  }
  return out;
}
async function listDir(dir) {
  const ents = await fsp.readdir(dir, { withFileTypes: true }); const out = [];
  for (const d of ents) {
    if (d.name.startsWith('$') || d.name === 'System Volume Information') continue;
    const full = path.join(dir, d.name); let isDir = d.isDirectory();
    if (d.isSymbolicLink()) { try { isDir = (await fsp.stat(full)).isDirectory(); } catch { continue; } }
    if (isDir) { out.push({ name: d.name, path: full, kind: 'dir' }); continue; }
    const kind = P.kindOf(d.name); if (kind === 'file' || kind === 'subs') continue;
    let st; try { st = await fsp.stat(full); } catch { continue; }
    out.push({ name: d.name, path: full, kind, size: st.size, mtime: st.mtimeMs });
  }
  return out;
}
async function scanTree(root, kinds, opts) {
  const files = []; const deadline = Date.now() + (opts.budgetMs || 25000); const maxFiles = opts.max || 40000;
  const queue = [{ dir: root, depth: 0 }];
  while (queue.length) {
    if (Date.now() > deadline || files.length >= maxFiles) break;
    const batch = queue.splice(0, 16);
    await Promise.all(batch.map(async ({ dir, depth }) => {
      let ents; try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const d of ents) {
        const full = path.join(dir, d.name);
        if (d.isDirectory()) { if (depth < (opts.depth || 8) && !SKIP_DIRS.has(d.name.toLowerCase()) && !d.name.startsWith('.') && !d.name.startsWith('$')) queue.push({ dir: full, depth: depth + 1 }); continue; }
        if (!d.isFile()) continue;
        const kind = P.kindOf(d.name); if (!kinds.includes(kind)) continue;
        let st; try { st = await fsp.stat(full); } catch { continue; }
        files.push({ name: d.name, path: full, dir, kind, size: st.size, mtime: st.mtimeMs });
      }
    }));
  }
  files.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' }));
  return { files, truncated: queue.length > 0 };
}
async function findSidecar(video) {
  const dir = path.dirname(video); const base = path.basename(video).replace(/\.[^.]+$/, '').toLowerCase();
  let names; try { names = await fsp.readdir(dir); } catch { return null; }
  const cands = names.filter((n) => n.toLowerCase().startsWith(base) && /\.(srt|vtt)$/i.test(n)); if (!cands.length) return null;
  cands.sort((a, b) => a.length - b.length); return path.join(dir, cands[0]);
}

// ---------------------------------------------------------------- HTTP
function send(res, code, body, headers) {
  const h = Object.assign({ 'Cache-Control': 'no-store' }, headers || {});
  if (body && typeof body === 'object' && !Buffer.isBuffer(body) && !(body instanceof Uint8Array)) { body = JSON.stringify(body); h['Content-Type'] = 'application/json; charset=utf-8'; }
  res.writeHead(code, h); res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > 8 * 1024 * 1024) { reject(new Error('too big')); req.destroy(); } chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
async function streamFile(req, res, file, mime, cache) {
  let st; try { st = await fsp.stat(file); } catch { return send(res, 404, 'not found'); }
  if (!st.isFile()) return send(res, 404, 'not a file');
  const headers = { 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Last-Modified': st.mtime.toUTCString(), 'Cache-Control': cache || 'private, max-age=3600' };
  if (cache === 'no-cache' && req.headers['if-modified-since'] === st.mtime.toUTCString()) { res.writeHead(304); return res.end(); }
  let start = 0, end = st.size - 1, code = 200;
  const m = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
  if (m) {
    if (m[1]) start = parseInt(m[1], 10); if (m[2]) end = parseInt(m[2], 10);
    if (!m[1] && m[2]) { start = Math.max(0, st.size - parseInt(m[2], 10)); end = st.size - 1; }
    end = Math.min(end, st.size - 1);
    if (start > end || start >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
    code = 206; headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
  }
  headers['Content-Length'] = end - start + 1;
  res.writeHead(code, headers);
  if (req.method === 'HEAD') return res.end();
  const s = fs.createReadStream(file, { start, end }); s.on('error', () => res.destroy()); res.on('close', () => s.destroy()); s.pipe(res);
}

async function handleApi(req, res, u) {
  const q = u.searchParams; const route = u.pathname.slice(5);
  const p = () => { const s = safePath(q.get('path')); if (!s) throw Object.assign(new Error('bad path'), { code: 400 }); return s; };
  switch (route) {
    case 'drives': return send(res, 200, await listDrives());
    case 'home': {
      const home = os.homedir();
      return send(res, 200, { home, user: os.userInfo().username, host: os.hostname(), platform: process.platform,
        special: ['Desktop', 'Downloads', 'Documents', 'Videos', 'Music', 'Pictures'].map((n) => ({ name: n, path: path.join(home, n) })).filter((x) => exists(x.path)),
        onedrive: exists(path.join(home, 'OneDrive')) ? path.join(home, 'OneDrive') : null });
    }
    case 'ls': { const dir = p(); const entries = await listDir(dir); const parent = path.dirname(dir); return send(res, 200, { path: dir, name: path.basename(dir) || dir, parent: parent === dir ? null : parent, entries }); }
    case 'scan': { const dir = p(); return send(res, 200, await scanTree(dir, (q.get('kinds') || 'video').split(','), { depth: parseInt(q.get('depth') || '8', 10), max: parseInt(q.get('max') || '40000', 10) })); }
    case 'tags': {
      if (req.method !== 'POST') return send(res, 405, 'POST');
      const body = await readBody(req); const paths = ((body && body.paths) || []).map(safePath).filter(Boolean).slice(0, 4000);
      const out = {}; let i = 0;
      await Promise.all(Array.from({ length: 8 }, async () => {
        while (i < paths.length) { const f = paths[i++]; const t = await tagsFor(f); if (!t) continue; const fc = t.cover ? null : await folderCover(path.dirname(f)); out[f] = Object.assign({}, t, fc ? { folderCover: fc } : {}); }
      }));
      return send(res, 200, out);
    }
    case 'cover': {
      const f = p();
      try { const t = await withReader(f, (r) => P.readTags(r, path.basename(f), true)); if (t.coverData) return send(res, 200, Buffer.from(t.coverData.buffer, t.coverData.byteOffset, t.coverData.length), { 'Content-Type': t.cover, 'Cache-Control': 'private, max-age=86400' }); } catch { /* */ }
      const fc = await folderCover(path.dirname(f)); if (fc) return streamFile(req, res, fc, mimeOf(fc));
      return send(res, 404, 'no cover');
    }
    case 'subs': {
      const f = p(); const track = q.get('track'); let vtt;
      if (track != null) { const st = await fsp.stat(f); vtt = await cachedSubs(f, parseInt(track, 10), st.mtimeMs); }
      else { const sc = await findSidecar(f); if (sc) { let txt = await fsp.readFile(sc); txt = txt[0] === 0xff && txt[1] === 0xfe ? txt.subarray(2).toString('utf16le') : txt.toString('utf8'); vtt = P.srtToVtt(txt); } }
      if (!vtt) return send(res, 404, 'no subs');
      return send(res, 200, vtt, { 'Content-Type': 'text/vtt; charset=utf-8' });
    }
    case 'tracks': {
      const f = p(); const out = { subs: [], audio: [], chapters: [], sidecar: !!(await findSidecar(f)) };
      if (/\.(mkv|webm)$/i.test(f)) {
        try {
          const info = await withReader(f, (r) => P.mkvInfo(r));
          if (info) {
            out.subs = info.tracks.filter((t) => t.type === 17 && /S_TEXT\/(UTF8|ASS|SSA)/i.test(t.codec)).map((t) => ({ n: t.n, lang: t.lang, langIETF: t.langIETF, name: t.name, default: t.default, forced: t.forced, kind: /ASS|SSA/i.test(t.codec) ? 'ass' : 'srt' }));
            out.audio = info.tracks.filter((t) => t.type === 2).map((t) => ({ n: t.n, lang: t.lang, name: t.name, default: t.default, codec: t.codec.replace(/^A_/, '') }));
            out.chapters = info.chapters;
          }
        } catch { /* */ }
      }
      return send(res, 200, out);
    }
    case 'state': {
      if (req.method === 'GET') return send(res, 200, state);
      const body = await readBody(req);
      if (body && typeof body === 'object') { if (body.roots) state.roots = body.roots; if (body.settings) Object.assign(state.settings, body.settings); if (body.resume) Object.assign(state.resume, body.resume); if (body.clearResume) delete state.resume[body.clearResume]; saveState(); }
      return send(res, 200, state);
    }
    case 'kiyora': {
      const f = path.join(process.env.APPDATA || '', 'Kiyora', 'settings.json');
      try { const k = JSON.parse(await fsp.readFile(f, 'utf8')); return send(res, 200, { videos: k.Roots || [], music: k.MusicRoots || [], pictures: k.PictureRoots || [] }); }
      catch { return send(res, 404, { error: 'no kiyora' }); }
    }
    default: return send(res, 404, { error: 'unknown route' });
  }
}
async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname); if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC, rel)); if (!file.startsWith(PUBLIC)) return send(res, 403, 'no');
  try { const st = await fsp.stat(file); if (!st.isFile()) throw new Error(); } catch { return send(res, 404, 'not found'); }
  return streamFile(req, res, file, STATIC_MIME[P.extOf(file)] || 'application/octet-stream', 'no-cache');
}
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  try {
    if (u.pathname.startsWith('/api/')) return await handleApi(req, res, u);
    if (u.pathname === '/media') { const f = safePath(u.searchParams.get('path')); if (!f) return send(res, 400, 'bad path'); return await streamFile(req, res, f, u.searchParams.get('mime') || mimeOf(f)); }
    return await serveStatic(req, res, u.pathname);
  } catch (e) {
    const code = e.code === 400 ? 400 : e.code === 'ENOENT' ? 404 : e.code === 'EACCES' || e.code === 'EPERM' ? 403 : 500;
    send(res, code, { error: String(e.message || e) });
  }
});
loadState();
server.listen(PORT, HOST, () => {
  const url = `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`;
  console.log(`\n  Whistler Media Center (server mode)\n  ${url}\n`);
  if (HOST !== '127.0.0.1' && HOST !== 'localhost') console.log('  ! bound to ' + HOST + ' - every drive on this PC is readable from the network.\n');
  if (argv.includes('--open')) require('child_process').exec(IS_WIN ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`);
});
