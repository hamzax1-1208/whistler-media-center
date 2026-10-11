'use strict';
/* Whistler Media Center — the screens, the players, keyboard and gamepad.
   Plain JS, no framework, no build step. Media comes through `src` (source.js): either the
   File System Access API (nothing installed) or the optional Node server.

   Layout numbers for the 2002 theme (watermark at -30/-52, modes column at 72/186, grid at
   428/150, paging at 700/616 ...) come from Kiyora's views, measured against 1024x768
   screenshots of the real Media Center 2002. Whistler and Netflix restyle the same DOM.    */

// =============================================================================== utilities
const $ = (s, r = document) => r.querySelector(s);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const baseName = (p) => p.split(/[\\/]/).filter(Boolean).pop() || p;
const dirName = (p) => { const m = /^(.*)[\\/][^\\/]+[\\/]?$/.exec(p); return m ? (m[1].length === 2 && m[1][1] === ':' ? m[1] + '\\' : m[1]) : p; };
const stripExt = (n) => n.replace(/\.[^.]+$/, '');
const natCmp = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const fmtTime = (s) => { if (!isFinite(s) || s < 0) return '0:00'; s = Math.floor(s); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };
const fmtBytes = (n) => { if (!n) return '0 B'; const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return (i >= 3 ? n.toFixed(1) : Math.round(n)) + ' ' + u[i]; };
const fmtDate = (ms) => ms ? new Date(ms).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' }) : '';
const shuffled = (a) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

const G = {
  folder: '<svg viewBox="0 0 24 24"><path d="M3 6h6l2 2h10v11H3z"/><path d="M3 10h18"/></svg>',
  film: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="1"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/></svg>',
  note: '<svg viewBox="0 0 24 24"><path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/></svg>',
  pic: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16"/><path d="M3 16l5-5 4 4 3-3 6 6"/><circle cx="16" cy="9" r="2"/></svg>',
  drive: '<svg viewBox="0 0 24 24"><rect x="2" y="7" width="20" height="10" rx="2"/><circle cx="18" cy="12" r="1.5"/><path d="M5 12h8"/></svg>',
  disc: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/></svg>',
  up: '<svg viewBox="0 0 24 24"><path d="M12 19V6M6 12l6-6 6 6"/></svg>',
  gear: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  tv: '<svg viewBox="0 0 290 240"><rect x="8" y="8" width="274" height="180" rx="14" fill="#fff"/><rect x="80" y="196" width="130" height="14" rx="6" fill="#fff"/><rect x="40" y="216" width="210" height="14" rx="6" fill="#fff"/></svg>',
};
const glyphFor = (kind) => ({ dir: G.folder, video: G.film, audio: G.note, image: G.pic, drive: G.drive, album: G.disc, up: G.up, gear: G.gear, plus: G.plus })[kind] || G.folder;

// =============================================================================== state, source, themes
let src = null;                 // set at boot (source.js)
let S = { roots: { videos: [], music: [], pictures: [] }, resume: {}, settings: {} };
const DEFAULTS = { clock24: false, slideshowSeconds: 5, kenBurns: true, visualizer: true, autoplayNext: true, roast: true, theme: '2002', subtitles: 'auto', subtitleLang: 'eng', subtitleSize: 'normal', sounds: true };
const setting = (k) => (S.settings[k] === undefined ? DEFAULTS[k] : S.settings[k]);
async function saveSettings(patch) { Object.assign(S.settings, patch); try { await src.saveState({ settings: patch }); } catch { /* */ } }
async function saveRoots() { try { await src.saveState({ roots: S.roots }); } catch { /* */ } }
async function saveResumeRec(path, rec) { S.resume[path] = rec; try { await src.saveState({ resume: { [path]: rec } }); } catch { /* */ } }
async function clearResumeRec(path) { delete S.resume[path]; try { await src.saveState({ clearResume: path }); } catch { /* */ } }

const THEMES = {
  '2002': { name: 'Media Center 2002', tiles: 9, cols: 3, rows: 11, canvas: true },
  whistler: { name: 'Whistler Beta 2', tiles: 16, cols: 4, rows: 22, canvas: true },
  netflix: { name: 'Netflix', tiles: 12, cols: 6, rows: 6, canvas: false },
};
const theme = () => THEMES[setting('theme')] || THEMES['2002'];
function applyTheme() { document.body.dataset.theme = THEMES[setting('theme')] ? setting('theme') : '2002'; fitStage(); }

// =============================================================================== stage & navigation
const stage = $('#stage');
function fitStage() { document.documentElement.style.setProperty('--s', theme().canvas ? Math.min(innerWidth / 1024, innerHeight / 768) : 1); }
addEventListener('resize', fitStage); fitStage();

const history_ = [];
let current = null;
function go(screen) { if (current && current.leave) current.leave(); history_.push(screen); current = screen; screen.render(); chromeUpdate(); }
function back() { if (history_.length <= 1) return; const old = history_.pop(); if (old.leave) old.leave(); current = history_[history_.length - 1]; current.render(); chromeUpdate(); }
function home() { while (history_.length > 1) { const o = history_.pop(); if (o.leave) o.leave(); } current = history_[0]; current.render(); chromeUpdate(); }
function rerender() { if (current) current.render(); chromeUpdate(); }
function mount(node) { stage.innerHTML = ''; node.classList.add('screen'); node.prepend(chrome_()); stage.appendChild(node); return node; }
// Window chrome that only some themes show: a Luna title bar. Hidden by CSS elsewhere.
function chrome_() {
  const tb = el('div', 'titlebar');
  const ico = el('span', 'tb-ico'); ico.innerHTML = G.film; tb.appendChild(ico);
  tb.appendChild(el('span', 'tb-text', 'Whistler Media Center'));
  const mk = (cls, txt, fn) => { const b = el('span', 'tb-btn ' + cls, txt); b.onclick = fn; tb.appendChild(b); };
  mk('min', '_', () => toast('There is no taskbar to minimise to.', 1200)); mk('max', '□', () => toggleFullscreen()); mk('close', '×', () => { if (history_.length > 1) back(); else toast('This is the start screen. Close the tab if you must.', 1500); });
  return tb;
}
function toast(msg, ms = 1800) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, ms); }

const KEYMAP = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Enter: 'enter', ' ': 'space', Backspace: 'back', Escape: 'back', BrowserBack: 'back',
  PageUp: 'pgup', PageDown: 'pgdn', Home: 'home', End: 'end', MediaPlayPause: 'playpause', MediaTrackNext: 'next', MediaTrackPrevious: 'prev', MediaStop: 'stop', Tab: 'tab' };
addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const name = KEYMAP[e.key] || (e.key.length === 1 ? e.key.toLowerCase() : null); if (!name) return;
  if (handleKey(name, e)) e.preventDefault();
});
addEventListener('keyup', (e) => { const name = KEYMAP[e.key]; if (name && player.isOpen()) player.keyup(name); });
// UI sounds, the way the shell did them: a tick on every cursor move, a note on select, a
// buzz on error, a sting at startup. Files are not bundled; drop focus.wav / select.wav /
// error.wav / intro.wav into public/sounds/ and the Sounds setting lights up.
const sfx = (() => {
  const clips = {}; const missing = new Set();
  function get(name) {
    if (missing.has(name)) return null;
    if (!clips[name]) { const a = new Audio('sounds/' + name + '.wav'); a.preload = 'auto'; a.addEventListener('error', () => missing.add(name), { once: true }); clips[name] = a; }
    return clips[name];
  }
  return {
    play(name) { if (!setting('sounds')) return; const a = get(name); if (!a) return; try { a.currentTime = 0; a.volume = name === 'intro' ? 0.6 : 0.35; a.play().catch(() => {}); } catch { /* */ } },
    available() { return Object.keys(clips).some((k) => !missing.has(k)); },
    probe() { ['focus', 'select', 'error', 'intro'].forEach(get); },
  };
})();
function handleKey(name, e) {
  if (!dlg.hidden) { const r = dialogKey(name); if (r && (name === 'enter' || name === 'space')) sfx.play('select'); else if (r && (name === 'left' || name === 'right')) sfx.play('focus'); return r; }
  if (player.isOpen()) return player.key(name, e);
  if (photoViewer.isOpen()) return photoViewer.key(name);
  const handled = handleKeyInner(name, e);
  if (handled && ['up', 'down', 'left', 'right', 'pgup', 'pgdn'].includes(name)) sfx.play('focus');
  else if (handled && (name === 'enter' || name === 'space')) sfx.play('select');
  else if (handled && name === 'back') sfx.play('focus');
  return handled;
}
function handleKeyInner(name, e) {
  if (name === 'home') { home(); return true; }
  if (name === 'playpause') { music.toggle(); return true; }
  if (name === 'next') { music.next(); return true; }
  if (name === 'prev') { music.prev(); return true; }
  if (name === 'stop') { music.stop(); return true; }
  if (current && current.key && current.key(name, e)) return true;
  if (name === 'f') { toggleFullscreen(); return true; }
  if (name === 't') { cycleTheme(); return true; }
  return false;
}
async function cycleTheme() { const ids = Object.keys(THEMES); const i = ids.indexOf(setting('theme')); await saveSettings({ theme: ids[(i + 1) % ids.length] }); applyTheme(); rerender(); toast('Theme: ' + theme().name, 1200); }

// =============================================================================== dialog
const dlg = $('#dialog');
let dlgState = null;
function dialog({ title, text, buttons = ['Yes', 'No'], def = 0 }) {
  return new Promise((resolve) => {
    dlg.innerHTML = '';
    const box = el('div', 'dlg'); box.appendChild(el('div', 't', title)); box.appendChild(el('div', 'q', text));
    const btns = el('div', 'btns');
    const bs = buttons.map((b, i) => { const x = el('div', 'slab btn', b); x.onclick = () => finish(i); x.onmouseenter = () => { dlgState.idx = i; paint(); }; btns.appendChild(x); return x; });
    box.appendChild(btns); dlg.appendChild(box); dlg.hidden = false;
    dlgState = { idx: def, n: buttons.length, finish };
    function paint() { bs.forEach((b, i) => b.classList.toggle('focus', i === dlgState.idx)); }
    function finish(i) { dlg.hidden = true; dlgState = null; resolve(i); }
    paint();
  });
}
function dialogKey(name) {
  const d = dlgState; if (!d) return false;
  if (name === 'left' || name === 'up') d.idx = (d.idx + d.n - 1) % d.n;
  else if (name === 'right' || name === 'down' || name === 'tab') d.idx = (d.idx + 1) % d.n;
  else if (name === 'enter' || name === 'space') d.finish(d.idx);
  else if (name === 'back') d.finish(d.n - 1);
  dlg.querySelectorAll('.btn').forEach((b, i) => b.classList.toggle('focus', i === d.idx));
  return true;
}
const confirm_ = async (title, text) => (await dialog({ title, text })) === 0;

// =============================================================================== video thumbnails (frame grabs, cached in IndexedDB)
const thumbs = (() => {
  const mem = new Map(); const queue = []; let running = 0;
  function pump() { while (running < 2 && queue.length) { const job = queue.shift(); running++; capture(job.rec).then(job.res, () => job.res(null)).finally(() => { running--; pump(); }); } }
  function capture(rec) {
    return new Promise((res, rej) => {
      const v = document.createElement('video'); v.muted = true; v.preload = 'metadata';
      const done = (x) => { clearTimeout(t); v.removeAttribute('src'); v.load(); x ? res(x) : rej(); };
      const t = setTimeout(() => done(null), 9000);
      v.onloadedmetadata = () => { v.currentTime = clamp(v.duration * 0.15, 3, 600); };
      v.onseeked = () => {
        try {
          const c = document.createElement('canvas'); c.width = 192; c.height = 108;
          const g = c.getContext('2d'); const vr = v.videoWidth / v.videoHeight || 16 / 9, cr = 16 / 9;
          let sw = v.videoWidth, sh = v.videoHeight, sx = 0, sy = 0;
          if (vr > cr) { sw = sh * cr; sx = (v.videoWidth - sw) / 2; } else { sh = sw / cr; sy = (v.videoHeight - sh) / 2; }
          g.drawImage(v, sx, sy, sw, sh, 0, 0, 192, 108);
          const px = g.getImageData(0, 0, 192, 108).data; let sum = 0;
          for (let i = 0; i < px.length; i += 64) sum += px[i] + px[i + 1] + px[i + 2];
          if (sum / (px.length / 64) < 12) return done(null);   // undecodable = black; don't cache
          done(c.toDataURL('image/jpeg', 0.72));
        } catch { done(null); }
      };
      v.onerror = () => done(null);
      v.src = src.url(rec);
    });
  }
  return {
    async video(rec) {
      const k = rec.path + '|' + Math.floor(rec.mtime || 0);
      if (mem.has(k)) return mem.get(k);
      const c = await src.thumbCache.get(k); if (c) { mem.set(k, c); return c; }
      const url = await new Promise((res) => { queue.push({ rec, res }); pump(); });
      if (url) { mem.set(k, url); src.thumbCache.put(k, url); }
      return url;
    },
  };
})();

