# Whistler Media Center

## Ders projesi bilgileri (OYG103 JavaScript Uygulamaları)

| | |
|---|---|
| Öğrenci | Burak Hamza Öztürk |
| Öğrenci numarası | 250184023 |
| Okul / Program | İstanbul Gelişim Meslek Yüksekokulu, Bilgisayar Teknolojileri Bölümü, Ön Yüz Yazılım Geliştirme |
| Ders | OYG103 JavaScript Uygulamaları, 1. Aşama (plan ve analiz) |
| Dil | HTML, CSS ve saf JavaScript (çerçeve yok, derleme adımı yok) |

**Amaç.** Kişisel video, müzik ve fotoğraf arşivini hiçbir program kurmadan, hiçbir sunucu
çalıştırmadan, yalnızca bir tarayıcı sekmesinde ve Windows XP Media Center Edition 2002'nin
on-foot (uzaktan kumanda) arayüzüyle izlemek. Sayfa, kullanıcının seçtiği klasörü File System
Access API ile doğrudan okur; bütün dosya çözümleyicileri (ID3, FLAC, MP4, Matroska altyazı
çıkarma) tarayıcının içinde çalışır.

**Anahtar özellikler**

- Kurulumsuz: `public/index.html` dosyasını Chrome veya Edge ile açmak yeterli; klasör bir kez seçilir, tarayıcı hatırlar.
- Üç tema: Media Center 2002 (gerçek kabuğun ölçülerinden), Whistler Beta 2 (Luna 2462) ve Netflix; **T** tuşuyla geçiş.
- Videolarım: dosya adlarından dizi ve bölüm gruplama, kaldığı yerden devam, kare küçük resimleri, gömülü (MKV, SRT/ASS) ve yan altyazılar, bölüm listesi, otomatik sonraki bölüm.
- Müziğim: etiketlerden albüm / sanatçı / şarkı / tür, kapak resmi, çalma kuyruğu, karıştır, tekrar, Web Audio görselleştirici.
- Resimlerim: klasör karoları, Ken Burns efektli slayt gösterisi.
- Bilgisayarım ve Ayarlar: klasör bağlama, saat, altyazı dili, tema, ses efektleri, kaynak seçimi.
- Klavye ve oyun kumandası ile tam gezinme; isteğe bağlı sıfır bağımlılıklı Node sunucusu (`server.js`) ile ağ üzerinden izleme.


Windows XP Media Center Edition 2002 in a browser tab, reading your own folders. Nothing to
install, nothing running in the background: open the page, point it at a folder once, watch.

It is the third member of a small family. **Neptune Media Center** is the PSP one, **Kiyora**
is the Windows one, and this is the web one. Neptune and Odyssey were Microsoft's codenames
for the consumer and business Windows that never shipped; they were merged into **Whistler**,
which became XP, and XP's Media Center Edition is the default look here. The naming, in
other words, is load-bearing.

## Run it

Open `public/index.html` in **Chrome or Edge**, or host the `public/` folder anywhere static
(GitHub Pages, a NAS, a USB stick). First visit: My Computer, *Open a folder…*, pick your
anime folder, choose *Use as Videos folder*. The browser remembers the folder between
sessions and asks for a one-key nod before reading it again.

Every parser (ID3, FLAC, MP4, Matroska subtitles) runs in the page. How the page gets at the
folder depends on the browser:

| Browser          | Opening folders                                                        | Between sessions                          |
|------------------|------------------------------------------------------------------------|-------------------------------------------|
| Chrome, Edge     | *Open a folder…* (File System Access API), or drop a folder on the page | Remembered; one keypress to reconnect     |
| Firefox, Safari  | *Open a folder…* (a folder picker), or drop a folder on the page        | Forgotten by the browser; the page asks you to pick the same folder again, and your library and resume points carry over |

Playback is whatever the browser decodes. Tested here on Firefox 156: H.264 and AV1 in MKV
play, MP4 plays, HEVC does not. Chromium plays HEVC when the HEVC Video Extension is installed.

There is also an **optional** `server.js` (Node, zero dependencies) for two cases: watching
from another device on the LAN, and browsers without folder access. `node server.js --open`
or `start.cmd`. Same page, same code; Settings › Look › Source switches between the two.

## Three themes

Settings › Look, or press **T** anywhere.

