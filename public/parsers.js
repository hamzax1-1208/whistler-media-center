/* parsers.js — tag and container readers shared by the browser and the Node server.
   Everything is async over a Reader (windowed byte access), so the same code runs on a
   File.slice() in the page and on an fd on the server. No dependencies either side.     */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Parsers = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ------------------------------------------------------------------ byte helpers
  const dec = (enc) => { try { return new TextDecoder(enc); } catch { return new TextDecoder('utf-8'); } };
  const dLatin = dec('latin1'), dUtf8 = dec('utf-8'), dU16le = dec('utf-16le'), dU16be = dec('utf-16be');
  const latin1 = (b, s = 0, e = b.length) => dLatin.decode(b.subarray(s, e));
  const utf8 = (b, s = 0, e = b.length) => dUtf8.decode(b.subarray(s, e));
  const u16 = (b, o) => (b[o] << 8) | b[o + 1];
  const u32 = (b, o) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
  const u64 = (b, o) => u32(b, o) * 4294967296 + u32(b, o + 4);
  const u32le = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 16777216;
  const f32 = (b, o) => new DataView(b.buffer, b.byteOffset + o, 4).getFloat32(0);
  const f64 = (b, o) => new DataView(b.buffer, b.byteOffset + o, 8).getFloat64(0);
  const uintOf = (b) => { let v = 0; for (let i = 0; i < b.length; i++) v = v * 256 + b[i]; return v; };
  const synchsafe = (b, o) => ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);

  // ------------------------------------------------------------------ media kinds
  const KINDS = {
    video: { mp4: 'video/mp4', m4v: 'video/mp4', mkv: 'video/x-matroska', webm: 'video/webm', mov: 'video/quicktime',
             avi: 'video/x-msvideo', wmv: 'video/x-ms-wmv', ts: 'video/mp2t', ogv: 'video/ogg', '3gp': 'video/3gpp' },
    audio: { mp3: 'audio/mpeg', flac: 'audio/flac', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', opus: 'audio/ogg',
             wav: 'audio/wav', wma: 'audio/x-ms-wma', oga: 'audio/ogg' },
    image: { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
             avif: 'image/avif', jfif: 'image/jpeg' },
    subs:  { srt: 'text/plain', vtt: 'text/vtt', ass: 'text/plain', ssa: 'text/plain' },
  };
  const extOf = (name) => { const m = /\.([a-z0-9]+)$/i.exec(name); return m ? m[1].toLowerCase() : ''; };
  const kindOf = (name) => { const e = extOf(name); for (const k of Object.keys(KINDS)) if (KINDS[k][e]) return k; return 'file'; };
  const mimeOf = (name) => { const e = extOf(name); for (const k of Object.keys(KINDS)) if (KINDS[k][e]) return KINDS[k][e]; return 'application/octet-stream'; };
  const COVER_NAMES = ['cover.jpg', 'cover.png', 'folder.jpg', 'folder.png', 'album.jpg', 'front.jpg', 'albumart.jpg', 'cover.jpeg'];

  // ------------------------------------------------------------------ Reader
  // readFn(pos, len) -> Promise<Uint8Array>. Keeps a window so header walks don't hammer the source.
  class Reader {
    constructor(readFn, size, win) { this.readFn = readFn; this.size = size; this.win = win || (4 << 20); this.wStart = 0; this.w = new Uint8Array(0); }
    async bytes(pos, len) {
      if (pos >= this.size || pos < 0) return null; len = Math.min(len, this.size - pos);
      if (pos < this.wStart || pos + len > this.wStart + this.w.length) {
        const n = Math.min(Math.max(this.win, len), this.size - pos);
        this.w = await this.readFn(pos, n); this.wStart = pos;
      }
      return this.w.subarray(pos - this.wStart, pos - this.wStart + len);
    }
  }

  // ------------------------------------------------------------------ ID3v2 (2.2 / 2.3 / 2.4)
  function unsync(buf) {
    const out = new Uint8Array(buf.length); let j = 0;
    for (let i = 0; i < buf.length; i++) { out[j++] = buf[i]; if (buf[i] === 0xff && buf[i + 1] === 0x00) i++; }
    return out.subarray(0, j);
  }
  function decodeText(buf) {
    if (!buf.length) return '';
    const enc = buf[0]; const b = buf.subarray(1); let s;
    if (enc === 1) { if (b[0] === 0xfe && b[1] === 0xff) s = dU16be.decode(b.subarray(2)); else s = dU16le.decode(b[0] === 0xff && b[1] === 0xfe ? b.subarray(2) : b); }
    else if (enc === 2) s = dU16be.decode(b);
    else if (enc === 3) s = utf8(b);
    else s = latin1(b);
    return s.replace(/\0+$/g, '').split('\0')[0].trim();
  }
  function cstr(buf, off, wide) {
    if (wide) { let i = off; while (i + 1 < buf.length && !(buf[i] === 0 && buf[i + 1] === 0)) i += 2; return [buf.subarray(off, i), Math.min(i + 2, buf.length)]; }
    let i = off; while (i < buf.length && buf[i] !== 0) i++; return [buf.subarray(off, i), Math.min(i + 1, buf.length)];
  }
  function parseId3(buf, wantCover) {
    if (buf.length < 10 || latin1(buf, 0, 3) !== 'ID3') return null;
    const ver = buf[3], flags = buf[5]; const size = synchsafe(buf, 6);
    let body = buf.subarray(10, Math.min(buf.length, 10 + size));
    if (ver === 3 && (flags & 0x80)) body = unsync(body);
    let off = 0; if (flags & 0x40) off = ver === 4 ? synchsafe(body, 0) : u32(body, 0) + 4;
    const t = { tagSize: 10 + size }; const hlen = ver === 2 ? 6 : 10;
    while (off + hlen <= body.length) {
      let id, fsize, fflags = 0;
      if (ver === 2) { id = latin1(body, off, off + 3); fsize = (body[off + 3] << 16) | (body[off + 4] << 8) | body[off + 5]; }
      else { id = latin1(body, off, off + 4); fsize = ver === 4 ? synchsafe(body, off + 4) : u32(body, off + 4); fflags = u16(body, off + 8); }
      if (!/^[A-Z0-9]+$/.test(id) || fsize <= 0) break;
      let data = body.subarray(off + hlen, off + hlen + fsize); off += hlen + fsize;
      if (ver === 4 && (fflags & 0x02)) data = unsync(data);
      if (ver === 4 && (fflags & 0x01)) data = data.subarray(4);
      switch (id) {
        case 'TIT2': case 'TT2': t.title = decodeText(data); break;
        case 'TPE1': case 'TP1': t.artist = decodeText(data); break;
        case 'TPE2': case 'TP2': t.albumArtist = decodeText(data); break;
        case 'TALB': case 'TAL': t.album = decodeText(data); break;
        case 'TYER': case 'TYE': case 'TDRC': case 'TDRL': if (!t.year) t.year = decodeText(data).slice(0, 4); break;
        case 'TRCK': case 'TRK': t.track = parseInt(decodeText(data), 10) || undefined; break;
        case 'TPOS': case 'TPA': t.disc = parseInt(decodeText(data), 10) || undefined; break;
        case 'TCON': case 'TCO': t.genre = decodeText(data).replace(/^\(\d+\)/, ''); break;
        case 'TLEN': t.lengthMs = parseInt(decodeText(data), 10) || undefined; break;
        case 'APIC': case 'PIC': {
          const enc = data[0]; let mime, o;
          if (id === 'PIC') { const f = latin1(data, 1, 4); mime = f === 'PNG' ? 'image/png' : 'image/jpeg'; o = 4; }
          else { const [m, n] = cstr(data, 1, false); mime = latin1(m) || 'image/jpeg'; o = n; }
          const picType = data[o]; o++;
          const [, n2] = cstr(data, o, enc === 1 || enc === 2);
          if (!t.cover || picType === 3) { t.cover = mime.includes('/') ? mime : 'image/' + mime; if (wantCover) t.coverData = data.subarray(n2); }
          break;
        }
        default: break;
      }
    }
    return t;
  }
  const BR_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
  const BR_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  function mp3Duration(buf, start, fileSize) {
    const end = Math.min(buf.length - 4, start + 65536);
    for (let i = start; i < end; i++) {
      if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) continue;
      const vb = (buf[i + 1] >> 3) & 3, layer = (buf[i + 1] >> 1) & 3, bi = buf[i + 2] >> 4, si = (buf[i + 2] & 0x0c) >> 2;
      if (vb === 1 || layer !== 1 || bi === 0 || bi === 15 || si === 3) continue;
      const mpeg1 = vb === 3;
      const sr = (mpeg1 ? [44100, 48000, 32000] : vb === 2 ? [22050, 24000, 16000] : [11025, 12000, 8000])[si];
      const br = (mpeg1 ? BR_V1 : BR_V2)[bi] * 1000; const spf = mpeg1 ? 1152 : 576;
      const mono = ((buf[i + 3] >> 6) & 3) === 3;
      const xo = i + 4 + (mpeg1 ? (mono ? 17 : 32) : (mono ? 9 : 17));
      const tag = latin1(buf, xo, xo + 4);
      if ((tag === 'Xing' || tag === 'Info') && xo + 12 <= buf.length) { const fl = u32(buf, xo + 4); if (fl & 1) return u32(buf, xo + 8) * spf / sr; }
      return (fileSize - start) * 8 / br;
    }
    return undefined;
  }

  // ------------------------------------------------------------------ FLAC
  function parseFlac(buf, wantCover) {
    if (latin1(buf, 0, 4) !== 'fLaC') return null;
    const t = {}; let off = 4;
    while (off + 4 <= buf.length) {
      const h = buf[off], last = h & 0x80, type = h & 0x7f; const len = (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3];
      const d = buf.subarray(off + 4, off + 4 + len);
      if (type === 0 && d.length >= 18) { const sr = (u32(d, 10) >> 12) & 0xfffff; const total = ((d[13] & 0x0f) * 2 ** 32) + u32(d, 14); if (sr && total) t.duration = total / sr; }
      else if (type === 4) {
        let o = 0; const vl = u32le(d, o); o += 4 + vl; const n = u32le(d, o); o += 4;
        for (let i = 0; i < n && o + 4 <= d.length; i++) {
          const l = u32le(d, o); o += 4; const s = utf8(d, o, o + l); o += l; const eq = s.indexOf('='); if (eq < 0) continue;
          const k = s.slice(0, eq).toUpperCase(), v = s.slice(eq + 1).trim();
          if (k === 'TITLE') t.title = v; else if (k === 'ARTIST') t.artist = t.artist || v; else if (k === 'ALBUM') t.album = v;
          else if (k === 'ALBUMARTIST') t.albumArtist = v; else if (k === 'DATE') t.year = v.slice(0, 4);
          else if (k === 'TRACKNUMBER') t.track = parseInt(v, 10) || undefined; else if (k === 'DISCNUMBER') t.disc = parseInt(v, 10) || undefined; else if (k === 'GENRE') t.genre = v;
        }
      } else if (type === 6) {
        let o = 0; const pt = u32(d, o); o += 4; const ml = u32(d, o); o += 4; const mime = latin1(d, o, o + ml); o += ml;
        const dl = u32(d, o); o += 4 + dl; o += 16; const pl = u32(d, o); o += 4;
        if (!t.cover || pt === 3) { t.cover = mime; if (wantCover) t.coverData = d.subarray(o, o + pl); }
      }
      off += 4 + len; if (last) break;
    }
    return t;
  }

  // ------------------------------------------------------------------ MP4 / M4A (moov is usually at the tail)
  async function parseMp4(reader, wantCover) {
    const t = {}; let pos = 0, moov = null;
    while (pos < reader.size) {
      const h = await reader.bytes(pos, 16); if (!h || h.length < 8) break;
      let size = u32(h, 0); const type = latin1(h, 4, 8); let hlen = 8;
      if (size === 1 && h.length >= 16) { size = u64(h, 8); hlen = 16; } else if (size === 0) size = reader.size - pos;
      if (size < hlen) break;
      if (pos === 0 && !['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide'].includes(type)) return null;
      if (type === 'moov') { moov = await reader.bytes(pos + hlen, Math.min(size - hlen, 32 << 20)); break; }
      pos += size;
    }
    if (!moov) return t;
    const walk = (start, end, fn) => {
      let p = start;
      while (p + 8 <= end) {
        let size = u32(moov, p); const type = latin1(moov, p + 4, p + 8); let hl = 8;
        if (size === 1) { size = u64(moov, p + 8); hl = 16; } else if (size === 0) size = end - p;
        if (size < hl) break; fn(type, p + hl, Math.min(p + size, end)); p += size;
      }
    };
    const ITEMS = ['©nam', '©ART', 'aART', '©alb', '©day', 'trkn', 'covr', '©gen', 'disk'];
    const onBox = (type, s, e) => {
      if (type === 'mvhd') { const v = moov[s]; if (v === 1) { const ts = u32(moov, s + 20), du = u64(moov, s + 24); if (ts) t.duration = du / ts; } else { const ts = u32(moov, s + 12), du = u32(moov, s + 16); if (ts) t.duration = du / ts; } }
      else if (type === 'tkhd') { const v = moov[s]; const wo = v === 1 ? s + 88 : s + 76; if (wo + 8 <= e) { const w = u32(moov, wo) / 65536, h = u32(moov, wo + 4) / 65536; if (w && h && !t.width) { t.width = Math.round(w); t.height = Math.round(h); } } }
      else if (type === 'trak' || type === 'udta' || type === 'ilst' || type === 'mdia') walk(s, e, onBox);
      else if (type === 'meta') walk(s + 4, e, onBox);
      else if (type === 'hdlr') { const sub = latin1(moov, s + 8, s + 12); if (sub === 'vide') t.hasVideo = true; else if (sub === 'soun') t.hasAudio = true; }
      else if (ITEMS.includes(type)) walk(s, e, (dt, ds, de) => {
        if (dt !== 'data') return;
        const dtype = u32(moov, ds) & 0xffffff; const pay = moov.subarray(ds + 8, de); const txt = () => utf8(pay).trim();
        if (type === '©nam') t.title = txt(); else if (type === '©ART') t.artist = txt(); else if (type === 'aART') t.albumArtist = txt();
        else if (type === '©alb') t.album = txt(); else if (type === '©day') t.year = txt().slice(0, 4); else if (type === '©gen') t.genre = txt();
        else if (type === 'trkn' && pay.length >= 4) t.track = u16(pay, 2) || undefined; else if (type === 'disk' && pay.length >= 4) t.disc = u16(pay, 2) || undefined;
        else if (type === 'covr') { t.cover = dtype === 14 ? 'image/png' : 'image/jpeg'; if (wantCover) t.coverData = pay.slice(); }
      });
    };
    walk(0, moov.length, onBox);
    return t;
  }

  // ------------------------------------------------------------------ Matroska (EBML)
  const EBML = { header: 0x1a45dfa3, segment: 0x18538067, seekHead: 0x114d9b74, info: 0x1549a966, tracks: 0x1654ae6b, attachments: 0x1941a469,
    chapters: 0x1043a770, tags: 0x1254c367, cluster: 0x1f43b675, cues: 0x1c53bb6b, void: 0xec,
    tsScale: 0x2ad7b1, duration: 0x4489, trackEntry: 0xae, trackNo: 0xd7, trackType: 0x83, codecId: 0x86, lang: 0x22b59c, langIETF: 0x22b59d,
    trackName: 0x536e, flagDefault: 0x88, flagForced: 0x55aa, video: 0xe0, pixW: 0xb0, pixH: 0xba,
    contentEncodings: 0x6d80, contentEncoding: 0x6240, contentCompression: 0x5034, compAlgo: 0x4254, compSettings: 0x4255,
    edition: 0x45b9, chapAtom: 0xb6, chapStart: 0x91, chapDisplay: 0x80, chapString: 0x85,
    timestamp: 0xe7, simpleBlock: 0xa3, blockGroup: 0xa0, block: 0xa1, blockDuration: 0x9b,
    attached: 0x61a7, fileName: 0x466e, fileMime: 0x4660, fileData: 0x465c };
  const TOP = new Set([EBML.cluster, EBML.cues, EBML.info, EBML.tracks, EBML.attachments, EBML.chapters, EBML.tags, EBML.seekHead, EBML.void]);
  function vint(b, o, keep) {
    if (o >= b.length) return null; const f = b[o]; let len = 1, mask = 0x80;
    while (len <= 8 && !(f & mask)) { len++; mask >>= 1; }
    if (len > 8 || o + len > b.length) return null;
    let v = keep ? f : (f & (mask - 1)); let ones = (f & (mask - 1)) === mask - 1;
    for (let i = 1; i < len; i++) { v = v * 256 + b[o + i]; if (b[o + i] !== 0xff) ones = false; }
    return { v, unknown: !keep && ones, len };
  }
  async function ebmlHeader(reader, pos) {
    const b = await reader.bytes(pos, 16); if (!b) return null;
    const id = vint(b, 0, true); if (!id) return null; const sz = vint(b, id.len, false); if (!sz) return null;
    return { id: id.v, size: sz.v, unknown: sz.unknown, data: pos + id.len + sz.len };
  }
  // Iterate children in [start,end) with the payload of small elements in hand.
  async function children(reader, start, end, fn) {
    let p = start;
    while (p < end) {
      const h = await ebmlHeader(reader, p); if (!h) break;
      const e = h.unknown ? end : Math.min(end, h.data + h.size);
      const payload = e - h.data <= (1 << 20) ? await reader.bytes(h.data, e - h.data) : null;
      const r = await fn(h, payload, e); if (r === false) break;
      p = e;
    }
  }
  async function mkvInfo(reader, opts) {
    const info = { scale: 1000000, duration: null, tracks: [], chapters: [], attachments: [] };
    const first = await ebmlHeader(reader, 0); if (!first || first.id !== EBML.header) return null;
    const seg = await ebmlHeader(reader, first.data + first.size); if (!seg || seg.id !== EBML.segment) return null;
    let pos = seg.data; const segEnd = seg.unknown ? reader.size : Math.min(reader.size, seg.data + seg.size);
    while (pos < segEnd) {
      const h = await ebmlHeader(reader, pos); if (!h) break;
      const end = h.unknown ? segEnd : Math.min(segEnd, h.data + h.size);
      if (h.id === EBML.cluster) break;
      if (h.id === EBML.info) await children(reader, h.data, end, (c, b) => { if (c.id === EBML.tsScale) info.scale = uintOf(b); else if (c.id === EBML.duration) info.duration = (b.length === 4 ? f32(b, 0) : f64(b, 0)) * info.scale / 1e9; });
      else if (h.id === EBML.tracks) await children(reader, h.data, end, async (c) => {
        if (c.id !== EBML.trackEntry) return;
        const t = { n: 0, type: 0, codec: '', lang: 'und', name: '', default: false, forced: false, width: 0, height: 0 };
        await children(reader, c.data, c.data + c.size, async (d, b) => {
          if (!b) return;
          if (d.id === EBML.trackNo) t.n = uintOf(b); else if (d.id === EBML.trackType) t.type = uintOf(b); else if (d.id === EBML.codecId) t.codec = latin1(b);
          else if (d.id === 0x63a2 && b.length <= (1 << 19)) t.codecPrivate = b.slice();   // ASS script header for subtitle tracks
          else if (d.id === EBML.lang) t.lang = latin1(b); else if (d.id === EBML.langIETF) t.langIETF = latin1(b); else if (d.id === EBML.trackName) t.name = utf8(b);
          else if (d.id === EBML.flagDefault) t.default = !!uintOf(b); else if (d.id === EBML.flagForced) t.forced = !!uintOf(b);
          else if (d.id === EBML.video) await children(reader, d.data, d.data + d.size, (v, vb) => { if (v.id === EBML.pixW) t.width = uintOf(vb); else if (v.id === EBML.pixH) t.height = uintOf(vb); });
          else if (d.id === EBML.contentEncodings) {
            // mkvmerge often zlib-compresses text subtitle blocks (ContentCompAlgo 0); 3 = header stripping.
            await children(reader, d.data, d.data + d.size, async (ce) => {
              if (ce.id !== EBML.contentEncoding) return;
              await children(reader, ce.data, ce.data + ce.size, async (cc) => {
                if (cc.id !== EBML.contentCompression) return;
                const comp = { algo: 0, settings: null };
                await children(reader, cc.data, cc.data + cc.size, (x, xb) => { if (x.id === EBML.compAlgo) comp.algo = uintOf(xb); else if (x.id === EBML.compSettings) comp.settings = xb.slice(); });
                t.compression = comp;
              });
            });
          }
        });
        info.tracks.push(t);
      });
      else if (h.id === EBML.chapters) await children(reader, h.data, end, async (ed) => {
        if (ed.id !== EBML.edition) return;
        await children(reader, ed.data, ed.data + ed.size, async (at) => {
          if (at.id !== EBML.chapAtom) return;
          const ch = { start: 0, name: '' };
          await children(reader, at.data, at.data + at.size, async (x, b) => { if (x.id === EBML.chapStart) ch.start = uintOf(b) / 1e9; else if (x.id === EBML.chapDisplay) await children(reader, x.data, x.data + x.size, (y, bb) => { if (y.id === EBML.chapString && !ch.name) ch.name = utf8(bb); }); });
          info.chapters.push(ch);
        });
      });
      else if (h.id === EBML.attachments && opts && opts.attachments) await children(reader, h.data, end, async (af) => {
        if (af.id !== EBML.attached) return;
        const a = { name: '', mime: '', pos: 0, size: 0 };
        await children(reader, af.data, af.data + af.size, (x, b) => { if (x.id === EBML.fileName) a.name = utf8(b); else if (x.id === EBML.fileMime) a.mime = latin1(b); else if (x.id === EBML.fileData) { a.pos = x.data; a.size = x.size; } });
        info.attachments.push(a);
      });
      pos = end;
    }
    info.chapters.sort((a, b) => a.start - b.start);
    return info;
  }
  // The [V4+ Styles] table from the ASS header: which styles sit at the top, which are italic.
  function assStyles(codecPrivate) {
    const out = {}; if (!codecPrivate) return out;
    const txt = utf8(codecPrivate); let fields = null;
    for (const raw of txt.split(/\r?\n/)) {
      const l = raw.trim();
      if (/^\[Events\]/i.test(l)) break;
      if (/^Format:/i.test(l)) { fields = l.slice(7).split(',').map((s) => s.trim().toLowerCase()); continue; }
      if (!/^Style:/i.test(l) || !fields) continue;
      const vals = l.slice(6).split(','); const get = (k) => { const i = fields.indexOf(k); return i >= 0 ? (vals[i] || '').trim() : ''; };
      const al = parseInt(get('alignment'), 10);
      out[get('name')] = { top: al >= 7 && al <= 9, italic: get('italic') === '-1' };
    }
    return out;
  }
  function assToVtt(text, styles) {
    const parts = text.split(','); if (parts.length < 9) return null;
    const style = parts[2]; let body = parts.slice(8).join(',');
    if (/\\(pos|move|org|clip|iclip|p[1-9]|t\()/i.test(body)) return null;
    if (/^(sign|signs|typeset|ts\b|op|ed|song|lyric|karaoke)/i.test(style) && !/dialog|default|main/i.test(style)) return null;
    const st = (styles && styles[style]) || null;
    let line = ''; if (/\\an[789]/.test(body) || (st && st.top && !/\\an[1-6]/.test(body))) line = ' line:8%';
    body = body.replace(/\{[^}]*\\i1[^}]*\}/g, '\u0001').replace(/\{[^}]*\\i0[^}]*\}/g, '\u0002')
      .replace(/\{[^}]*\}/g, '').replace(/\\N|\\n/g, '\n').replace(/\\h/g, ' ').trim();
    if (!body) return null;
    body = body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\u0001/g, '<i>').replace(/\u0002/g, '</i>');
    const opens = (body.match(/<i>/g) || []).length, closes = (body.match(/<\/i>/g) || []).length;
    if (opens > closes) body += '</i>'.repeat(opens - closes);
    if (st && st.italic && !body.includes('<i>')) body = '<i>' + body + '</i>';
    return { body, line };
  }
  const vttTime = (ms) => { ms = Math.max(0, Math.round(ms)); const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`; };
  const CLUSTER_ID = new Uint8Array([0x1f, 0x43, 0xb6, 0x75]);
  function indexOfBytes(hay, needle, from) {
    outer: for (let i = from || 0; i <= hay.length - needle.length; i++) { for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer; return i; }
    return -1;
  }
  // Undo Matroska ContentCompression on one block. zlib via the Compression Streams API, which
  // both browsers and Node have; header stripping is just prepending the stored bytes.
  async function decodeBlock(bytes, comp) {
    if (!comp) return bytes;
    if (comp.algo === 3) { const out = new Uint8Array((comp.settings ? comp.settings.length : 0) + bytes.length); if (comp.settings) out.set(comp.settings, 0); out.set(bytes, comp.settings ? comp.settings.length : 0); return out; }
    if (comp.algo === 0) {
      if (typeof DecompressionStream === 'undefined') throw new Error('no inflate available');
      const ds = new DecompressionStream('deflate');
      const buf = await new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer();
      return new Uint8Array(buf);
    }
    throw new Error('unsupported compression ' + comp.algo);   // 1 = bzip2, 2 = lzo1x: nobody uses these for subs
  }
  // Pull one subtitle track out as WebVTT. Walks every Cluster by headers; resyncs past zeroed
  // regions (partially synced cloud files) by hunting for the next Cluster ID.
  async function mkvExtractSubs(reader, trackNo, onProgress) {
    const info = await mkvInfo(reader); if (!info) return null;
    const track = info.tracks.find((t) => t.n === trackNo && t.type === 17); if (!track) return null;
    const isAss = /S_TEXT\/(ASS|SSA)/i.test(track.codec);
    const comp = track.compression || null;
    const styles = isAss ? assStyles(track.codecPrivate) : null;
    const first = await ebmlHeader(reader, 0); const seg = await ebmlHeader(reader, first.data + first.size);
    let pos = seg.data; const segEnd = seg.unknown ? reader.size : Math.min(reader.size, seg.data + seg.size);
    const scale = info.scale / 1e6; const cues = [];
    const resync = async (from) => { for (let q = from; q < segEnd; q += (4 << 20) - 4) { const b = await reader.bytes(q, 4 << 20); if (!b) return -1; const i = indexOfBytes(b, CLUSTER_ID); if (i >= 0) return q + i; } return -1; };
    const block = async (h, clusterTs, durationTs) => {
      const b = await reader.bytes(h.data, Math.min(h.size, 1 << 20)); if (!b) return;
      const tn = vint(b, 0, false); if (!tn || tn.v !== trackNo) return;
      const rel = (u16(b, tn.len) << 16) >> 16; const flags = b[tn.len + 2];
      if (flags & 0x06) return;
      let payload = b.subarray(tn.len + 3, h.size);
      if (comp) { try { payload = await decodeBlock(payload, comp); } catch { return; } }
      const text = utf8(payload);
      const start = (clusterTs + rel) * scale; const dur = durationTs != null ? durationTs * scale : 3000;
      if (isAss) { const c = assToVtt(text, styles); if (c) cues.push({ start, end: start + dur, text: c.body, line: c.line }); }
      else { const t = text.replace(/\r/g, '').replace(/<\/?font[^>]*>/gi, '').replace(/&/g, '&amp;').replace(/<(?!\/?[biu]>)/g, '&lt;').trim(); if (t) cues.push({ start, end: start + dur, text: t, line: '' }); }
    };
    let derails = 0, n = 0;
    while (pos < segEnd) {
      const h = await ebmlHeader(reader, pos);
      if (!h || (h.id !== EBML.cluster && !TOP.has(h.id))) { if (++derails > 64) break; const nx = await resync(pos + 1); if (nx < 0) break; pos = nx; continue; }
      if (h.id !== EBML.cluster) { if (h.unknown) break; pos = h.data + h.size; continue; }
      if (onProgress && (++n & 15) === 0) onProgress(pos / segEnd);
      let clusterTs = 0; let p = h.data; const cEnd = h.unknown ? segEnd : Math.min(segEnd, h.data + h.size); let broke = false;
      while (p < cEnd) {
        const c = await ebmlHeader(reader, p);
        if (!c || c.size > cEnd - c.data) { const nx = await resync(p + 1); pos = nx < 0 ? segEnd : nx; broke = true; break; }
        if (h.unknown && TOP.has(c.id) && c.id !== EBML.void) { pos = p; broke = true; break; }
        if (c.id === EBML.timestamp) clusterTs = uintOf(await reader.bytes(c.data, c.size));
        else if (c.id === EBML.simpleBlock) await block(c, clusterTs, null);
        else if (c.id === EBML.blockGroup) {
          let q = c.data; const gEnd = c.data + c.size; let blk = null, dur = null;
          while (q < gEnd) { const g = await ebmlHeader(reader, q); if (!g) break; if (g.id === EBML.block) blk = g; else if (g.id === EBML.blockDuration) dur = uintOf(await reader.bytes(g.data, g.size)); q = g.data + g.size; }
          if (blk) await block(blk, clusterTs, dur);
        }
        p = c.data + c.size;
      }
      if (!broke) pos = cEnd;
    }
    cues.sort((a, b) => a.start - b.start);
    let out = 'WEBVTT\n\n';
    for (const c of cues) out += `${vttTime(c.start)} --> ${vttTime(c.end)}${c.line}\n${c.text}\n\n`;
    return out;
  }

  // ------------------------------------------------------------------ subtitle files -> VTT
  function srtToVtt(txt) {
    txt = txt.replace(/^﻿/, '');
    if (/^WEBVTT/.test(txt)) return txt;
    if (/^\[Script Info\]/im.test(txt) || /^\[Events\]/im.test(txt)) return assFileToVtt(txt);
    return 'WEBVTT\n\n' + txt.replace(/\r/g, '').replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2').replace(/<\/?font[^>]*>/gi, '').replace(/\{\\[^}]*\}/g, '');
  }
  // A standalone .ass/.ssa file: same dialogue rules as the embedded kind, timings from Start/End.
  function assFileToVtt(txt) {
    txt = txt.replace(/^﻿/, '').replace(/\r/g, '');
    const styles = assStyles(new TextEncoder().encode(txt));
    const lines = txt.split('\n'); let inEvents = false, fields = null; const cues = [];
    const ms = (t) => { const m = /(\d+):(\d\d):(\d\d)[.:](\d\d)/.exec(t.trim()); return m ? ((+m[1] * 3600 + +m[2] * 60 + +m[3]) * 1000 + +m[4] * 10) : null; };
    for (const raw of lines) {
      const l = raw.trim();
      if (/^\[Events\]/i.test(l)) { inEvents = true; continue; }
      if (/^\[/.test(l)) { inEvents = false; continue; }
      if (!inEvents) continue;
      if (/^Format:/i.test(l)) { fields = l.slice(7).split(',').map((s) => s.trim().toLowerCase()); continue; }
      if (!/^Dialogue:/i.test(l) || !fields) continue;
      const vals = l.slice(9).split(','); const rest = vals.slice(fields.length - 1).join(','); const v = vals.slice(0, fields.length - 1); v.push(rest);
      const get = (k) => { const i = fields.indexOf(k); return i >= 0 ? (v[i] || '') : ''; };
      const start = ms(get('start')), end = ms(get('end')); if (start == null || end == null) continue;
      // rebuild the Matroska-style line the embedded path expects: ReadOrder,Layer,Style,Name,ML,MR,MV,Effect,Text
      const c = assToVtt(['0', get('layer'), get('style').trim(), get('name'), get('marginl'), get('marginr'), get('marginv'), get('effect'), get('text')].join(','), styles);
      if (c) cues.push({ start, end, text: c.body, line: c.line });
    }
    cues.sort((a, b) => a.start - b.start);
    let out = 'WEBVTT\n\n';
    for (const c of cues) out += `${vttTime(c.start)} --> ${vttTime(c.end)}${c.line}\n${c.text}\n\n`;
    return out;
  }

  // ------------------------------------------------------------------ one entry point
  async function readTags(reader, name, wantCover) {
    const e = extOf(name); let t = {};
    if (e === 'mp3' || e === 'aac' || e === 'wav') {
      const head = await reader.bytes(0, 10); let tagLen = 0;
      if (head && latin1(head, 0, 3) === 'ID3') tagLen = 10 + synchsafe(head, 6);
      const want = Math.min(reader.size, tagLen + 65536 + 4, 12 << 20);
      const buf = await reader.bytes(0, want);
      t = (buf && parseId3(buf, wantCover)) || {};
      if (e === 'mp3' && buf) t.duration = t.lengthMs ? t.lengthMs / 1000 : mp3Duration(buf, tagLen, reader.size);
    } else if (e === 'flac') {
      const buf = await reader.bytes(0, Math.min(reader.size, 12 << 20)); t = (buf && parseFlac(buf, wantCover)) || {};
    } else if (['m4a', 'mp4', 'm4v', 'mov', '3gp'].includes(e)) {
      t = (await parseMp4(reader, wantCover)) || {};
    } else if (e === 'mkv' || e === 'webm') {
      const info = await mkvInfo(reader).catch(() => null);
      if (info) {
        t.duration = info.duration || undefined;
        const v = info.tracks.find((x) => x.type === 1);
        if (v) { t.width = v.width; t.height = v.height; t.hasVideo = true; t.codec = v.codec.replace('V_MPEG4/ISO/AVC', 'H.264').replace('V_MPEGH/ISO/HEVC', 'HEVC').replace('V_AV1', 'AV1').replace('V_VP9', 'VP9').replace(/^V_/, ''); }
        if (info.tracks.some((x) => x.type === 2)) t.hasAudio = true;
      }
    }
    delete t.tagSize; delete t.lengthMs;
    return t;
  }

  return { Reader, readTags, mkvInfo, mkvExtractSubs, assToVtt, assFileToVtt, srtToVtt, vttTime, KINDS, extOf, kindOf, mimeOf, COVER_NAMES };
});