// =============================================================================== the generic browse screen
// spec: { watermark, section, title:[big,small], modes:[{label, dot, run}], items:[{label, sub, meta, kind, thumb, mosaic, run, title, progress, badge, num, mark, value, playing}],
//         view:'tiles'|'rows', empty, loading, status, extra, key }
function browseScreen(spec) {
  const sc = { spec, col: 'items', idx: 0, modeIdx: 0, node: null, renderedPage: -1 };
  const pageSize = () => (sc.spec.view === 'tiles' ? theme().tiles : theme().rows);
  const cols = () => (sc.spec.view === 'tiles' ? theme().cols : 1);
  const items = () => sc.spec.items || [];
  const page = () => Math.floor(sc.idx / pageSize());
  sc.setItems = (list, keepIdx) => { sc.spec.items = list; if (!keepIdx) sc.idx = 0; sc.idx = clamp(sc.idx, 0, Math.max(0, list.length - 1)); sc.renderedPage = -1; sc.render(); };
  sc.setSpec = (patch) => { Object.assign(sc.spec, patch); sc.renderedPage = -1; sc.render(); };

  sc.render = () => {
    const sp = sc.spec; const n = mount(el('div')); sc.node = n;
    n.appendChild(el('div', 'wm', sp.watermark));
    n.appendChild(el('div', 'section', sp.section || ''));
    const tb = el('div', 'titleblock'); tb.appendChild(el('div', 'big')); tb.appendChild(el('div', 'small')); n.appendChild(tb);
    const modes = el('div', 'modes');
    (sp.modes || []).forEach((m, i) => {
      const r = el('div', 'slab mode'); r.appendChild(el('span', 'lbl', m.label));
      if (m.dot !== undefined) { const d = el('span', 'dot'); if (m.dot) d.classList.add('on'); r.appendChild(d); }
      r.onmouseenter = () => { sc.col = 'modes'; sc.modeIdx = i; sc.paint(); };
      r.onclick = () => { sc.col = 'modes'; sc.modeIdx = i; sc.paint(); sc.activate(); };
      modes.appendChild(r);
    });
    n.appendChild(modes);
    const host = el('div', sp.view === 'tiles' ? 'grid' : 'rows'); n.appendChild(host); sc.host = host;
    const paging = el('div', 'paging'); n.appendChild(paging); sc.pagingEl = paging;
    if (sp.loading) n.appendChild(el('div', 'loading', sp.loading));
    else if (!items().length && sp.empty) { const e = el('div', 'empty'); e.innerHTML = sp.empty; n.appendChild(e); }
    if (sp.extra) n.appendChild(sp.extra());
    if (sp.status) n.appendChild(el('div', 'status', sp.status));
    if (!items().length && (sp.modes || []).length) { sc.col = 'modes'; sc.colByEmpty = true; }
    else if (items().length && sc.colByEmpty) { sc.col = 'items'; sc.colByEmpty = false; }
    sc.renderedPage = -1; sc.renderItems(); sc.paint();
  };
  sc.renderItems = () => {
    const host = sc.host; host.innerHTML = '';
    const ps = pageSize(), pg = page(); sc.renderedPage = pg;
    const list = items().slice(pg * ps, pg * ps + ps);
    list.forEach((it, j) => {
      const i = pg * ps + j; let node;
      if (sc.spec.view === 'tiles') {
        node = el('div', 'tile'); const th = el('div', 'thumb');
        const glyph = () => { const g = el('div', 'glyph'); g.innerHTML = glyphFor(it.kind); th.appendChild(g); };
        if (it.mosaic && it.mosaic.length) {
          const m = el('div', 'mosaic'); it.mosaic.slice(0, 4).forEach((u) => { const im = el('img'); im.loading = 'lazy'; im.src = u; im.onerror = () => im.remove(); m.appendChild(im); }); th.appendChild(m);
          if (it.mosaic.length === 1) { m.style.gridTemplateColumns = '1fr'; m.style.gridTemplateRows = '1fr'; }
          it._hero = it.mosaic[0];
        } else if (typeof it.thumb === 'string') { const im = el('img'); im.loading = 'lazy'; im.src = it.thumb; im.onerror = () => { im.remove(); glyph(); }; th.appendChild(im); it._hero = it.thumb; }
        else if (typeof it.thumb === 'function') {
          if (it._hero) { const im = el('img'); im.src = it._hero; th.appendChild(im); }
          else { glyph(); Promise.resolve(it.thumb()).then((u) => { if (!u) return; it._hero = u; if (!th.isConnected) return; th.querySelector('.glyph')?.remove(); const im = el('img'); im.src = u; th.prepend(im); if (sc.col === 'items' && items()[sc.idx] === it) sc.hero(); }).catch(() => {}); }
        } else glyph();
        if (it.badge) th.appendChild(el('span', 'badge', it.badge));
        if (it.progress) { const p = el('div', 'prog'); const b = el('i'); b.style.width = (it.progress * 100) + '%'; p.appendChild(b); th.appendChild(p); }
        node.appendChild(th); node.appendChild(el('div', 'cap', it.label));
      } else {
        node = el('div', 'slab row');
        const mk = el('div', 'mark'); if (it.mark) { const d = el('i'); if (it.mark === 'half') d.classList.add('half'); mk.appendChild(d); } node.appendChild(mk);
        const ico = el('div', 'ico'); if (it.num != null) ico.appendChild(el('span', 'num', String(it.num))); else ico.innerHTML = glyphFor(it.kind); node.appendChild(ico);
        const eq = el('div', 'eq'); eq.append(el('i'), el('i'), el('i')); node.appendChild(eq);
        const lbl = el('div', 'lbl', it.label); if (it.sub) lbl.appendChild(el('span', 'sub', it.sub)); node.appendChild(lbl);
        if (it.value != null) node.appendChild(el('div', 'val', it.value));
        if (it.meta) node.appendChild(el('div', 'meta', it.meta));
        if (it.playing) node.classList.add('playing');
      }
      node.onmouseenter = () => { sc.col = 'items'; sc.idx = i; sc.paint(); };
      node.onclick = () => { sc.col = 'items'; sc.idx = i; sc.paint(); sc.activate(); };
      host.appendChild(node);
    });
    const total = items().length, pages = Math.max(1, Math.ceil(total / ps));
    const pe = sc.pagingEl; pe.innerHTML = '';
    if (total) {
      pe.appendChild(el('span', '', `${sc.idx + 1} of ${total}`));
      const ch = el('div', 'chev'); const up = el('span', pg === 0 ? 'dim' : '', '▲'), dn = el('span', pg >= pages - 1 ? 'dim' : '', '▼');
      up.onclick = () => sc.move('pgup'); dn.onclick = () => sc.move('pgdn'); ch.append(up, dn); pe.appendChild(ch);
    }
  };
  sc.hero = () => { const it = sc.col === 'items' ? items()[sc.idx] : null; const u = it && it._hero; if (sc.node) sc.node.style.setProperty('--hero', u ? `url("${u}")` : 'none'); };
  sc.paint = () => {
    if (!sc.node) return;
    if (page() !== sc.renderedPage) sc.renderItems();
    const ps = pageSize(), pg = page();
    [...sc.host.children].forEach((c, j) => c.classList.toggle('focus', sc.col === 'items' && pg * ps + j === sc.idx));
    [...sc.node.querySelectorAll('.modes .mode')].forEach((c, j) => c.classList.toggle('focus', sc.col === 'modes' && j === sc.modeIdx));
    const mc = sc.node.querySelector('.modes'); if (mc) mc.classList.toggle('dormant', sc.col !== 'modes');   // Common.Button.Dormant when the cursor is elsewhere
    const it = sc.col === 'items' ? items()[sc.idx] : null;
    const t = it ? (it.title || [it.label, it.sub || '']) : (sc.spec.title || ['', '']);
    sc.node.querySelector('.titleblock .big').textContent = t[0] || '';
    sc.node.querySelector('.titleblock .small').textContent = t[1] || '';
    const pe = sc.pagingEl.firstChild; if (pe && items().length) pe.textContent = `${sc.idx + 1} of ${items().length}`;
    sc.hero();
  };
  sc.move = (name) => {
    const n = items().length, c = cols(), ps = pageSize();
    if (sc.col === 'modes') {
      const mn = (sc.spec.modes || []).length;
      const horizontal = !theme().canvas;   // netflix: the modes are a top bar
      if (name === (horizontal ? 'left' : 'up')) sc.modeIdx = Math.max(0, sc.modeIdx - 1);
      else if (name === (horizontal ? 'right' : 'down')) sc.modeIdx = Math.min(mn - 1, sc.modeIdx + 1);
      else if (name === (horizontal ? 'down' : 'right') && n) sc.col = 'items';
      else return false;
    } else {
      if (name === 'up') { if (sc.idx - c >= 0) sc.idx -= c; else if (!theme().canvas && (sc.spec.modes || []).length) sc.col = 'modes'; else if (c > 1 && sc.idx > 0) sc.idx = 0; else return false; }
      else if (name === 'down') { if (sc.idx + c < n) sc.idx += c; else if (sc.idx < n - 1) sc.idx = n - 1; else return false; }
      else if (name === 'left') { if (c > 1 && sc.idx % c !== 0) sc.idx--; else if (theme().canvas && (sc.spec.modes || []).length) sc.col = 'modes'; else return false; }
      else if (name === 'right') { if (c > 1 && sc.idx % c !== c - 1 && sc.idx < n - 1) sc.idx++; else return false; }
      else if (name === 'pgdn') sc.idx = Math.min(n - 1, (Math.floor(sc.idx / ps) + 1) * ps);
      else if (name === 'pgup') sc.idx = Math.max(0, (Math.floor(sc.idx / ps) - 1) * ps);
      else if (name === 'end') sc.idx = n - 1;
      else return false;
    }
    sc.paint(); return true;
  };
  sc.activate = () => {
    if (sc.col === 'modes') { const m = (sc.spec.modes || [])[sc.modeIdx]; if (m && m.run) m.run(sc, m); return true; }
    const it = items()[sc.idx]; if (it && it.run) it.run(it, sc, sc.idx); return true;
  };
  sc.key = (name) => {
    if (name === 'enter' || name === 'space') return sc.activate();
    if (name === 'back') { back(); return true; }
    if (sc.spec.key && sc.spec.key(name, sc)) return true;
    return sc.move(name);
  };
  return sc;
}

// =============================================================================== start screen
function startScreen() {
  const entries = [
    { label: 'My Videos', glyph: G.film, run: () => go(videosScreen()) },
    { label: 'My Music', glyph: G.note, run: () => go(musicScreen()) },
    { label: 'My Pictures', glyph: G.pic, run: () => go(picturesScreen()) },
    { label: 'My Computer', glyph: G.drive, run: () => go(computerScreen()) },
    { label: 'Settings', glyph: G.gear, run: () => go(settingsScreen()) },
  ];
  const sc = { idx: 0, timer: null };
  sc.render = () => {
    const n = mount(el('div'));
    const ghost = el('div', 'ghost'); n.appendChild(ghost);
    n.appendChild(el('div', 'wm start', 'start'));
    const clock = el('div', 'clock'); clock.appendChild(el('div', 'date')); clock.appendChild(el('div', 'time')); n.appendChild(clock);
    const ub = el('div', 'userband'); const av = el('span', 'avatar'); av.textContent = '☺'; ub.appendChild(av); ub.appendChild(el('span', '', src.local ? 'Whistler' : 'Whistler')); n.appendChild(ub);
    const menu = el('div', 'menu');
    entries.forEach((e, i) => {
      const r = el('div', 'slab entry'); const ico = el('span', 'ico'); ico.innerHTML = e.glyph; r.appendChild(ico); r.appendChild(el('span', 'lbl', e.label));
      r.onmouseenter = () => { sc.idx = i; sc.paint(); }; r.onclick = () => { sc.idx = i; sc.paint(); e.run(); };
      menu.appendChild(r);
    });
    n.appendChild(menu);
    const foot = el('div', 'startfoot'); foot.innerHTML = '<span><i class="log"></i>Log Off</span><span><i></i>Turn Off Computer</span>'; n.appendChild(foot);
    n.appendChild(el('div', 'status', 'Whistler Media Center · ' + (src.local ? 'reading your folders in the browser' : 'server mode') + ' · T switches theme'));
    sc.node = n; sc.paint(); sc.tick();
    clearInterval(sc.timer); sc.timer = setInterval(sc.tick, 1000);
  };
  sc.tick = () => {
    if (!sc.node || !sc.node.isConnected) return;
    const d = new Date();
    sc.node.querySelector('.date').textContent = d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    sc.node.querySelector('.time').textContent = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: !setting('clock24') });
  };
  sc.paint = () => {
    [...sc.node.querySelectorAll('.entry')].forEach((r, i) => r.classList.toggle('focus', i === sc.idx));
    // Image.HomeWatermark: the ghosted device swaps with the focused entry
    const g = sc.node.querySelector('.ghost'); if (g) g.innerHTML = entries[sc.idx].glyph;
  };
  sc.key = (name) => {
    const horizontal = !theme().canvas;
    if (name === (horizontal ? 'left' : 'up')) sc.idx = Math.max(0, sc.idx - 1);
    else if (name === (horizontal ? 'right' : 'down')) sc.idx = Math.min(entries.length - 1, sc.idx + 1);
    else if (name === 'enter' || name === 'space' || name === (horizontal ? 'down' : 'right')) { entries[sc.idx].run(); return true; }
    else return false;
    sc.paint(); return true;
  };
  sc.leave = () => clearInterval(sc.timer);
  return sc;
}

// =============================================================================== library helpers
const scanCache = new Map();
async function scanRoots(roots, kinds) {
  const key = kinds + '|' + roots.join('|');
  if (scanCache.has(key) && Date.now() - scanCache.get(key).at < 120000) return scanCache.get(key).files;
  const seen = new Set(); const files = [];
  for (const r of roots) { try { for (const f of await src.scan(r, kinds)) if (!seen.has(f.path)) { seen.add(f.path); files.push(f); } } catch { /* unreadable root */ } }
  scanCache.set(key, { at: Date.now(), files });
  return files;
}
const noRootsHtml = (kind) => src.local
  ? `No ${kind} folders yet.<small>Go to <b>My Computer</b>, choose <b>Open a folder…</b> (or drop a folder onto this page), then pick "Use as ${kind} folder" from the left column. ${src.persistent ? 'The browser remembers it; nothing gets installed.' : 'This browser forgets folders between sessions, so you pick again next time.'}</small>`
  : `No ${kind} folders yet.<small>Go to <b>My Computer</b>, open a folder, and choose "Use as ${kind} folder" from the left column. Or import Kiyora's folders from Settings.</small>`;

