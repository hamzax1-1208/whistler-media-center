/* source.js — where the media comes from.
   LocalSource: the File System Access API. You pick folders once, the browser keeps the handles,
                and every parser runs in the page. Nothing installed, nothing running.
   ServerSource: the optional Node script (server.js) for LAN use or non-Chromium browsers.
   Both expose the same surface, so the screens never know which one they're talking to.       */
(function () {
  'use strict';
  const P = window.Parsers;
  const DB_NAME = 'whistler';
  const enc = encodeURIComponent;

  // ------------------------------------------------------------------ tiny IndexedDB wrapper
  let dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise((res) => {
      const r = indexedDB.open(DB_NAME, 2);
      r.onupgradeneeded = () => { const d = r.result; for (const s of ['thumbs', 'handles', 'tags', 'subs']) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s); };
      r.onsuccess = () => res(r.result); r.onerror = () => res(null);
    });
    return dbp;
  }
  const idb = {
    async get(store, k) { const d = await db(); if (!d) return null; return new Promise((res) => { const q = d.transaction(store).objectStore(store).get(k); q.onsuccess = () => res(q.result ?? null); q.onerror = () => res(null); }); },
    async put(store, k, v) { const d = await db(); if (!d) return; return new Promise((res) => { try { const tx = d.transaction(store, 'readwrite'); tx.objectStore(store).put(v, k); tx.oncomplete = () => res(); tx.onerror = () => res(); } catch { res(); } }); },
    async del(store, k) { const d = await db(); if (!d) return; return new Promise((res) => { try { const tx = d.transaction(store, 'readwrite'); tx.objectStore(store).delete(k); tx.oncomplete = () => res(); tx.onerror = () => res(); } catch { res(); } }); },
    async all(store) { const d = await db(); if (!d) return []; return new Promise((res) => { const out = []; const q = d.transaction(store).objectStore(store).openCursor(); q.onsuccess = () => { const c = q.result; if (c) { out.push({ key: c.key, value: c.value }); c.continue(); } else res(out); }; q.onerror = () => res(out); }); },
  };

  const DEFAULT_STATE = () => ({ roots: { videos: [], music: [], pictures: [] }, resume: {}, settings: {} });
  const SKIP = /^(\.|\$|node_modules$|System Volume Information$|Windows$|Program Files|AppData$|\$RECYCLE)/i;

  // ================================================================== LocalSource
  function LocalSource() {
    const src = { mode: 'local', local: true, state: DEFAULT_STATE(), needsReconnect: false };
    const handles = new Map();      // rootId -> { id, name, handle }
    const dirCache = new Map();     // virtual path -> FileSystemDirectoryHandle
    const recCache = new Map();     // virtual path -> file record
    const coverByDir = new Map();   // dir path -> image record named cover.*
    const urlCache = new Map();

    const split = (p) => p.split('/').filter(Boolean);
    const join = (...a) => a.filter(Boolean).join('/');
    const parentOf = (p) => { const s = split(p); return s.length > 1 ? s.slice(0, -1).join('/') : null; };

    src.loadState = async () => {
      try { src.state = Object.assign(DEFAULT_STATE(), JSON.parse(localStorage.getItem('whistler.state') || '{}')); } catch { src.state = DEFAULT_STATE(); }
      const rows = await idb.all('handles');
      for (const r of rows) handles.set(r.key, r.value);
      // drop roots whose handle is gone
      for (const k of Object.keys(src.state.roots)) src.state.roots[k] = src.state.roots[k].filter((p) => handles.has(split(p)[0]));
      src.needsReconnect = false;
      for (const h of handles.values()) {
        if (!h.handle) { src.needsReconnect = true; continue; }               // transient stub (Firefox/Safari)
        try { if ((await h.handle.queryPermission({ mode: 'read' })) !== 'granted') src.needsReconnect = true; } catch { src.needsReconnect = true; }
      }
      return src.state;
    };
    src.saveState = async (patch) => {
      const S = src.state;
      if (patch.roots) S.roots = patch.roots;
      if (patch.settings) Object.assign(S.settings, patch.settings);
      if (patch.resume) Object.assign(S.resume, patch.resume);
      if (patch.clearResume) delete S.resume[patch.clearResume];
      try { localStorage.setItem('whistler.state', JSON.stringify(S)); } catch { /* quota */ }
      return S;
    };
    src.reconnect = async () => {
      let ok = true;
      for (const h of handles.values()) {
        if (!h.handle) { ok = false; continue; }   // stubs are re-picked one by one via reconnectMissing
        try { if ((await h.handle.queryPermission({ mode: 'read' })) !== 'granted') { if ((await h.handle.requestPermission({ mode: 'read' })) !== 'granted') ok = false; } }
        catch { ok = false; }
      }
      src.needsReconnect = !ok; dirCache.clear();
      return ok;
    };
    // Two ways in. Chromium: showDirectoryPicker, handles persist. Everyone else (Firefox, Safari):
    // a folder <input> or a dropped folder, giving us a flat FileList we turn into a fake handle tree.
    // Those can't persist, so the folder has to be picked again next session.
    src.persistent = typeof window.showDirectoryPicker === 'function';
    src.supported = () => src.persistent || 'webkitdirectory' in document.createElement('input');
    function syntheticTree(rootName, list) {
      // list: [{ rel: 'sub/dir/file.mkv', file }] relative to the root
      const mk = (name, path) => ({ kind: 'directory', name, __synthetic: true, __path: path, dirs: new Map(), files: new Map(),
        async *entries() { for (const [n, d] of this.dirs) yield [n, d]; for (const [n, f] of this.files) yield [n, f]; },
        async getDirectoryHandle(n) { const d = this.dirs.get(n); if (!d) throw new Error('No such folder'); return d; },
        async queryPermission() { return 'granted'; }, async requestPermission() { return 'granted'; },
        async isSameEntry(o) { return !!o && o.__synthetic && o.name === this.name; } });
      const root = mk(rootName, rootName);
      for (const { rel, file } of list) {
        const segs = rel.split('/').filter(Boolean); if (!segs.length) continue;
        let d = root;
        for (const s of segs.slice(0, -1)) { if (!d.dirs.has(s)) d.dirs.set(s, mk(s, d.__path + '/' + s)); d = d.dirs.get(s); }
        const name = segs[segs.length - 1];
        d.files.set(name, { kind: 'file', name, async getFile() { return file; } });
      }
      return root;
    }
    function fromFileList(files) {
      // <input webkitdirectory> gives webkitRelativePath = "Root/sub/file"
      const arr = [...files]; if (!arr.length) return null;
      const first = (arr[0].webkitRelativePath || arr[0].name).split('/');
      const rootName = first.length > 1 ? first[0] : 'Dropped files';
      const list = arr.map((f) => { const p = (f.webkitRelativePath || f.name).split('/'); return { rel: (p.length > 1 ? p.slice(1) : p).join('/'), file: f }; });
      return syntheticTree(rootName, list);
    }
    function pickViaInput() {
      return new Promise((resolve) => {
        const inp = document.createElement('input'); inp.type = 'file'; inp.webkitdirectory = true; inp.multiple = true; inp.style.display = 'none';
        document.body.appendChild(inp);
        let done = false; const finish = (v) => { if (done) return; done = true; inp.remove(); resolve(v); };
        inp.onchange = () => finish(fromFileList(inp.files));
        inp.oncancel = () => finish(null);
        addEventListener('focus', () => setTimeout(() => finish(null), 1500), { once: true });
        inp.click();
      });
    }
    async function register(handle, keepId) {
      for (const h of handles.values()) { try { if (h.handle && await h.handle.isSameEntry(handle)) return { path: h.id, name: h.name }; } catch { /* */ } }
      const id = keepId || 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const rec = { id, name: handle.name, handle };
      handles.set(id, rec); dirCache.clear();
      // real handles serialise; synthetic trees don't, so store a stub to remember the folder existed
      await idb.put('handles', id, handle.__synthetic ? { id, name: handle.name, transient: true } : rec);
      return { path: id, name: handle.name };
    }
    src.pickFolder = async () => {
      if (!src.supported()) throw new Error('This browser has no folder access at all. Use Chrome, Edge, Firefox or Safari, or run the optional server.js.');
      let handle = null;
      if (src.persistent) { try { handle = await window.showDirectoryPicker({ mode: 'read' }); } catch { return null; } }
      else handle = await pickViaInput();
      if (!handle) return null;
      return register(handle);
    };
    // Dropped folders (any browser): traverse the entry tree into a synthetic handle.
    src.fromDrop = async (dataTransfer) => {
      const items = [...(dataTransfer.items || [])];
      const entries = items.map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null)).filter(Boolean);
      const results = [];
      const readAll = (dir) => new Promise((res) => { const reader = dir.createReader(); const out = []; const step = () => reader.readEntries((batch) => { if (!batch.length) return res(out); out.push(...batch); step(); }, () => res(out)); step(); });
      const fileOf = (entry) => new Promise((res) => entry.file(res, () => res(null)));
      const walk = async (dir, prefix, list) => { for (const e of await readAll(dir)) { if (e.isDirectory) await walk(e, prefix + e.name + '/', list); else { const f = await fileOf(e); if (f) list.push({ rel: prefix + e.name, file: f }); } } };
      const loose = [];
      for (const e of entries) {
        if (e.isDirectory) { const list = []; await walk(e, '', list); results.push(await register(syntheticTree(e.name, list))); }
        else { const f = await fileOf(e); if (f) loose.push({ rel: f.name, file: f }); }
      }
      if (!entries.length && dataTransfer.files && dataTransfer.files.length) { const t = fromFileList(dataTransfer.files); if (t) results.push(await register(t)); }
      else if (loose.length) results.push(await register(syntheticTree('Dropped files', loose)));
      return results;
    };
    src.missingFolders = () => [...handles.values()].filter((h) => !h.handle).map((h) => h.name);
    src.reconnectMissing = async (which) => {
      // Firefox / Safari: the browser forgot the folder; ask for it again, keep the same id so roots and resume points survive.
      const h = [...handles.values()].find((x) => !x.handle && x.name === which); if (!h) return false;
      const tree = await pickViaInput(); if (!tree) return false;
      if (tree.name !== h.name) { /* different folder picked; accept it under the old id anyway */ }
      h.handle = tree; h.name = tree.name; dirCache.clear();
      src.needsReconnect = src.missingFolders().length > 0;
      return true;
    };
    src.forgetFolder = async (id) => {
      handles.delete(id); await idb.del('handles', id);
      for (const k of Object.keys(src.state.roots)) src.state.roots[k] = src.state.roots[k].filter((p) => split(p)[0] !== id);
      await src.saveState({});
    };
    src.rootLabel = (p) => { const s = split(p); const h = handles.get(s[0]); if (!h) return p; return s.length > 1 ? `${h.name} › ${s.slice(1).join(' › ')}` : h.name; };
    src.displayPath = src.rootLabel;

    async function dirHandleFor(p) {
      if (dirCache.has(p)) return dirCache.get(p);
      const s = split(p); const root = handles.get(s[0]); if (!root) throw new Error('Folder is no longer available');
      let h = root.handle;
      for (const seg of s.slice(1)) h = await h.getDirectoryHandle(seg);
      dirCache.set(p, h); return h;
    }
    function remember(rec) { recCache.set(rec.path, rec); if (rec.kind === 'image' && P.COVER_NAMES.includes(rec.name.toLowerCase())) coverByDir.set(rec.dir, rec); return rec; }
    async function fileRec(dirPath, name, h) {
      const f = await h.getFile();
      return remember({ name, path: join(dirPath, name), dir: dirPath, kind: P.kindOf(name), size: f.size, mtime: f.lastModified, file: f });
    }

    src.ls = async (p) => {
      const h = await dirHandleFor(p);
      const entries = [];
      for await (const [name, ent] of h.entries()) {
        if (/^(\$|\.)/.test(name)) continue;
        if (ent.kind === 'directory') { entries.push({ name, path: join(p, name), kind: 'dir' }); dirCache.set(join(p, name), ent); continue; }
        const kind = P.kindOf(name); if (kind === 'file') continue;
        try { const r = await fileRec(p, name, ent); if (kind !== 'subs') entries.push(r); } catch { /* unreadable */ }
      }
      const s = split(p);
      return { path: p, name: s.length > 1 ? s[s.length - 1] : (handles.get(s[0]) || {}).name || p, parent: parentOf(p), entries };
    };
    src.scan = async (rootPath, kinds, opts = {}) => {
      const files = []; const queue = [{ p: rootPath, depth: 0 }]; const deadline = Date.now() + (opts.budgetMs || 60000);
      const want = new Set(kinds.concat(['subs']));
      while (queue.length && files.length < 40000 && Date.now() < deadline) {
        const { p, depth } = queue.shift();
        let h; try { h = await dirHandleFor(p); } catch { continue; }
        try {
          for await (const [name, ent] of h.entries()) {
            if (ent.kind === 'directory') { if (depth < 8 && !SKIP.test(name)) { dirCache.set(join(p, name), ent); queue.push({ p: join(p, name), depth: depth + 1 }); } continue; }
            const kind = P.kindOf(name);
            if (!want.has(kind) && !(kind === 'image' && P.COVER_NAMES.includes(name.toLowerCase()))) continue;
            try { const r = await fileRec(p, name, ent); r.root = rootPath; if (kinds.includes(kind)) files.push(r); } catch { /* skip */ }
          }
        } catch { /* permission or gone */ }
      }
      files.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' }));
      return files;
    };
    src.rec = (path) => recCache.get(path) || null;
    src.url = (x) => {
      const rec = typeof x === 'string' ? recCache.get(x) : x; if (!rec || !rec.file) return '';
      if (!urlCache.has(rec.path)) urlCache.set(rec.path, URL.createObjectURL(rec.file));
      return urlCache.get(rec.path);
    };
    const readerFor = (file) => new P.Reader(async (pos, len) => new Uint8Array(await file.slice(pos, pos + len).arrayBuffer()), file.size);
    src.tags = async (files, onProgress) => {
      const need = files.filter((f) => !f.tags); let done = 0, i = 0;
      await Promise.all(Array.from({ length: 4 }, async () => {
        while (i < need.length) {
          const f = need[i++]; const key = `${f.path}|${f.size}|${f.mtime}`;
          let t = await idb.get('tags', key);
          if (!t) { try { t = await P.readTags(readerFor(f.file), f.name, false); } catch { t = {}; } await idb.put('tags', key, t); }
          f.tags = Object.assign({}, t);
          if (!f.tags.cover && coverByDir.has(f.dir)) f.tags.folderCover = coverByDir.get(f.dir).path;
          done++; if (onProgress && (done % 25 === 0 || done === need.length)) onProgress(done, need.length);
        }
      }));
      return files;
    };
    const coverUrls = new Map();
    src.cover = async (rec) => {
      if (!rec || !rec.tags) return null;
      if (rec.tags.cover) {
        if (coverUrls.has(rec.path)) return coverUrls.get(rec.path);
        try { const t = await P.readTags(readerFor(rec.file), rec.name, true); if (t.coverData) { const u = URL.createObjectURL(new Blob([t.coverData], { type: t.cover })); coverUrls.set(rec.path, u); return u; } } catch { /* */ }
      }
      if (rec.tags.folderCover) return src.url(rec.tags.folderCover);
      return null;
    };
    const sidecarOf = (rec) => { const base = rec.name.replace(/\.[^.]+$/, '').toLowerCase(); const cands = [...recCache.values()].filter((r) => r.kind === 'subs' && r.dir === rec.dir && /\.(srt|vtt)$/i.test(r.name) && r.name.toLowerCase().startsWith(base)); cands.sort((a, b) => a.name.length - b.name.length); return cands[0] || null; };
    src.tracks = async (rec) => {
      const out = { subs: [], audio: [], chapters: [], sidecar: !!sidecarOf(rec) };
      if (/\.(mkv|webm)$/i.test(rec.name)) {
        try {
          const info = await P.mkvInfo(readerFor(rec.file));
          if (info) {
            out.subs = info.tracks.filter((t) => t.type === 17 && /S_TEXT\/(UTF8|ASS|SSA)/i.test(t.codec)).map((t) => ({ n: t.n, lang: t.lang, langIETF: t.langIETF, name: t.name, default: t.default, forced: t.forced, kind: /ASS|SSA/i.test(t.codec) ? 'ass' : 'srt' }));
            out.audio = info.tracks.filter((t) => t.type === 2).map((t) => ({ n: t.n, lang: t.lang, name: t.name, default: t.default, codec: t.codec.replace(/^A_/, '') }));
            out.chapters = info.chapters;
          }
        } catch { /* */ }
      }
      return out;
    };
    src.subsUrl = async (rec, sel, onProgress) => {
      let vtt = null;
      if (sel === 'file') { const s = sidecarOf(rec); if (!s) return null; let txt = await s.file.text(); vtt = P.srtToVtt(txt); }
      else {
        const key = `${rec.path}|${sel}|${rec.size}|${rec.mtime}`;
        vtt = await idb.get('subs', key);
        if (!vtt) { vtt = await P.mkvExtractSubs(readerFor(rec.file), sel, onProgress); if (vtt) await idb.put('subs', key, vtt); }
      }
      if (!vtt) return null;
      return URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' }));
    };
    src.computer = async () => {
      const items = [];
      for (const h of handles.values()) items.push({ label: h.name, kind: 'drive', path: h.id, missing: !h.handle, title: [h.name, h.handle ? 'Folder you opened' : 'Needs to be picked again this session'], forget: true });
      items.push({ label: 'Open a folder…', kind: 'up', action: 'pick', title: ['Open a folder', src.persistent ? 'Pick any folder on this PC. The browser remembers it.' : 'Pick any folder on this PC. This browser forgets it when the tab closes, so you pick again next time.'] });
      return { items, status: (handles.size ? `${handles.size} folder${handles.size === 1 ? '' : 's'} opened in this browser` : 'Nothing opened yet') + ' · you can also drop a folder onto this page' };
    };
    src.kiyora = async () => null;
    src.thumbCache = { get: (k) => idb.get('thumbs', k), put: (k, v) => idb.put('thumbs', k, v) };
    return src;
  }

  // ================================================================== ServerSource
  function ServerSource() {
    const src = { mode: 'server', local: false, state: DEFAULT_STATE(), needsReconnect: false };
    const get = async (route, params) => { const r = await fetch('/api/' + route + (params ? '?' + new URLSearchParams(params) : '')); if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText); return r.json(); };
    const post = async (route, body) => { const r = await fetch('/api/' + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); if (!r.ok) throw new Error(r.statusText); return r.json(); };
    src.loadState = async () => { src.state = Object.assign(DEFAULT_STATE(), await get('state')); return src.state; };
    src.saveState = async (patch) => { const S = src.state; if (patch.roots) S.roots = patch.roots; if (patch.settings) Object.assign(S.settings, patch.settings); if (patch.resume) Object.assign(S.resume, patch.resume); if (patch.clearResume) delete S.resume[patch.clearResume]; await post('state', patch); return S; };
    src.reconnect = async () => true;
    src.supported = () => true;
    src.pickFolder = async () => null;
    src.rootLabel = (p) => p;
    src.displayPath = (p) => p;
    src.ls = async (p) => get('ls', { path: p });
    src.scan = async (root, kinds) => { const r = await get('scan', { path: root, kinds: kinds.join(',') }); for (const f of r.files) f.root = root; return r.files; };
    src.rec = (p) => ({ path: p, name: p.split(/[\\/]/).pop() });
    src.url = (x) => '/media?path=' + enc(typeof x === 'string' ? x : x.path);
    src.tags = async (files, onProgress) => {
      const need = files.filter((f) => !f.tags);
      for (let i = 0; i < need.length; i += 300) {
        const chunk = need.slice(i, i + 300);
        try { const r = await post('tags', { paths: chunk.map((f) => f.path) }); for (const f of chunk) f.tags = r[f.path] || {}; } catch { for (const f of chunk) f.tags = {}; }
        if (onProgress) onProgress(Math.min(need.length, i + 300), need.length);
      }
      return files;
    };
    src.cover = async (rec) => (rec && rec.tags && (rec.tags.cover || rec.tags.folderCover) ? '/api/cover?path=' + enc(rec.path) : null);
    src.tracks = async (rec) => { const r = await fetch('/api/tracks?path=' + enc(rec.path)); return r.ok ? r.json() : { subs: [], audio: [], chapters: [], sidecar: false }; };
    src.subsUrl = async (rec, sel) => { const u = sel === 'file' ? '/api/subs?path=' + enc(rec.path) : `/api/subs?path=${enc(rec.path)}&track=${sel}`; const r = await fetch(u); return r.ok ? u : null; };
    src.computer = async () => {
      const [drives, home] = await Promise.all([get('drives'), get('home')]);
      const items = drives.map((d) => ({ label: `Local Disk (${d.name})`, kind: 'drive', path: d.path, title: [`Local Disk (${d.name})`, d.total ? `${fmtBytes(d.free)} free of ${fmtBytes(d.total)}` : ''], badge: d.total ? Math.round((1 - d.free / d.total) * 100) + '%' : null }));
      for (const s of home.special) items.push({ label: s.name, kind: 'dir', path: s.path, title: [s.name, s.path] });
      if (home.onedrive) items.push({ label: 'OneDrive', kind: 'dir', path: home.onedrive, title: ['OneDrive', home.onedrive] });
      return { items, status: `${home.user} on ${home.host}` };
    };
    src.kiyora = async () => { try { return await get('kiyora'); } catch { return null; } };
    src.thumbCache = { get: (k) => idb.get('thumbs', k), put: (k, v) => idb.put('thumbs', k, v) };
    return src;
  }
  const fmtBytes = (n) => { if (!n) return '0 B'; const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return (i >= 3 ? n.toFixed(1) : Math.round(n)) + ' ' + u[i]; };

  // ================================================================== pick one
  async function detect() {
    const forced = localStorage.getItem('whistler.mode');
    if (forced !== 'local') {
      try {
        const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 1500);
        const r = await fetch('/api/home', { signal: ctl.signal }); clearTimeout(t);
        if (r.ok && (r.headers.get('content-type') || '').includes('json')) { const s = ServerSource(); s.available = true; return s; }
      } catch { /* not served by server.js */ }
    }
    return LocalSource();
  }
  async function serverAvailable() {
    try { const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 1500); const r = await fetch('/api/home', { signal: ctl.signal }); clearTimeout(t); return r.ok && (r.headers.get('content-type') || '').includes('json'); } catch { return false; }
  }
  window.Source = { detect, serverAvailable, LocalSource, ServerSource, idb };
})();