| Theme               | What it is                                                                                                   |
|---------------------|--------------------------------------------------------------------------------------------------------------|
| Media Center 2002   | The original. Measured from the real shell's resource DLL (build 5.1.2600.1106): its palette, Trebuchet, 239x55 start entries, 251x51 buttons, 212x196 tiles, the 150px watermark at 12.5%, the translucent blue slabs and the soft green focus gloss, and the painted light-curtain backdrop rebuilt as gradients. See `reference/mce2002/MEASUREMENTS.md` |
| Whistler Beta 2     | Luna as it stood in build 2462: blue title bar, Explorer task pane on the left, white content, Tahoma, Bliss behind the window, and the "Evaluation copy" stamp on the desktop |
| Netflix             | Black and red, "Who's watching?" on the start screen, a hero that shows whatever you have focused, rows of 16:9 cards |

The 2002 and Whistler themes lay out on a fixed 1024x768 canvas scaled to the window,
because the proportions are the design. Netflix goes fluid.

## What's in it

| Start menu    | What it does                                                                     |
|---------------|----------------------------------------------------------------------------------|
| My Videos     | Groups scene-release names into series, episode lists with resume marks, frame thumbnails, embedded and sidecar subtitles, chapters, hold-to-scan, autoplay next |
| My Music      | Albums / Artists / Songs / Genres from real tags, embedded or folder cover art, now-playing with a Web Audio spectrum, queue, shuffle, repeat, keeps playing while you browse |
| My Pictures   | Folder tiles as 2x2 contact sheets, slide show with Ken Burns drift               |
| My Computer   | The folders you opened (or, in server mode, every drive). Any media file plays from here; any folder can be made a library folder from its left column |
| Settings      | Clock, slide show, subtitles, theme, library folders, source                     |

My TV and Play DVD are omitted rather than faked, same reasoning as Kiyora.

## The video player

Press **Up** (or click OPTIONS) for the options menu:

| Option        | What it does                                                                     |
|---------------|----------------------------------------------------------------------------------|
| Subtitles     | Every subtitle track embedded in the MKV (SRT and ASS), plus a sidecar `.srt`/`.vtt`. Listed by language and name, so "Full Subtitles" and "Signs & Songs" are told apart |
| Audio         | Lists the audio tracks. A browser cannot switch between them; the file's default plays |
| Chapters      | The MKV's chapter list to jump to. `,` and `.` step through them, or skip 90 s without chapters |
| Speed, Picture (fit/fill), Subtitle size, Full screen, Restart, Next episode, Mark as watched, Key legend |  |

Other keys: Enter pauses, Left/Right tap seeks 10 s and holding scans at 2/4/8x, N/P skip
episodes, S toggles subtitles, + and − (or the wheel) change volume, M mutes, F full screen.
Gamepads work: A opens, B goes back, Y opens options, X toggles subtitles.

A subtitle track is picked automatically from the preferred language in Settings, preferring
"Full" or "Dialogue" tracks over signs, then a sidecar, then anything.

**Embedded subtitles without ffmpeg:** the page walks the Matroska file cluster by cluster and
pulls out only the blocks of the chosen track, converting ASS dialogue to WebVTT. Blocks that
the muxer zlib-compressed (mkvmerge does this to text tracks; Crunchyroll-sourced releases
are full of it) are inflated with the browser's built-in DecompressionStream. The ASS style
table is read too, so top-aligned and italic styles come through. Positioned typesetting and
sign/song styles are dropped. The result is cached in the browser so the second time is instant.

**A file with no subtitle track** (a dubbed movie, say): Subtitles › *Open a subtitle file…*
takes an .srt, .vtt, .ass or .ssa from anywhere on disk, in UTF-8, UTF-16 or Windows-1254.
A file with the same name next to the video is picked up automatically.

Partially synced cloud files read as zeros past a point; the walker resyncs to the next
cluster and returns what it can.

## Files

```
public/index.html   the page
public/style.css    the 2002 look and everything shared
public/themes/      whistler.css, netflix.css
public/parsers.js   ID3 / FLAC / MP4 / Matroska readers, shared with the server
public/source.js    where media comes from: browser folders, or the server
public/app.js       every screen, the players, keyboard + gamepad
server.js           optional. Node, zero dependencies
data/               server mode only: library folders, resume points, tag cache
```

## What plays

Whatever your browser decodes. Chromium and Edge handle **H.264** and **AV1**, and **HEVC**
when the HEVC Video Extension is installed. 10-bit HEVC depends on the GPU; older codecs in
AVI generally do not play. The player says so instead of showing a black screen.

## Sounds

The shell had four: a tick on every cursor move, a note on select, a buzz on error and a
startup sting. Whistler plays them if `public/sounds/focus.wav`, `select.wav`, `error.wav`
and `intro.wav` exist, with an on/off row in Settings. None are bundled; the originals are
Microsoft's. Put your own there, or leave the folder empty.