// scene-release title parsing (port of Kiyora's TitleParser, trimmed)
const NOISE = new Set(('2160p 1440p 1080p 1080o 720p 480p 360p 4k uhd bluray blu-ray bdrip bdmv brrip bd webrip web-dl webdl web hdtv dvdrip dvd remux cr adn funi amzn nf ' +
  'x264 x265 h264 h265 hevc avc av1 xvid divx hi10p hi10 8bit 10bit 10bits aac ac3 eac3 dd+ ddp dts flac opus mp3 dual audio dualaudio multi multisub multisubs subs sub subbed dubbed ' +
  'eng engsub english vostfr jpn jap msubs softsubs subtitle subtitles multiple repack proper uncensored uncut complete batch nced ncop v0 v1 v2 v3').split(' '));
function cleanTitle(s) {
  s = stripExt(s).replace(/^\s*\[[^\]]+\]\s*/, '').replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/[._]/g, ' ');
  s = s.replace(/\b10\s*bits?\b|\bdual\s*audio\b|\bmulti[\s-]*subs?\b|\baac\s*2\s*[.]?\s*0\b|\bh\s*[.]?\s*26[45]\b|\bweb\s*-\s*dl\b|\b[25]\s*[.]\s*[01]\b/gi, ' ');
  s = s.replace(/\s[-–]\s*\d{1,3}\s*[~\-–]\s*\d{1,3}\s*$/, '');
  let year = null;
  const toks = s.split(/\s+/).filter(Boolean).filter((t) => {
    const l = t.toLowerCase(); const head = l.split('-')[0];
    if (NOISE.has(l) || NOISE.has(head) || t.startsWith('-')) return false;
    if (/^[a-z]*\d{3,4}[pi]$/i.test(t) || /^[0-9A-F]{8}$/i.test(t)) return false;
    if (/^(19|20)\d{2}$/.test(t)) { year = year || +t; return false; }
    return true;
  });
  let title = toks.join(' ').replace(/[-\s]+$/, '').replace(/^[-\s]+/, '').trim();
  const sm = /\bS(?:eason)?s?\s*(\d{1,2})\b.*$/i.exec(title);
  let season = null; if (sm) { season = +sm[1]; title = title.slice(0, sm.index).replace(/[-\s]+$/, '').trim() || title; }
  return { title: title || stripExt(s).trim(), year, season };
}
function parseEpisode(name) {
  const s = stripExt(name).replace(/^\s*\[[^\]]+\]\s*/, '').replace(/\[[^\]]*\]/g, ' ').replace(/[._]/g, ' ');
  let m;
  const out = (season, ep, idx, len) => ({ season, ep, pre: s.slice(0, idx), post: s.slice(idx + len).replace(/^[\s\-–:]+/, '').replace(/\s*\(.*\)\s*$/, '').trim() });
  if ((m = /\bS(\d{1,2})\s*E(\d{1,3})\b/i.exec(s))) return out(+m[1], +m[2], m.index, m[0].length);
  if ((m = /\b(\d{1,2})x(\d{1,3})\b/i.exec(s))) return out(+m[1], +m[2], m.index, m[0].length);
  if ((m = /\s[-–]\s*(\d{1,3})(?:v\d)?\b(?!\s*[pi]\b)/.exec(s))) return out(null, +m[1], m.index, m[0].length);
  if ((m = /\b(?:E|Ep|Episode)\s*(\d{1,3})\b/i.exec(s))) return out(null, +m[1], m.index, m[0].length);
  if ((m = /\b(\d{1,3})\s*$/.exec(s))) return out(null, +m[1], m.index, m[0].length);
  return { season: null, ep: null, pre: s, post: '' };
}

// =============================================================================== My Videos
function videosScreen() {
  const sc = browseScreen({ watermark: 'videos', section: 'MY VIDEOS', title: ['My Videos', ''], view: 'tiles', modes: [], loading: 'Looking through your video folders' });
  let files = [], series = [], view = 'series', sort = 'name';
  const roots = S.roots.videos || [];
  const load = async () => {
    if (!roots.length) { sc.setSpec({ loading: null, empty: noRootsHtml('Videos'), modes: modes() }); return; }
    files = await scanRoots(roots, ['video']);
    const groups = new Map();
    const EXTRA_DIR = /^(nc|ncop|nced|ncs|extras?|specials?|ovas?|bonus|ops?|eds?|menus?|creditless|sp)$/i;
    const norm = (d) => d.replace(/[\\/]+$/, '').toLowerCase();
    const isRootDir = (d) => roots.some((r) => norm(r) === norm(d));
    for (const f of files) {
      const ep = parseEpisode(f.name);
      let folder = f.dir; let key, ct, extra = false, dirSeason = null, loose = false;
      if (isRootDir(folder)) {
        const explicit = ep.ep != null && /\bS\d{1,2}\s*E\d{1,3}\b|\b\d{1,2}x\d{1,3}\b|\s[-–]\s*\d{1,3}(?:v\d)?\b|\b(?:E|Ep|Episode)\s*\d{1,3}\b/i.test(f.name);
        if (explicit) { ct = cleanTitle(ep.pre || f.name); key = 't|' + ct.title.toLowerCase(); }
        else { loose = true; ct = { title: baseName(src.rootLabel(folder)), year: null, season: null }; key = 'root|' + folder.toLowerCase(); }
      } else {
        let fn = baseName(folder);
        if (EXTRA_DIR.test(fn) && !isRootDir(dirName(folder))) { extra = true; folder = dirName(folder); fn = baseName(folder); }
        const sm = /^(?:season|s)\s*(\d{1,2})$/i.exec(fn);
        if (sm && !isRootDir(dirName(folder))) { dirSeason = +sm[1]; folder = dirName(folder); fn = baseName(folder); }
        ct = cleanTitle(fn); key = 't|' + ct.title.toLowerCase();
      }
      if (!groups.has(key)) groups.set(key, { title: ct.title, year: ct.year, dir: folder, eps: [] });
      const g = groups.get(key);
      let epTitle = loose ? cleanTitle(f.name).title : ep.post ? cleanTitle(ep.post).title : '';
      if (!epTitle || /^v\d$/i.test(epTitle)) epTitle = null;
      const season = loose ? null : ep.season ?? dirSeason ?? (ep.pre ? cleanTitle(ep.pre).season : null) ?? ct.season ?? null;
      g.eps.push(Object.assign(f, { season, ep: extra || loose ? null : ep.ep, extra, epTitle }));
    }
    series = [...groups.values()];
    for (const g of series) { g.eps.sort((a, b) => (a.season || 0) - (b.season || 0) || (a.ep ?? 1e9) - (b.ep ?? 1e9) || natCmp(a.name, b.name)); g.mtime = Math.max(...g.eps.map((e) => e.mtime)); }
    sc.setSpec({ loading: null, modes: modes(), status: `${files.length} videos in ${series.length} series` });
    show();
  };
  const modes = () => [
    { label: 'Series', dot: view === 'series', run: () => { view = 'series'; sc.setSpec({ modes: modes() }); show(); } },
    { label: 'Folders', dot: view === 'folders', run: () => { view = 'folders'; sc.setSpec({ modes: modes() }); show(); } },
    { label: 'Recently added', dot: view === 'recent', run: () => { view = 'recent'; sc.setSpec({ modes: modes() }); show(); } },
    { label: 'Sort by name', dot: sort === 'name', run: () => { sort = 'name'; sc.setSpec({ modes: modes() }); show(); } },
    { label: 'Sort by date', dot: sort === 'date', run: () => { sort = 'date'; sc.setSpec({ modes: modes() }); show(); } },
  ];
  const sortFn = (a, b) => (sort === 'date' ? b.mtime - a.mtime : natCmp(a.title || a.label, b.title || b.label));
  const show = () => {
    if (!roots.length) return;
    if (view === 'recent') { const recent = files.slice().sort((a, b) => b.mtime - a.mtime).slice(0, 60); sc.setSpec({ view: 'rows', items: recent.map((f) => episodeRow(f, recent)), empty: 'No videos found in your folders.' }); return; }
    if (view === 'folders') {
      const dirs = new Map(); for (const f of files) { if (!dirs.has(f.dir)) dirs.set(f.dir, { title: baseName(f.dir), dir: f.dir, eps: [], mtime: 0 }); const d = dirs.get(f.dir); d.eps.push(f); d.mtime = Math.max(d.mtime, f.mtime); }
      sc.setSpec({ view: 'tiles', items: [...dirs.values()].sort(sortFn).map(seriesTile), empty: 'No videos found in your folders.' }); return;
    }
    sc.setSpec({ view: 'tiles', items: series.slice().sort(sortFn).map(seriesTile), empty: 'No videos found in your folders.' });
  };
  const seriesTile = (g) => ({ label: g.title, kind: 'video', title: [g.title, `${plural(g.eps.length, 'episode')}${g.year ? ' · ' + g.year : ''}`], thumb: () => thumbs.video(g.eps[0]), badge: String(g.eps.length), run: () => go(episodesScreen(g)) });
  sc.render(); load();
  return sc;
}
function episodeRow(f, queue) {
  const r = S.resume[f.path];
  const num = f.ep != null ? (f.season ? `${f.season}×${String(f.ep).padStart(2, '0')}` : String(f.ep).padStart(2, '0')) : null;
  const label = f.epTitle || (f.ep == null ? cleanTitle(f.name).title : `Episode ${f.ep}`);
  const codec = f.tags?.codec ? ' · ' + f.tags.codec : '';
  return { label, num, kind: 'video', mark: r ? (r.done ? 'full' : 'half') : null, meta: f.tags?.duration ? fmtTime(f.tags.duration) : fmtDate(f.mtime),
    title: [label, `${f.seriesTitle || baseName(f.dir)}${f.tags?.width ? ' · ' + f.tags.width + '×' + f.tags.height : ''}${codec}`],
    thumb: () => thumbs.video(f), run: () => player.open(queue.map(videoItem), queue.indexOf(f)), file: f };
}
const videoItem = (f) => ({ rec: f, path: f.path, label: f.epTitle || (f.ep != null ? `Episode ${f.ep}` : cleanTitle(f.name).title), sub: f.seriesTitle || baseName(f.dir) });
function episodesScreen(g) {
  let sort = 'episode';
  const sc = browseScreen({ watermark: 'videos', section: g.title, title: [g.title, plural(g.eps.length, 'episode')], view: 'rows', modes: [] });
  for (const e of g.eps) e.seriesTitle = g.title;
  const modes = () => [
    { label: 'Play', run: () => { const first = g.eps.find((e) => !(S.resume[e.path] && S.resume[e.path].done)) || g.eps[0]; player.open(g.eps.map(videoItem), g.eps.indexOf(first)); } },
    { label: 'Play from start', run: () => player.open(g.eps.map(videoItem), 0) },
    { label: 'Sort by episode', dot: sort === 'episode', run: () => { sort = 'episode'; show(); } },
    { label: 'Sort by name', dot: sort === 'name', run: () => { sort = 'name'; show(); } },
    { label: 'Sort by date', dot: sort === 'date', run: () => { sort = 'date'; show(); } },
    { label: 'Mark all as watched', run: async () => { if (await confirm_('MARK AS WATCHED', `Mark all ${g.eps.length} episodes of ${g.title} as watched?`)) { for (const e of g.eps) await saveResumeRec(e.path, { t: 0, done: true }); show(); } } },
  ];
  const show = () => { const list = g.eps.slice().sort((a, b) => sort === 'name' ? natCmp(a.epTitle || a.name, b.epTitle || b.name) : sort === 'date' ? a.mtime - b.mtime : 0); sc.setSpec({ modes: modes(), items: list.map((f) => episodeRow(f, list)) }); };
  show();
  src.tags(g.eps).then(() => { if (current === sc) show(); });
  return sc;
}

// =============================================================================== My Music
const music = (() => {
  const audio = $('#music');
  const st = { queue: [], idx: -1, shuffle: false, repeat: 'off', ctx: null, analyser: null, data: null, order: [] };
  const cur = () => st.queue[st.idx] || null;
  function ensureAudio() {
    if (st.ctx) { if (st.ctx.state === 'suspended') st.ctx.resume(); return; }
    try {
      st.ctx = new (window.AudioContext || window.webkitAudioContext)();
      const s = st.ctx.createMediaElementSource(audio);
      st.analyser = st.ctx.createAnalyser(); st.analyser.fftSize = 256; st.analyser.smoothingTimeConstant = 0.78;
      s.connect(st.analyser); st.analyser.connect(st.ctx.destination); st.data = new Uint8Array(st.analyser.frequencyBinCount);
    } catch { /* no web audio; playback still works */ }
  }
  function play(i) {
    if (!st.queue.length) return;
    st.idx = (i + st.queue.length) % st.queue.length;
    const t = cur(); ensureAudio();
    audio.src = src.url(t.rec); audio.play().catch(() => {});
    if (t.art === undefined) { t.art = null; src.cover(t.rec).then((u) => { t.art = u; if (cur() === t) { chromeUpdate(); document.dispatchEvent(new CustomEvent('music:track')); } }); }
    chromeUpdate(); mediaSession();
    document.dispatchEvent(new CustomEvent('music:track'));
  }
  function nextIndex(dir) {
    if (st.repeat === 'one') return st.idx;
    if (st.shuffle) { const pos = st.order.indexOf(st.idx); const np = pos + dir; if (np < 0 || np >= st.order.length) { if (st.repeat === 'all') { st.order = shuffled(st.queue.map((_, i) => i)); return st.order[0]; } return -1; } return st.order[np]; }
    const n = st.idx + dir; if (n < 0 || n >= st.queue.length) return st.repeat === 'all' ? (n + st.queue.length) % st.queue.length : -1;
    return n;
  }
  audio.addEventListener('ended', () => { const n = nextIndex(1); if (n >= 0) play(n); else { st.idx = -1; chromeUpdate(); document.dispatchEvent(new CustomEvent('music:track')); } });
  audio.addEventListener('play', chromeUpdate); audio.addEventListener('pause', chromeUpdate);
  audio.addEventListener('error', () => toast("Can't play this file"));
  function mediaSession() {
    if (!('mediaSession' in navigator)) return; const t = cur(); if (!t) return;
    navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist, album: t.album, artwork: t.art ? [{ src: t.art }] : [] });
    navigator.mediaSession.setActionHandler('play', () => audio.play()); navigator.mediaSession.setActionHandler('pause', () => audio.pause());
    navigator.mediaSession.setActionHandler('nexttrack', () => api_.next()); navigator.mediaSession.setActionHandler('previoustrack', () => api_.prev());
  }
  const api_ = {
    audio, state: st, current: cur,
    playQueue(tracks, start = 0, shuffle = false) { st.queue = tracks; st.shuffle = shuffle; st.order = shuffled(tracks.map((_, i) => i)); if (shuffle) start = st.order[0]; play(start); },
    toggle() { if (!cur()) return; if (audio.paused) { ensureAudio(); audio.play(); } else audio.pause(); },
    stop() { audio.pause(); audio.removeAttribute('src'); audio.load(); st.idx = -1; st.queue = []; chromeUpdate(); document.dispatchEvent(new CustomEvent('music:track')); },
    next() { const n = nextIndex(1); if (n >= 0) play(n); },
    prev() { if (audio.currentTime > 4) { audio.currentTime = 0; return; } const n = nextIndex(-1); if (n >= 0) play(n); else audio.currentTime = 0; },
    setShuffle(v) { st.shuffle = v; st.order = shuffled(st.queue.map((_, i) => i)); },
    cycleRepeat() { st.repeat = st.repeat === 'off' ? 'all' : st.repeat === 'all' ? 'one' : 'off'; return st.repeat; },
    vol(d) { audio.volume = clamp(audio.volume + d, 0, 1); toast('Volume ' + Math.round(audio.volume * 100) + '%', 900); },
    spectrum(bars) {
      if (!st.analyser || audio.paused) return null;
      st.analyser.getByteFrequencyData(st.data);
      const out = new Float32Array(bars); const usable = Math.floor(st.data.length * 0.7);
      for (let b = 0; b < bars; b++) { const lo = Math.floor(Math.pow(b / bars, 1.6) * usable), hi = Math.max(lo + 1, Math.floor(Math.pow((b + 1) / bars, 1.6) * usable)); let m = 0; for (let i = lo; i < hi; i++) m = Math.max(m, st.data[i]); out[b] = m / 255; }
      return out;
    },
  };
  return api_;
})();

const trackOf = (f) => {
  const t = f.tags || {}; const dir = f.dir || dirName(f.path);
  return { rec: f, path: f.path, title: t.title || stripExt(f.name), artist: t.artist || t.albumArtist || 'Unknown artist', album: t.album || baseName(dir), albumArtist: t.albumArtist || t.artist || 'Unknown artist',
    year: t.year, track: t.track, disc: t.disc || 1, genre: t.genre || 'Unknown genre', duration: t.duration, hasArt: !!(t.cover || t.folderCover), art: undefined, mtime: f.mtime, name: f.name };
};
function musicScreen() {
  const sc = browseScreen({ watermark: 'music', section: 'MY MUSIC', title: ['My Music', ''], view: 'tiles', modes: [], loading: 'Looking through your music folders' });
  const roots = S.roots.music || [];
  let tracks = [], albums = [], view = 'albums';
  const load = async () => {
    if (!roots.length) { sc.setSpec({ loading: null, empty: noRootsHtml('Music'), modes: modes() }); return; }
    const files = await scanRoots(roots, ['audio']);
    await src.tags(files, (d, n) => { if (current === sc) { const l = sc.node && sc.node.querySelector('.loading'); if (l) l.textContent = `Reading tags — ${d} of ${n}`; } });
    tracks = files.map(trackOf);
    const am = new Map();
    for (const t of tracks) { const k = (t.albumArtist + '|' + t.album).toLowerCase(); if (!am.has(k)) am.set(k, { title: t.album, artist: t.albumArtist, year: t.year, tracks: [], artRec: null, mtime: 0 }); const a = am.get(k); a.tracks.push(t); if (!a.artRec && t.hasArt) a.artRec = t.rec; a.mtime = Math.max(a.mtime, t.mtime); }
    albums = [...am.values()];
    for (const a of albums) a.tracks.sort((x, y) => (x.disc - y.disc) || ((x.track ?? 1e9) - (y.track ?? 1e9)) || natCmp(x.name, y.name));
    sc.setSpec({ loading: null, modes: modes(), status: `${plural(tracks.length, 'song')} · ${plural(albums.length, 'album')}` });
    show();
  };
  const modes = () => [
    { label: 'Albums', dot: view === 'albums', run: () => { view = 'albums'; sc.setSpec({ modes: modes() }); show(); } },
    { label: 'Artists', dot: view === 'artists', run: () => { view = 'artists'; sc.setSpec({ modes: modes() }); show(); } },
    { label: 'Songs', dot: view === 'songs', run: () => { view = 'songs'; sc.setSpec({ modes: modes() }); show(); } },
    { label: 'Genres', dot: view === 'genres', run: () => { view = 'genres'; sc.setSpec({ modes: modes() }); show(); } },
    { label: 'Shuffle all', run: () => { if (tracks.length) { music.playQueue(tracks, 0, true); go(nowPlayingScreen()); } } },
  ];
  const show = () => {
    if (!roots.length) return;
    const empty = 'Unable to view your music. Either the folders contain no audio files, or they could not be read.';
    if (view === 'albums') sc.setSpec({ view: 'tiles', items: albums.slice().sort((a, b) => natCmp(a.title, b.title)).map(albumTile), empty });
    else if (view === 'artists') {
      const m = new Map(); for (const a of albums) { const k = a.artist.toLowerCase(); if (!m.has(k)) m.set(k, { name: a.artist, albums: [] }); m.get(k).albums.push(a); }
      sc.setSpec({ view: 'tiles', items: [...m.values()].sort((a, b) => natCmp(a.name, b.name)).map((ar) => { const withArt = ar.albums.find((a) => a.artRec); return { label: ar.name, kind: 'album', thumb: withArt ? () => src.cover(withArt.artRec) : null, title: [ar.name, plural(ar.albums.length, 'album')], run: () => go(artistScreen(ar)) }; }), empty });
    } else if (view === 'songs') { const list = tracks.slice().sort((a, b) => natCmp(a.title, b.title)); sc.setSpec({ view: 'rows', items: list.map((t) => songRow(t, list)), empty }); }
    else if (view === 'genres') {
      const m = new Map(); for (const t of tracks) { const k = t.genre.toLowerCase(); if (!m.has(k)) m.set(k, { name: t.genre, tracks: [] }); m.get(k).tracks.push(t); }
      sc.setSpec({ view: 'rows', items: [...m.values()].sort((a, b) => natCmp(a.name, b.name)).map((g) => ({ label: g.name, kind: 'audio', meta: `${g.tracks.length}`, title: [g.name, plural(g.tracks.length, 'song')], run: () => go(songListScreen(g.name, g.tracks)) })), empty });
    }
  };
  sc.render(); load();
  document.addEventListener('music:track', () => { if (current === sc && view === 'songs') sc.paint(); });
  return sc;
}
const albumTile = (a) => ({ label: a.title, kind: 'album', thumb: a.artRec ? () => src.cover(a.artRec) : null, title: [a.title, `${a.artist}${a.year ? ' · ' + a.year : ''} · ${plural(a.tracks.length, 'song')}`], run: () => go(albumScreen(a)) });
const songRow = (t, list) => ({ label: t.title, sub: t.artist, kind: 'audio', meta: t.duration ? fmtTime(t.duration) : '', title: [t.title, `${t.artist} · ${t.album}`], playing: music.current() && music.current().path === t.path, run: () => { music.playQueue(list, list.indexOf(t)); go(nowPlayingScreen()); } });
function albumScreen(a) {
  const sc = browseScreen({ watermark: 'music', section: a.artist, title: [a.title, a.artist], view: 'rows', modes: [
    { label: 'Play album', run: () => { music.playQueue(a.tracks, 0); go(nowPlayingScreen()); } },
    { label: 'Shuffle album', run: () => { music.playQueue(a.tracks, 0, true); go(nowPlayingScreen()); } },
    { label: 'Add to queue', run: () => { if (!music.state.queue.length) { music.playQueue(a.tracks, 0); go(nowPlayingScreen()); } else { music.state.queue.push(...a.tracks); music.setShuffle(music.state.shuffle); toast(`Queued ${plural(a.tracks.length, 'song')}`); } } },
  ], items: a.tracks.map((t, i) => Object.assign(songRow(t, a.tracks), { num: t.track ?? i + 1, sub: null })) });
  if (a.artRec) src.cover(a.artRec).then((u) => { if (u && sc.node) { sc.node.style.setProperty('--hero', `url("${u}")`); } });
  document.addEventListener('music:track', () => { if (current === sc) { sc.spec.items.forEach((it, i) => { it.playing = music.current() && music.current().path === a.tracks[i].path; }); sc.renderedPage = -1; sc.paint(); } });
  return sc;
}
function artistScreen(ar) {
  return browseScreen({ watermark: 'music', section: 'ARTISTS', title: [ar.name, plural(ar.albums.length, 'album')], view: 'tiles', modes: [
    { label: 'Play all', run: () => { music.playQueue(ar.albums.flatMap((a) => a.tracks), 0); go(nowPlayingScreen()); } },
    { label: 'Shuffle all', run: () => { music.playQueue(ar.albums.flatMap((a) => a.tracks), 0, true); go(nowPlayingScreen()); } },
  ], items: ar.albums.slice().sort((a, b) => (a.year || '9999').localeCompare(b.year || '9999') || natCmp(a.title, b.title)).map(albumTile) });
}
function songListScreen(name, list) {
  list = list.slice().sort((a, b) => natCmp(a.title, b.title));
  return browseScreen({ watermark: 'music', section: 'GENRES', title: [name, plural(list.length, 'song')], view: 'rows', modes: [
    { label: 'Play all', run: () => { music.playQueue(list, 0); go(nowPlayingScreen()); } },
    { label: 'Shuffle', run: () => { music.playQueue(list, 0, true); go(nowPlayingScreen()); } },
  ], items: list.map((t) => songRow(t, list)) });
}
function nowPlayingScreen() {
  const sc = { modeIdx: 0, raf: 0, isNowPlaying: true };
  const modes = () => [
    { label: music.audio.paused ? 'Play' : 'Pause', run: () => { music.toggle(); sc.render(); } },
    { label: 'View queue', run: () => go(queueScreen()) },
    { label: 'Shuffle', dot: music.state.shuffle, run: () => { music.setShuffle(!music.state.shuffle); sc.render(); } },
    { label: 'Repeat' + (music.state.repeat === 'one' ? ' one' : music.state.repeat === 'all' ? ' all' : ''), dot: music.state.repeat !== 'off', run: () => { music.cycleRepeat(); sc.render(); } },
    { label: 'Visualizer', dot: setting('visualizer'), run: () => { saveSettings({ visualizer: !setting('visualizer') }); sc.render(); } },
    { label: 'Stop', run: () => { music.stop(); back(); } },
  ];
  sc.render = () => {
    const t = music.current();
    const n = mount(el('div')); n.classList.add('np');
    n.appendChild(el('div', 'wm', 'music')); n.appendChild(el('div', 'section', 'NOW PLAYING'));
    const tb = el('div', 'titleblock'); tb.appendChild(el('div', 'big', t ? t.title : 'Nothing playing')); tb.appendChild(el('div', 'small', t ? `${t.artist} · ${t.album}` : '')); n.appendChild(tb);
    const ms = el('div', 'modes');
    modes().forEach((m, i) => { const r = el('div', 'slab mode'); r.appendChild(el('span', 'lbl', m.label)); if (m.dot !== undefined) { const d = el('span', 'dot'); if (m.dot) d.classList.add('on'); r.appendChild(d); } r.onmouseenter = () => { sc.modeIdx = i; sc.paint(); }; r.onclick = () => { sc.modeIdx = i; m.run(); }; ms.appendChild(r); });
    n.appendChild(ms);
    const art = el('div', 'np-art');
    const putGlyph = () => { const g = el('div', 'glyph'); g.innerHTML = G.disc; art.appendChild(g); };
    if (t && t.art) { const im = el('img'); im.src = t.art; im.onerror = () => { im.remove(); putGlyph(); }; art.appendChild(im); n.style.setProperty('--hero', `url("${t.art}")`); } else putGlyph();
    n.appendChild(art);
    const tr = el('div', 'np-track'); tr.appendChild(el('div', 't', t ? t.title : '')); tr.appendChild(el('div', 'a', t ? `${t.artist}${t.year ? ' · ' + t.year : ''}` : '')); n.appendChild(tr);
    const cv = el('canvas', 'np-spec'); cv.width = 560; cv.height = 76; n.appendChild(cv); sc.canvas = cv;
    const bar = el('div', 'np-bar'); bar.appendChild(el('i')); n.appendChild(bar); sc.bar = bar.firstChild;
    bar.onclick = (e) => { const r = bar.getBoundingClientRect(); if (music.audio.duration) music.audio.currentTime = music.audio.duration * (e.clientX - r.left) / r.width; };
    const tm = el('div', 'np-time'); tm.innerHTML = '<b>TRACK TIME</b><span>0:00</span>'; n.appendChild(tm); sc.time = tm.lastChild;
    sc.node = n; sc.paint(); cancelAnimationFrame(sc.raf); sc.draw();
  };
  sc.paint = () => [...sc.node.querySelectorAll('.mode')].forEach((r, i) => r.classList.toggle('focus', i === sc.modeIdx));
  sc.draw = () => {
    if (!sc.node || !sc.node.isConnected) return;
    const a = music.audio;
    sc.time.textContent = fmtTime(a.currentTime) + (a.duration ? ' / ' + fmtTime(a.duration) : '');
    sc.bar.style.width = a.duration ? (a.currentTime / a.duration * 100) + '%' : '0';
    const g = sc.canvas.getContext('2d'); g.clearRect(0, 0, 560, 76);
    if (setting('visualizer')) {
      const bars = 40, sp = music.spectrum(bars); const w = 560 / bars;
      const accent = getComputedStyle(document.body).getPropertyValue('--green').trim() || '#B6EE6C';
      for (let i = 0; i < bars; i++) { const h = sp ? sp[i] * 72 : 2; g.fillStyle = `rgba(255,255,255,${0.35 + (sp ? sp[i] : 0) * 0.55})`; g.fillRect(i * w + 2, 76 - h, w - 4, h); g.fillStyle = accent; g.fillRect(i * w + 2, 76 - h - 2, w - 4, 2); }
    }
    sc.raf = requestAnimationFrame(sc.draw);
  };
  sc.key = (name) => {
    const ms = modes();
    if (name === 'up') sc.modeIdx = Math.max(0, sc.modeIdx - 1);
    else if (name === 'down') sc.modeIdx = Math.min(ms.length - 1, sc.modeIdx + 1);
    else if (name === 'enter') { ms[sc.modeIdx].run(); return true; }
    else if (name === 'space') { music.toggle(); sc.render(); return true; }
    else if (name === 'right' || name === 'n') { music.next(); return true; }
    else if (name === 'left' || name === 'p') { music.prev(); return true; }
    else if (name === 'back') { back(); return true; }
    else return false;
    sc.paint(); return true;
  };
  sc.leave = () => cancelAnimationFrame(sc.raf);
  document.addEventListener('music:track', () => { if (current === sc) sc.render(); });
  return sc;
}
function queueScreen() {
  const q = music.state.queue;
  return browseScreen({ watermark: 'music', section: 'NOW PLAYING', title: ['Queue', plural(q.length, 'song')], view: 'rows', modes: [{ label: 'Clear queue', run: () => { music.stop(); back(); } }],
    items: q.map((t, i) => Object.assign(songRow(t, q), { num: i + 1, run: () => { music.playQueue(q, i, false); back(); } })) });
}

// =============================================================================== My Pictures
function picturesScreen() {
  const sc = browseScreen({ watermark: 'pictures', section: 'MY PICTURES', title: ['My Pictures', ''], view: 'tiles', modes: [], loading: 'Looking through your picture folders' });
  const roots = S.roots.pictures || [];
  let folders = [], sort = 'name';
  const load = async () => {
    if (!roots.length) { sc.setSpec({ loading: null, empty: noRootsHtml('Pictures'), modes: modes() }); return; }
    const files = await scanRoots(roots, ['image']);
    const m = new Map(); for (const f of files) { if (!m.has(f.dir)) m.set(f.dir, { name: baseName(f.dir === f.root ? src.rootLabel(f.dir) : f.dir), dir: f.dir, files: [], mtime: 0 }); const d = m.get(f.dir); d.files.push(f); d.mtime = Math.max(d.mtime, f.mtime); }
    folders = [...m.values()];
    sc.setSpec({ loading: null, modes: modes(), status: `${plural(files.length, 'picture')} in ${plural(folders.length, 'folder')}` });
    show();
  };
  const modes = () => [
    { label: 'Play slide show', run: () => { const all = folders.flatMap((f) => f.files); if (all.length) photoViewer.open(all, 0, true); } },
    { label: 'Sort by name', dot: sort === 'name', run: () => { sort = 'name'; sc.setSpec({ modes: modes() }); show(); } },
    { label: 'Sort by date', dot: sort === 'date', run: () => { sort = 'date'; sc.setSpec({ modes: modes() }); show(); } },
  ];
  const show = () => {
    if (!roots.length) return;
    const list = folders.slice().sort((a, b) => sort === 'date' ? b.mtime - a.mtime : natCmp(a.name, b.name));
    sc.setSpec({ view: 'tiles', items: list.map((d) => ({ label: d.name, kind: 'image', mosaic: d.files.slice(0, 4).map((f) => src.url(f)), title: [d.name, `${plural(d.files.length, 'picture')} · ${fmtDate(d.mtime)}`], run: () => go(photoFolderScreen(d)) })), empty: 'No pictures found in your folders.' });
  };
  sc.render(); load();
  return sc;
}
function photoFolderScreen(d) {
  let sort = 'name';
  const sc = browseScreen({ watermark: 'pictures', section: d.name, title: [d.name, plural(d.files.length, 'picture')], view: 'tiles', modes: [] });
  const sorted = () => d.files.slice().sort((a, b) => sort === 'date' ? a.mtime - b.mtime : natCmp(a.name, b.name));
  const modes = () => [
    { label: 'Play slide show', run: () => photoViewer.open(sorted(), sc.col === 'items' ? sc.idx : 0, true) },
    { label: 'Sort by name', dot: sort === 'name', run: () => { sort = 'name'; show(); } },
    { label: 'Sort by date', dot: sort === 'date', run: () => { sort = 'date'; show(); } },
  ];
  const show = () => { const list = sorted(); sc.setSpec({ modes: modes(), items: list.map((f, i) => ({ label: stripExt(f.name), kind: 'image', thumb: src.url(f), title: [stripExt(f.name), fmtDate(f.mtime)], run: () => photoViewer.open(list, i, false) })) }); };
  show();
  return sc;
}
const photoViewer = (() => {
  const root = $('#photo'), layers = [$('#photo-a'), $('#photo-b')];
  const st = { list: [], idx: 0, slideshow: false, timer: null, layer: 0, open: false };
  function show(i) {
    st.idx = (i + st.list.length) % st.list.length; const f = st.list[st.idx];
    st.layer ^= 1; const L = layers[st.layer], O = layers[st.layer ^ 1];
    L.className = 'photo-layer'; L.style.backgroundImage = `url("${src.url(f)}")`;
    if (setting('kenBurns') && st.slideshow) { L.style.setProperty('--kb-dur', (setting('slideshowSeconds') + 1.5) + 's'); L.style.setProperty('--kb-x', (Math.random() * 4 - 2).toFixed(1) + '%'); L.style.setProperty('--kb-y', (Math.random() * 4 - 2).toFixed(1) + '%'); void L.offsetWidth; L.classList.add('kb'); }
    L.classList.add('show'); O.classList.remove('show');
    $('#photo-name').textContent = stripExt(f.name); $('#photo-meta').textContent = `${st.idx + 1} of ${st.list.length} · ${fmtDate(f.mtime)}`;
    const nx = st.list[(st.idx + 1) % st.list.length]; if (nx) { const im = new Image(); im.src = src.url(nx); }
    arm();
  }
  function arm() { clearTimeout(st.timer); if (st.slideshow) st.timer = setTimeout(() => show(st.idx + 1), setting('slideshowSeconds') * 1000); }
  root.addEventListener('click', (e) => { const w = innerWidth; if (e.clientX < w * 0.3) api.key('left'); else if (e.clientX > w * 0.7) api.key('right'); else api.key('enter'); });
  const api = {
    isOpen: () => st.open,
    open(list, idx, slideshow) { st.list = list; st.slideshow = !!slideshow; st.open = true; root.hidden = false; root.classList.remove('hide-cap'); show(idx); chromeUpdate(); if (slideshow) toast('Slide show — Enter to pause, Backspace to stop', 2200); },
    close() { clearTimeout(st.timer); st.open = false; root.hidden = true; layers.forEach((l) => { l.className = 'photo-layer'; l.style.backgroundImage = ''; }); chromeUpdate(); },
    key(name) {
      if (name === 'back') { api.close(); return true; }
      if (name === 'right' || name === 'down' || name === 'pgdn') { show(st.idx + 1); return true; }
      if (name === 'left' || name === 'up' || name === 'pgup') { show(st.idx - 1); return true; }
      if (name === 'enter' || name === 'space' || name === 'playpause') { st.slideshow = !st.slideshow; toast(st.slideshow ? 'Slide show' : 'Paused', 800); arm(); return true; }
      if (name === 'c') { root.classList.toggle('hide-cap'); return true; }
      if (name === 'f') { toggleFullscreen(); return true; }
      return false;
    },
  };
  return api;
})();

// =============================================================================== My Computer
function computerScreen() {
  const sc = browseScreen({ watermark: 'computer', section: 'MY COMPUTER', title: ['My Computer', ''], view: 'tiles', modes: [], loading: src.local ? 'Looking at the folders you opened' : 'Looking for drives' });
  const modes = () => src.local
    ? [{ label: 'Open a folder…', run: pick }, { label: 'Refresh', run: load }]
    : [{ label: 'Refresh', run: load }];
  const pick = async () => {
    try { const r = await src.pickFolder(); if (r) { scanCache.clear(); toast(`Opened ${r.name}`); await load(); } }
    catch (e) { dialog({ title: 'Folder access', text: e.message, buttons: ['OK'] }); }
  };
  const load = async () => {
    const r = await src.computer();
    const items = r.items.map((it) => Object.assign({}, it, {
      badge: it.missing ? '?' : it.badge, run: async () => {
        if (it.action === 'pick') return pick();
        if (it.missing) { const ok = await src.reconnectMissing(it.label); if (ok) { scanCache.clear(); go(folderScreen(it.path)); } else toast('Not reconnected', 1200); return; }
        go(folderScreen(it.path));
      },
    }));
    sc.setSpec({ loading: null, modes: modes(), items, status: r.status, empty: src.local ? 'Nothing opened yet. Choose <b>Open a folder…</b> on the left, or drop a folder onto this page.' : 'No drives found.' });
  };
  sc.render(); load();
  return sc;
}
function folderScreen(dir) {
  let sort = 'name', data = null;
  const sc = browseScreen({ watermark: 'computer', section: baseName(src.displayPath(dir)).toUpperCase(), title: [baseName(src.displayPath(dir)), src.displayPath(dir)], view: 'rows', modes: [], loading: 'Reading folder' });
  const roots = S.roots;
  const isRoot = (kind) => roots[kind].some((r) => r.toLowerCase() === dir.toLowerCase());
  const addRoot = (kind, label) => async () => {
    if (isRoot(kind)) { if (await confirm_(`REMOVE ${label.toUpperCase()} FOLDER`, `Stop showing "${src.displayPath(dir)}" in My ${label}? Nothing on disk is touched.`)) { roots[kind] = roots[kind].filter((r) => r.toLowerCase() !== dir.toLowerCase()); await saveRoots(); scanCache.clear(); toast(`Removed from My ${label}`); sc.setSpec({ modes: modes() }); } return; }
    if (await confirm_(`USE AS ${label.toUpperCase()} FOLDER`, `Add "${src.displayPath(dir)}" to your ${label} library? Everything inside it, including subfolders, will show up in My ${label}.`)) { roots[kind].push(dir); await saveRoots(); scanCache.clear(); toast(`Added to My ${label}`); sc.setSpec({ modes: modes() }); }
  };
  const modes = () => {
    const ents = data ? data.entries : [];
    const vids = ents.filter((e) => e.kind === 'video'), auds = ents.filter((e) => e.kind === 'audio'), imgs = ents.filter((e) => e.kind === 'image');
    const m = [];
    if (data && data.parent) m.push({ label: 'Up one level', run: () => back() });
    m.push({ label: 'Sort by name', dot: sort === 'name', run: () => { sort = 'name'; show(); } });
    m.push({ label: 'Sort by date', dot: sort === 'date', run: () => { sort = 'date'; show(); } });
    if (vids.length) m.push({ label: `Play all videos (${vids.length})`, run: () => player.open(vids.map(fileVideoItem), 0) });
    if (auds.length) m.push({ label: `Play all music (${auds.length})`, run: () => playFolderAudio(auds, 0) });
    if (imgs.length) m.push({ label: `Slide show (${imgs.length})`, run: () => photoViewer.open(imgs, 0, true) });
    m.push({ label: 'Use as Videos folder', dot: isRoot('videos'), run: addRoot('videos', 'Videos') });
    m.push({ label: 'Use as Music folder', dot: isRoot('music'), run: addRoot('music', 'Music') });
    m.push({ label: 'Use as Pictures folder', dot: isRoot('pictures'), run: addRoot('pictures', 'Pictures') });
    if (src.local && !dir.includes('/')) m.push({ label: 'Forget this folder', run: async () => { if (await confirm_('FORGET FOLDER', `Forget "${src.displayPath(dir)}"? The browser drops its access; nothing on disk is touched.`)) { await src.forgetFolder(dir); scanCache.clear(); back(); } } });
    return m;
  };
  const fileVideoItem = (e) => ({ rec: e, path: e.path, label: cleanTitle(e.name).title, sub: baseName(src.displayPath(dir)) });
  const playFolderAudio = async (auds, i) => { await src.tags(auds); music.playQueue(auds.map(trackOf), i); go(nowPlayingScreen()); };
  const show = () => {
    const ents = data.entries.slice().sort((a, b) => (a.kind === 'dir') === (b.kind === 'dir') ? (sort === 'date' ? (b.mtime || 0) - (a.mtime || 0) : natCmp(a.name, b.name)) : a.kind === 'dir' ? -1 : 1);
    const vids = ents.filter((e) => e.kind === 'video'), auds = ents.filter((e) => e.kind === 'audio'), imgs = ents.filter((e) => e.kind === 'image');
    const items = ents.map((e) => ({
      label: e.name, kind: e.kind, meta: e.kind === 'dir' ? '' : fmtBytes(e.size),
      mark: e.kind === 'video' && S.resume[e.path] ? (S.resume[e.path].done ? 'full' : 'half') : null,
      title: [e.kind === 'dir' ? e.name : stripExt(e.name), e.kind === 'dir' ? src.displayPath(e.path) : `${fmtDate(e.mtime)} · ${fmtBytes(e.size)}`],
      run: () => {
        if (e.kind === 'dir') go(folderScreen(e.path));
        else if (e.kind === 'video') player.open(vids.map(fileVideoItem), vids.indexOf(e));
        else if (e.kind === 'audio') playFolderAudio(auds, auds.indexOf(e));
        else if (e.kind === 'image') photoViewer.open(imgs, imgs.indexOf(e), false);
      },
    }));
    sc.setSpec({ loading: null, modes: modes(), items, empty: 'Nothing playable in this folder. Only folders and media files are shown.' });
  };
  sc.render();
  src.ls(dir).then((d) => { data = d; show(); }).catch((e) => sc.setSpec({ loading: null, modes: [{ label: 'Up one level', run: () => back() }], empty: `Can't open this folder.<small>${e.message}</small>` }));
  return sc;
}

// =============================================================================== Settings
const SUB_LANGS = [['eng', 'English'], ['tur', 'Turkish'], ['jpn', 'Japanese'], ['spa', 'Spanish'], ['ger', 'German'], ['fre', 'French'], ['por', 'Portuguese'], ['ita', 'Italian'], ['rus', 'Russian'], ['ara', 'Arabic'], ['kor', 'Korean'], ['chi', 'Chinese'], ['pol', 'Polish'], ['dut', 'Dutch']];
function settingsScreen() {
  let pane = 'general', kiyora = null, serverThere = null;
  const sc = browseScreen({ watermark: 'settings', section: 'SETTINGS', title: ['Settings', ''], view: 'rows', modes: [] });
  src.kiyora().then((k) => { kiyora = k; if (current === sc) show(); });
  if (src.local) Source.serverAvailable().then((ok) => { serverThere = ok; if (current === sc) show(); });
  const modes = () => [
    { label: 'General', dot: pane === 'general', run: () => { pane = 'general'; show(); } },
    { label: 'Look', dot: pane === 'look', run: () => { pane = 'look'; show(); } },
    { label: 'Library folders', dot: pane === 'library', run: () => { pane = 'library'; show(); } },
    { label: 'About Whistler', dot: pane === 'about', run: () => { pane = 'about'; show(); } },
  ];
  const cyc = (k, vals, after) => async () => { const v = setting(k); const i = vals.indexOf(v); await saveSettings({ [k]: vals[(i + 1) % vals.length] }); if (after) after(); show(); };
  const onoff = (v) => (v ? 'On' : 'Off');
  const show = () => {
    let items = [], extra = null;
    if (pane === 'general') items = [
      { label: 'Clock', value: setting('clock24') ? '24-hour' : '12-hour', kind: 'gear', title: ['Clock', 'How the start screen shows the time'], run: cyc('clock24', [false, true]) },
      { label: 'Slide show interval', value: setting('slideshowSeconds') + ' seconds', kind: 'gear', title: ['Slide show', 'Seconds each picture stays up'], run: cyc('slideshowSeconds', [3, 5, 8, 12, 20]) },
      { label: 'Pan and zoom pictures', value: onoff(setting('kenBurns')), kind: 'gear', title: ['Pan and zoom', 'Ken Burns drift during slide shows'], run: cyc('kenBurns', [true, false]) },
      { label: 'Music visualizer', value: onoff(setting('visualizer')), kind: 'gear', title: ['Visualizer', 'Spectrum bars on the now-playing screen'], run: cyc('visualizer', [true, false]) },
      { label: 'Play next episode automatically', value: onoff(setting('autoplayNext')), kind: 'gear', title: ['Autoplay', 'Continue to the next video when one ends'], run: cyc('autoplayNext', [true, false]) },
      { label: 'Subtitles', value: setting('subtitles') === 'off' ? 'Off' : 'Automatic', kind: 'gear', title: ['Subtitles', 'Pick a track automatically when a video starts, or start with them off'], run: cyc('subtitles', ['auto', 'off']) },
      { label: 'Preferred subtitle language', value: (SUB_LANGS.find((l) => l[0] === setting('subtitleLang')) || SUB_LANGS[0])[1], kind: 'gear', title: ['Subtitle language', 'Embedded track to prefer; the player menu can override per video'], run: cyc('subtitleLang', SUB_LANGS.map((l) => l[0])) },
      { label: 'Subtitle size', value: setting('subtitleSize') === 'large' ? 'Large' : 'Normal', kind: 'gear', title: ['Subtitle size', 'Cue text size in the video player'], run: cyc('subtitleSize', ['normal', 'large']) },
      { label: 'The roast', value: onoff(setting('roast')), kind: 'gear', title: ['The roast', 'Declines reaction videos on principle, like Neptune does'], run: cyc('roast', [true, false]) },
      { label: 'Sounds', value: sfx.available() ? onoff(setting('sounds')) : (setting('sounds') ? 'On (no files)' : 'Off'), kind: 'gear', title: ['Sounds', 'Navigation tick and select note. Put focus.wav, select.wav, error.wav, intro.wav in public/sounds/'], run: cyc('sounds', [true, false]) },
      { label: 'Forget resume points', value: `${Object.keys(S.resume).length}`, kind: 'gear', title: ['Resume points', 'Where each video was stopped'], run: async () => { if (await confirm_('FORGET RESUME POINTS', 'Forget where every video was stopped, and which ones were watched?')) { for (const k of Object.keys(S.resume)) await clearResumeRec(k); show(); } } },
    ];
    else if (pane === 'look') {
      items = Object.entries(THEMES).map(([id, t]) => ({ label: t.name, kind: 'gear', value: setting('theme') === id ? '●' : '', title: [t.name, id === '2002' ? 'Windows XP Media Center Edition 2002, the original' : id === 'whistler' ? 'Luna as it stood in Whistler Beta 2, build 2462' : 'Rows of cards, black and red'], run: async () => { await saveSettings({ theme: id }); applyTheme(); show(); toast('Theme: ' + t.name, 1200); } }));
      items.push({ label: 'Full screen', value: document.fullscreenElement ? 'On' : 'Off', kind: 'gear', title: ['Full screen', 'F toggles this anywhere'], run: () => { toggleFullscreen(); setTimeout(show, 300); } });
      if (src.local && serverThere) items.push({ label: 'Source', value: 'Browser folders', kind: 'drive', title: ['Source', 'A server.js is running here too; switch to read the whole PC through it'], run: () => { localStorage.removeItem('whistler.mode'); location.reload(); } });
      if (!src.local) items.push({ label: 'Source', value: 'This PC (server)', kind: 'drive', title: ['Source', 'Switch to folders you open in the browser; nothing installed'], run: () => { localStorage.setItem('whistler.mode', 'local'); location.reload(); } });
    } else if (pane === 'library') {
      const rows = [];
      for (const [kind, label] of [['videos', 'VIDEOS'], ['music', 'MUSIC'], ['pictures', 'PICTURES']]) for (const r of S.roots[kind]) rows.push({ label: src.displayPath(r), sub: label, kind: kind === 'videos' ? 'video' : kind === 'music' ? 'audio' : 'image', title: [baseName(src.displayPath(r)), `${label} · ${src.displayPath(r)}`],
        run: async () => { if (await confirm_('REMOVE FOLDER', `Stop showing "${src.displayPath(r)}" in My ${label[0] + label.slice(1).toLowerCase()}? Nothing on disk is touched.`)) { S.roots[kind] = S.roots[kind].filter((x) => x !== r); await saveRoots(); scanCache.clear(); show(); } } });
      rows.push({ label: src.local ? 'Open a folder…' : 'Add a folder…', kind: 'plus', title: ['Add a folder', src.local ? 'Pick a folder; then choose "Use as … folder" from its left column' : 'Opens My Computer; pick a folder and choose "Use as … folder"'], run: async () => { if (src.local) { try { const r = await src.pickFolder(); if (r) go(folderScreen(r.path)); } catch (e) { dialog({ title: 'Folder access', text: e.message, buttons: ['OK'] }); } } else go(computerScreen()); } });
      if (kiyora) rows.push({ label: 'Import folders from Kiyora', kind: 'up', title: ['Kiyora', 'Use the same library folders as the PC app'], run: async () => {
        const n = kiyora.videos.length + kiyora.music.length + kiyora.pictures.length;
        if (await confirm_('IMPORT FROM KIYORA', `Add Kiyora's ${n} library folders?`)) { for (const k of ['videos', 'music', 'pictures']) S.roots[k] = [...new Set(S.roots[k].concat(kiyora[k]))]; await saveRoots(); scanCache.clear(); toast('Imported'); show(); } } });
      items = rows;
    } else {
      extra = () => { const a = el('div', 'about'); a.innerHTML = `<h3>Whistler Media Center</h3>
<p>The web member of a small family: <b>Neptune Media Center</b> on the PSP, <b>Kiyora</b> on Windows, and this one in a browser tab. Neptune and Odyssey were Microsoft's codenames for the consumer and business Windows that never shipped; they were merged into <b>Whistler</b>, which became XP. XP's Media Center Edition is the look you're in, unless you switched themes.</p>
<p>${src.local ? (src.persistent ? 'It reads your folders <b>through the browser</b>. Nothing is installed and nothing runs in the background; you opened the folders once and the browser remembers.' : 'It reads your folders <b>through the browser</b>. Nothing is installed. This browser cannot remember folder access between sessions, so you pick the folder again (or drop it onto the page) each time; your library and resume points are kept.') : 'It is reading this PC through the optional <b>server.js</b>. The page also works with no server at all.'} Plain HTML, CSS and JavaScript.</p>
<p><b>Browsers:</b> Chrome and Edge remember the folders you open. Firefox and Safari open folders per session, or take a dropped folder. Playback is whatever the browser decodes.</p>
<p><b>Keys:</b> arrows move, Enter opens, Backspace goes back, Home returns to start, F is full screen, T cycles themes. Gamepads work: A opens, B goes back, Y opens the player options.</p>`; return a; };
    }
    sc.setSpec({ modes: modes(), items, extra, empty: pane === 'about' ? null : 'Nothing here.' });
  };
  show();
  return sc;
}

// =============================================================================== video player
const player = (() => {
  const root = $('#player'), v = $('#video'), menuEl = $('#pmenu');
  const st = { open: false, queue: [], idx: -1, hideT: null, scan: 0, scanDir: 0, holdKey: null, holdAt: 0, scanIv: null, lastSave: 0, subsUrl: null, ended: false, info: null, subSel: 'off', lastSub: null, speed: 1, zoom: 'fit', menu: null };
  const cur = () => st.queue[st.idx];
  const ROAST = /\b(reaction|reacts?|unboxing|gone wrong|top ?\d+|prank|mukbang)\b/i;
  const LANG = { eng: 'English', en: 'English', jpn: 'Japanese', ja: 'Japanese', tur: 'Turkish', tr: 'Turkish', spa: 'Spanish', es: 'Spanish', ger: 'German', deu: 'German', de: 'German', fre: 'French', fra: 'French', fr: 'French',
    por: 'Portuguese', pt: 'Portuguese', ita: 'Italian', it: 'Italian', rus: 'Russian', ru: 'Russian', ara: 'Arabic', ar: 'Arabic', kor: 'Korean', ko: 'Korean', chi: 'Chinese', zho: 'Chinese', zh: 'Chinese', pol: 'Polish', pl: 'Polish', dut: 'Dutch', nld: 'Dutch', nl: 'Dutch', und: 'Unknown' };
  const langName = (c) => LANG[(c || 'und').toLowerCase().split('-')[0]] || c;
  const langOf = (s) => { const l = langName(s.langIETF || s.lang); if (l !== 'Unknown') return l; const hit = Object.values(LANG).find((n) => n !== 'Unknown' && new RegExp('\\b' + n, 'i').test(s.name || '')); return hit || 'Unknown'; };
  const subLabel = (s) => { const l = langOf(s); const name = (s.name || '').trim(); const label = l === 'Unknown' && name ? name : name && !new RegExp('^' + l + '$', 'i').test(name) ? `${l} – ${name}` : l; return label + (s.forced ? ' (forced)' : ''); };
  const subsName = () => { if (st.subSel === 'off') return 'Off'; if (st.subSel === 'file') return 'Subtitle file'; if (st.subSel === 'loaded') return st.loadedSub ? st.loadedSub.name : 'Off'; const s = st.info && st.info.subs.find((x) => x.n === st.subSel); return s ? subLabel(s) : 'Off'; };

  function showOsd() { root.classList.remove('hide-osd'); clearTimeout(st.hideT); st.hideT = setTimeout(() => { if (!v.paused && !st.scan && !st.menu) root.classList.add('hide-osd'); }, 3000); }
  root.addEventListener('mousemove', showOsd);
  root.addEventListener('click', (e) => { if (e.target === v) { toggle(); showOsd(); } });
  root.addEventListener('dblclick', (e) => { if (e.target === v) toggleFullscreen(); });
  root.addEventListener('wheel', (e) => { v.volume = clamp(v.volume + (e.deltaY < 0 ? 0.05 : -0.05), 0, 1); toast('Volume ' + Math.round(v.volume * 100) + '%', 900); }, { passive: true });
  $('.osd-bar').addEventListener('click', (e) => { const r = e.currentTarget.getBoundingClientRect(); if (v.duration) v.currentTime = v.duration * (e.clientX - r.left) / r.width; showOsd(); });
  $('#osd-cc').onclick = (e) => { e.stopPropagation(); subsMenu(); };
  $('#osd-opt').onclick = (e) => { e.stopPropagation(); if (st.menu) closeMenu(); else openMain(); };

  function paint() {
    if (!st.open) return;
    const d = v.duration || 0, t = v.currentTime || 0;
    $('#osd-pos').textContent = fmtTime(t); $('#osd-dur').textContent = fmtTime(d);
    const pct = d ? (t / d * 100) : 0; $('#osd-fill').style.width = pct + '%'; $('#osd-knob').style.left = pct + '%';
    let buf = 0; try { for (let i = 0; i < v.buffered.length; i++) if (v.buffered.start(i) <= t && v.buffered.end(i) >= t) buf = v.buffered.end(i); } catch { /* */ }
    $('#osd-buf').style.width = (d ? buf / d * 100 : 0) + '%';
    $('#osd-scan').textContent = st.scan ? (st.scanDir > 0 ? '▶▶ ' : '◀◀ ') + st.scan + '×' : v.paused ? '‖ PAUSED' : '';
  }
  v.addEventListener('timeupdate', () => { paint(); if (cur() && v.duration && !st.scan && Date.now() - st.lastSave > 5000) saveResume(); });
  v.addEventListener('play', paint); v.addEventListener('pause', paint);
  v.addEventListener('ended', async () => { st.ended = true; await saveResume(); if (setting('autoplayNext') && st.idx < st.queue.length - 1) load(st.idx + 1); else close(); });
  v.addEventListener('error', async () => {
    if (!st.open) return; const c = cur();
    const codec = c && c.rec.tags && c.rec.tags.codec ? ` (${c.rec.tags.codec})` : '';
    await dialog({ title: "Can't play this file", text: `${c ? c.label : ''}${codec}\nThe browser has no decoder for it. H.264 and AV1 play everywhere; HEVC needs the HEVC Video Extension on Windows; 10-bit or older codecs may not play.`, buttons: ['OK'] });
    if (st.idx < st.queue.length - 1 && setting('autoplayNext')) load(st.idx + 1); else close();
  });
  async function saveResume() {
    const c = cur(); if (!c || !v.duration) return;
    st.lastSave = Date.now(); const t = v.currentTime; const done = st.ended || t > v.duration - 60;
    if (t < 20 && !done) return;
    await saveResumeRec(c.path, done ? { t: 0, done: true } : { t, done: false });
  }
  function clearTracks(dropLoaded = true) {
    [...v.querySelectorAll('track')].forEach((t) => t.remove());
    if (st.subsUrl && st.subsUrl.startsWith('blob:')) URL.revokeObjectURL(st.subsUrl); st.subsUrl = null;
    if (dropLoaded && st.loadedSub && st.loadedSub.forPath !== (cur() && cur().path)) { URL.revokeObjectURL(st.loadedSub.url); st.loadedSub = null; }
  }
  function applySubSize() { v.classList.toggle('big-cues', setting('subtitleSize') === 'large'); }
  function pickSub(info) {
    if (setting('subtitles') === 'off') return 'off';
    const want = langName(setting('subtitleLang') || 'eng');
    const subs = info.subs.filter((s) => !s.forced);
    const best = (arr) => arr.find((s) => /full|dialog/i.test(s.name)) || arr.find((s) => s.default && !/sign|song/i.test(s.name)) || arr.find((s) => !/sign|song/i.test(s.name)) || arr[0];
    const mine = best(subs.filter((s) => langOf(s) === want)); if (mine) return mine.n;
    if (info.sidecar) return 'file';
    const any = best(subs); return any ? any.n : 'off';
  }
  async function applySub(sel, announce) {
    st.subSel = sel; if (sel !== 'off') st.lastSub = sel;
    clearTracks(); const c = cur();
    if (sel === 'off') { if (announce) toast('Subtitles off', 900); return; }
    if (announce && src.local && sel !== 'file') toast('Reading subtitles from the file…', 2500);
    let url = null;
    try { url = await src.subsUrl(c.rec, sel); } catch { url = null; }
    if (cur() !== c || st.subSel !== sel) { if (url && url.startsWith('blob:')) URL.revokeObjectURL(url); return; }
    if (!url) { st.subSel = 'off'; if (announce) toast('No usable subtitles in that track', 1400); return; }
    st.subsUrl = url;
    const tr = el('track'); tr.kind = 'subtitles'; tr.label = subsName(); tr.srclang = 'en'; tr.src = url; tr.default = true; v.appendChild(tr);
    setTimeout(() => { if (v.textTracks[0]) v.textTracks[0].mode = 'showing'; }, 50);
    if (announce) toast('Subtitles: ' + subsName(), 1400);
  }
  const chapters = () => (st.info && st.info.chapters) || [];
  function currentChapter() { const ch = chapters(); let i = -1; for (let k = 0; k < ch.length; k++) if (v.currentTime >= ch[k].start) i = k; return i; }
  function chapterJump(dir) {
    const ch = chapters();
    if (!ch.length) { v.currentTime = clamp(v.currentTime + dir * 90, 0, v.duration || 0); toast(dir > 0 ? 'Skip +90 s' : 'Skip −90 s', 800); showOsd(); return; }
    let i = currentChapter();
    if (dir < 0) { if (!(i >= 0 && v.currentTime - ch[i].start > 3)) i--; } else i++;
    if (i < 0) { v.currentTime = 0; showOsd(); return; }
    if (i >= ch.length) return;
    v.currentTime = ch[i].start + 0.01; toast(ch[i].name || `Chapter ${i + 1}`, 1200); showOsd();
  }
  function closeMenu() { st.menu = null; menuEl.hidden = true; menuEl.innerHTML = ''; }
  function openMenu(kind, title, items, idx) { st.menu = { kind, title, items, idx: Math.max(0, idx || 0) }; renderMenu(); showOsd(); }
  function renderMenu() {
    const m = st.menu; if (!m) return; menuEl.innerHTML = ''; menuEl.hidden = false;
    menuEl.appendChild(el('div', 'pm-title', m.title));
    m.items.forEach((it, i) => {
      const r = el('div', 'slab pm-row'); r.appendChild(el('span', 'lbl', it.label));
      if (it.value != null) r.appendChild(el('span', 'val', it.value));
      if (it.dot !== undefined) { const d = el('span', 'dot'); if (it.dot) d.classList.add('on'); r.appendChild(d); }
      if (i === m.idx) r.classList.add('focus');
      r.onmouseenter = () => { m.idx = i; renderMenu(); }; r.onclick = (e) => { e.stopPropagation(); m.idx = i; activateMenu(); };
      menuEl.appendChild(r);
    });
  }
  function activateMenu() { const it = st.menu && st.menu.items[st.menu.idx]; if (it && it.run) it.run(); }
  function refreshMain() { if (!st.menu || st.menu.kind !== 'main') return; const idx = st.menu.idx; st.menu.items = mainItems(); st.menu.idx = Math.min(idx, st.menu.items.length - 1); renderMenu(); }
  function openMain(idx) { openMenu('main', 'Options', mainItems(), idx); }
  function mainItems() {
    const info = st.info || { subs: [], audio: [], chapters: [], sidecar: false };
    const items = [{ label: v.paused ? 'Play' : 'Pause', run: () => { toggle(); closeMenu(); } }, { label: 'Subtitles', value: subsName(), run: subsMenu }];
    if (info.audio.length > 1) items.push({ label: 'Audio', value: info.audio.map((a) => langName(a.lang)).join(' / '), run: () => toast("A browser can't switch audio tracks. It plays the file's default; remux with the track you want first.", 4000) });
    if (info.chapters.length) items.push({ label: 'Chapters', value: String(info.chapters.length), run: chaptersMenu });
    items.push(
      { label: 'Speed', value: st.speed + '×', run: () => { const sp = [0.75, 1, 1.25, 1.5, 2]; st.speed = sp[(sp.indexOf(st.speed) + 1) % sp.length]; if (!st.scan) v.playbackRate = st.speed; refreshMain(); } },
      { label: 'Picture', value: st.zoom === 'fit' ? 'Fit to screen' : 'Fill screen', run: () => { st.zoom = st.zoom === 'fit' ? 'fill' : 'fit'; v.classList.toggle('fill', st.zoom === 'fill'); refreshMain(); } },
      { label: 'Subtitle size', value: setting('subtitleSize') === 'large' ? 'Large' : 'Normal', run: async () => { await saveSettings({ subtitleSize: setting('subtitleSize') === 'large' ? 'normal' : 'large' }); applySubSize(); refreshMain(); } },
      { label: 'Full screen', dot: !!document.fullscreenElement, run: () => { toggleFullscreen(); setTimeout(refreshMain, 300); } },
      { label: 'Restart from beginning', run: () => { v.currentTime = 0; closeMenu(); } },
    );
    if (st.idx < st.queue.length - 1) items.push({ label: 'Next episode', run: () => { closeMenu(); saveResume(); load(st.idx + 1); } });
    items.push({ label: 'Mark as watched and stop', run: async () => { st.ended = true; await saveResume(); close(); } });
    items.push({ label: 'Key legend', run: () => { closeMenu(); $('#osd-legend').hidden = false; showOsd(); } });
    return items;
  }
  function subsMenu() {
    const info = st.info || { subs: [], sidecar: false };
    const items = [{ label: 'Off', dot: st.subSel === 'off', run: () => { applySub('off', true); closeMenu(); } }];
    if (info.sidecar) items.push({ label: 'Subtitle file next to the video', dot: st.subSel === 'file', run: () => { applySub('file', true); closeMenu(); } });
    for (const s of info.subs) items.push({ label: subLabel(s), value: s.kind.toUpperCase(), dot: st.subSel === s.n, run: () => { applySub(s.n, true); closeMenu(); } });
    if (st.loadedSub) items.push({ label: st.loadedSub.name, value: 'FILE', dot: st.subSel === 'loaded', run: () => { applyLoaded(st.loadedSub, true); closeMenu(); } });
    items.push({ label: 'Open a subtitle file…', value: 'SRT ASS VTT', run: () => { closeMenu(); pickSubFile(); } });
    if (!info.subs.length && !info.sidecar && !st.loadedSub) items.splice(1, 0, { label: st.info ? 'No subtitle tracks in this file' : 'Still reading the file…', run: () => {} });
    openMenu('subs', 'Subtitles', items, Math.max(0, items.findIndex((i) => i.dot)));
  }
  // A subtitle file from anywhere on disk (the movie with no embedded track): .srt, .vtt, .ass, .ssa.
  function pickSubFile() {
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.srt,.vtt,.ass,.ssa,text/plain'; inp.style.display = 'none';
    document.body.appendChild(inp);
    inp.onchange = async () => {
      const f = inp.files && inp.files[0]; inp.remove(); if (!f) return;
      let txt; const raw = new Uint8Array(await f.arrayBuffer());
      if (raw[0] === 0xff && raw[1] === 0xfe) txt = new TextDecoder('utf-16le').decode(raw.subarray(2));
      else if (raw[0] === 0xfe && raw[1] === 0xff) txt = new TextDecoder('utf-16be').decode(raw.subarray(2));
      else { txt = new TextDecoder('utf-8', { fatal: false }).decode(raw); if (/�/.test(txt)) txt = new TextDecoder('windows-1254').decode(raw); }   // Turkish releases are often cp1254
      const vtt = Parsers.srtToVtt(txt);
      const url = URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' }));
      st.loadedSub = { name: f.name, url, forPath: cur() && cur().path };
      applyLoaded(st.loadedSub, true);
    };
    inp.click();
  }
  function applyLoaded(sub, announce) {
    st.subSel = 'loaded'; st.lastSub = 'loaded'; clearTracks(false);
    st.subsUrl = null;
    const tr = el('track'); tr.kind = 'subtitles'; tr.label = sub.name; tr.srclang = 'en'; tr.src = sub.url; tr.default = true; v.appendChild(tr);
    setTimeout(() => { if (v.textTracks[0]) v.textTracks[0].mode = 'showing'; }, 50);
    if (announce) toast('Subtitles: ' + sub.name, 1400);
  }
  function chaptersMenu() {
    const items = chapters().map((ch, i) => ({ label: ch.name || `Chapter ${i + 1}`, value: fmtTime(ch.start), dot: currentChapter() === i, run: () => { v.currentTime = ch.start + 0.01; closeMenu(); showOsd(); } }));
    openMenu('chapters', 'Chapters', items, Math.max(0, currentChapter()));
  }
  function cycleSubs() {
    if (st.subSel !== 'off') { applySub('off', true); return; }
    if (st.lastSub === 'loaded' && st.loadedSub) { applyLoaded(st.loadedSub, true); return; }
    const info = st.info; if (!info) { toast('Still reading the file…', 900); return; }
    const sel = st.lastSub != null ? st.lastSub : (info.subs.length || info.sidecar ? ((info.subs.find((s) => !s.forced) || {}).n ?? 'file') : null);
    if (sel == null) toast('No subtitles in this file', 1200); else applySub(sel, true);
  }
  async function load(i) {
    st.idx = i; st.ended = false; st.scan = 0; st.info = null; st.subSel = 'off'; closeMenu();
    const c = cur();
    $('#osd-name').textContent = c.label; $('#osd-sub').textContent = c.sub || '';
    clearTracks(); applySubSize();
    v.src = src.url(c.rec); v.load(); v.playbackRate = st.speed;
    src.tracks(c.rec).then((info) => { if (!info || cur() !== c) return; st.info = info; applySub(pickSub(info), false); }).catch(() => {});
    const r = S.resume[c.path]; let startAt = 0;
    if (r && !r.done && r.t > 30) { const ans = await dialog({ title: 'Resume playback', text: `${c.label}\nYou stopped at ${fmtTime(r.t)}.`, buttons: ['Resume', 'Start over'] }); if (ans === 0) startAt = r.t; }
    if (cur() !== c) return;
    if (startAt) { if (v.readyState >= 1) v.currentTime = startAt; else v.addEventListener('loadedmetadata', function seek() { v.currentTime = startAt; v.removeEventListener('loadedmetadata', seek); }); }
    v.play().catch(() => {}); showOsd();
  }
  function toggle() { if (v.paused) v.play(); else v.pause(); }
  function stopScan() { if (!st.scan) return; clearInterval(st.scanIv); st.scanIv = null; st.scan = 0; v.playbackRate = st.speed; if (st.wasPlaying) v.play(); paint(); showOsd(); }
  function startScan(dir) {
    st.scanDir = dir; st.scan = 2; st.wasPlaying = !v.paused; st.scanStart = Date.now();
    if (dir > 0) { v.playbackRate = 2; v.play(); } else v.pause();
    st.scanIv = setInterval(() => { const held = Date.now() - st.scanStart; const want = held > 4000 ? 8 : held > 2000 ? 4 : 2; if (want !== st.scan) { st.scan = want; if (dir > 0) v.playbackRate = Math.min(want, 16); } if (dir < 0) v.currentTime = Math.max(0, v.currentTime - st.scan * 0.25); paint(); }, 250);
    paint(); showOsd();
  }
  async function close() {
    if (!st.open) return;
    stopScan(); if (!st.ended) await saveResume();
    st.open = false; root.hidden = true; v.pause(); v.removeAttribute('src'); v.load();
    clearTracks(); closeMenu(); $('#osd-legend').hidden = true;
    rerender();
  }
  return {
    isOpen: () => st.open,
    async open(queue, idx) {
      const c = queue[idx];
      if (setting('roast') && ROAST.test(c.rec.name)) {
        const a = await dialog({ title: 'Whistler declines', text: `"${c.rec.name}" looks like a reaction video, an unboxing, or a top-ten. Neptune won't play those on principle and Whistler inherited the principle.\nPlay it anyway?`, buttons: ['Play it', 'Fair enough'], def: 1 });
        if (a !== 0) return;
      }
      music.audio.pause();
      st.queue = queue; st.open = true; root.hidden = false; chromeUpdate(); $('#osd-legend').hidden = true;
      load(idx);
    },
    close,
    key(name, e) {
      if (st.menu) {
        const m = st.menu;
        if (name === 'up') m.idx = (m.idx + m.items.length - 1) % m.items.length;
        else if (name === 'down') m.idx = (m.idx + 1) % m.items.length;
        else if (name === 'enter' || name === 'space' || name === 'right') { activateMenu(); return true; }
        else if (name === 'back' || name === 'left' || name === 'o' || name === 'i') { if (m.kind === 'main') closeMenu(); else openMain(m.kind === 'subs' ? 1 : 2); return true; }
        else return true;
        renderMenu(); showOsd(); return true;
      }
      if (name === 'back') { if (!$('#osd-legend').hidden) { $('#osd-legend').hidden = true; return true; } close(); return true; }
      if (name === 'enter' || name === 'space' || name === 'playpause') { toggle(); showOsd(); return true; }
      if (name === 'left' || name === 'right') {
        if (e && e.repeat) { if (!st.scan && st.holdKey === name && Date.now() - st.holdAt > 450) startScan(name === 'right' ? 1 : -1); return true; }
        st.holdKey = name; st.holdAt = Date.now(); return true;
      }
      if (name === 'up' || name === 'o' || name === 'i') { openMain(); return true; }
      if (name === 'down') { showOsd(); return true; }
      if (name === '+' || name === '=') { v.volume = clamp(v.volume + 0.05, 0, 1); toast('Volume ' + Math.round(v.volume * 100) + '%', 900); return true; }
      if (name === '-' || name === '_') { v.volume = clamp(v.volume - 0.05, 0, 1); toast('Volume ' + Math.round(v.volume * 100) + '%', 900); return true; }
      if (name === '.' || name === '>') { chapterJump(1); return true; }
      if (name === ',' || name === '<') { chapterJump(-1); return true; }
      if (name === 'n' || name === 'next' || name === 'pgdn') { if (st.idx < st.queue.length - 1) { saveResume(); load(st.idx + 1); } return true; }
      if (name === 'p' || name === 'prev' || name === 'pgup') { if (v.currentTime > 5) v.currentTime = 0; else if (st.idx > 0) { saveResume(); load(st.idx - 1); } return true; }
      if (name === 'm') { v.muted = !v.muted; toast(v.muted ? 'Muted' : 'Sound on', 800); return true; }
      if (name === 's' || name === 'c') { cycleSubs(); return true; }
      if (name === 'f') { toggleFullscreen(); return true; }
      if (name === 'h') { $('#osd-legend').hidden = !$('#osd-legend').hidden; showOsd(); return true; }
      if (name === 'stop') { close(); return true; }
      return false;
    },
    keyup(name) {
      if (name !== 'left' && name !== 'right') return;
      if (st.scan) { stopScan(); st.holdKey = null; return; }
      if (st.holdKey === name) { v.currentTime = clamp(v.currentTime + (name === 'right' ? 10 : -10), 0, v.duration || 0); showOsd(); paint(); }
      st.holdKey = null;
    },
  };
})();
function toggleFullscreen() { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => {}); }

// =============================================================================== chrome: transport pill + now-playing inset
const transportEl = $('#transport'), insetEl = $('#inset');
function buildTransport() {
  const b = (title, svg, fn, cls = '') => { const x = el('button', 'tb ' + cls); x.title = title; x.innerHTML = svg; x.onclick = (e) => { e.stopPropagation(); fn(); }; return x; };
  const sep = () => el('span', 'sep');
  const svg = { prev: '<svg viewBox="0 0 12 12"><path d="M2 1h2v10H2zM11 1v10L4 6z"/></svg>', next: '<svg viewBox="0 0 12 12"><path d="M8 1h2v10H8zM1 1v10l7-5z"/></svg>', play: '<svg viewBox="0 0 12 12"><path d="M2 1v10l9-5z"/></svg>',
    pause: '<svg viewBox="0 0 12 12"><path d="M2 1h3v10H2zM7 1h3v10H7z"/></svg>', stop: '<svg viewBox="0 0 12 12"><rect x="2" y="2" width="8" height="8"/></svg>', mute: '<svg viewBox="0 0 12 12"><path d="M1 4h3l3-3v10L4 8H1z"/></svg>', rec: '<svg viewBox="0 0 12 12"><circle cx="6" cy="6" r="3.5"/></svg>' };
  transportEl.innerHTML = '';
  transportEl.append(el('span', 'lbl', 'CH'), b('Previous', svg.prev, () => music.prev()), b('Next', svg.next, () => music.next()), sep(),
    b('Play / pause', music.audio.paused ? svg.play : svg.pause, () => music.toggle()), b('Stop', svg.stop, () => music.stop()), b('Record (there is nothing to record)', svg.rec, () => toast('No tuner. This is a web page.'), 'rec'), sep(),
    b('Mute', svg.mute, () => { music.audio.muted = !music.audio.muted; }), el('span', 'lbl', 'VOL'), b('Volume down', '<b>−</b>', () => music.vol(-0.1)), b('Volume up', '<b>+</b>', () => music.vol(0.1)));
}
let insetRaf = 0;
function chromeUpdate() {
  const t = music.current(); const fullscreenThing = player.isOpen() || photoViewer.isOpen();
  const showTransport = !!t && !fullscreenThing;
  transportEl.hidden = !showTransport; if (showTransport) buildTransport();
  const np = current && current.isNowPlaying;
  insetEl.hidden = !(t && !fullscreenThing && !np);
  if (!insetEl.hidden) {
    insetEl.innerHTML = '';
    const art = el('div', 'art'); if (t.art) { const im = el('img'); im.src = t.art; art.appendChild(im); } insetEl.appendChild(art);
    const tx = el('div', 'txt'); tx.appendChild(el('div', 't', t.title)); tx.appendChild(el('div', 'a', t.artist)); insetEl.appendChild(tx);
    const cv = el('canvas'); cv.width = 40; cv.height = 30; insetEl.appendChild(cv);
    insetEl.onclick = () => go(nowPlayingScreen());
    cancelAnimationFrame(insetRaf);
    const draw = () => { if (insetEl.hidden) return; const g = cv.getContext('2d'); g.clearRect(0, 0, 40, 30); const sp = music.spectrum(8); for (let i = 0; i < 8; i++) { const h = sp ? sp[i] * 28 : 2; g.fillStyle = '#B6EE6C'; g.fillRect(i * 5, 30 - h, 4, h); } insetRaf = requestAnimationFrame(draw); };
    draw();
  }
}

// =============================================================================== gamepad
(() => {
  const held = {}; let lastAxis = 0;
  const MAP = { 0: 'enter', 1: 'back', 2: 's', 3: 'o', 9: 'f', 8: 'home', 12: 'up', 13: 'down', 14: 'left', 15: 'right', 4: 'prev', 5: 'next', 6: ',', 7: '.' };
  function poll() {
    const gps = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const gp of gps) {
      if (!gp) continue;
      gp.buttons.forEach((b, i) => {
        const k = MAP[i]; if (!k) return; const key = gp.index + ':' + i; const was = held[key];
        if (b.pressed && !was) { handleKey(k, { repeat: false }); held[key] = Date.now(); }
        else if (b.pressed && was && Date.now() - was > 450 && ['left', 'right', 'up', 'down'].includes(k)) { if (player.isOpen()) handleKey(k, { repeat: true }); else if (Date.now() - was > 600) { handleKey(k, { repeat: true }); held[key] = Date.now() - 500; } }
        else if (!b.pressed && was) { held[key] = 0; if (player.isOpen()) player.keyup(k); }
      });
      const ax = gp.axes[0] || 0, ay = gp.axes[1] || 0;
      if (Date.now() - lastAxis > 220) { if (ay < -0.55) { handleKey('up', {}); lastAxis = Date.now(); } else if (ay > 0.55) { handleKey('down', {}); lastAxis = Date.now(); } else if (ax < -0.55) { handleKey('left', {}); lastAxis = Date.now(); } else if (ax > 0.55) { handleKey('right', {}); lastAxis = Date.now(); } }
    }
    requestAnimationFrame(poll);
  }
  addEventListener('gamepadconnected', (e) => toast('Controller connected: ' + e.gamepad.id.split('(')[0].trim(), 2000));
  requestAnimationFrame(poll);
})();

// =============================================================================== boot
(async () => {
  src = await Source.detect();
  try { S = await src.loadState(); } catch { /* defaults */ }
  S.roots = S.roots || { videos: [], music: [], pictures: [] }; S.resume = S.resume || {}; S.settings = S.settings || {};
  applyTheme();
  go(startScreen());
  sfx.probe();
  addEventListener('keydown', () => sfx.play('intro'), { once: true });   // needs a gesture; the first key is it
  document.addEventListener('music:track', chromeUpdate);
  addEventListener('beforeunload', () => { if (player.isOpen()) player.close(); });
  installDrop();
  if (src.local && !src.supported()) {
    dialog({ title: 'Folder access', text: 'This browser cannot open folders at all. Use Chrome, Edge, Firefox or Safari, or run the optional server.js.', buttons: ['OK'] });
  } else if (src.local && src.needsReconnect) await reconnectFlow();
})();

// Remembered folders need a nod each session. Chromium: one permission prompt. Firefox and Safari:
// the browser forgot the handle entirely, so each folder has to be picked again (same id, so
// library roots and resume points survive).
async function reconnectFlow() {
  if (src.persistent) {
    const a = await dialog({ title: 'Reconnect folders', text: 'The browser remembers your folders but needs your OK before reading them again this session.', buttons: ['Reconnect', 'Later'] });
    if (a === 0) { const ok = await src.reconnect(); toast(ok ? 'Folders reconnected' : 'Some folders were not reconnected', 1600); scanCache.clear(); rerender(); }
    return;
  }
  for (const name of src.missingFolders()) {
    const a = await dialog({ title: 'Pick the folder again', text: `This browser doesn't keep folder access between sessions. Pick "${name}" again to carry on where you left off, or drop it onto the page.`, buttons: ['Pick folder', 'Later'] });
    if (a !== 0) break;
    const ok = await src.reconnectMissing(name);
    toast(ok ? `${name} reconnected` : `${name} not reconnected`, 1500);
  }
  scanCache.clear(); rerender();
}
// Any browser: drop a folder (or files) onto the page and it becomes an opened folder.
function installDrop() {
  addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dropping'); });
  addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dropping'); });
  addEventListener('drop', async (e) => {
    e.preventDefault(); document.body.classList.remove('dropping');
    if (!src.local || !src.fromDrop) { toast('Drop works when the page reads your folders itself (Settings › Look › Source)', 2500); return; }
    toast('Reading the dropped folder…', 2000);
    let added = [];
    try { added = await src.fromDrop(e.dataTransfer); } catch (err) { toast('Could not read that: ' + err.message, 2500); return; }
    if (!added.length) { toast('Nothing usable was dropped', 1500); return; }
    scanCache.clear();
    toast(`Opened ${added.map((a) => a.name).join(', ')}`, 2000);
    go(folderScreen(added[0].path));
  });
}
