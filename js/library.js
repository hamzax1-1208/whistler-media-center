'use strict';
/* library.js — turning folders into a library: scanning the library folders, reading a
   title and an episode number out of a file name, grabbing video thumbnails, and shaping
   a music file into a track. Used by the screens in js/screens/. */

// ---------------------------------------------------------------- scanning

const SCAN_CACHE_LIFETIME_MS = 120000;

/** Results of recent scans, so going back and forth between screens does not rescan. */
const scanCache = new Map();

/**
 * Lists every media file of the given kinds under a set of library folders.
 * @param {string[]} roots library folder paths
 * @param {string[]} kinds 'video', 'audio' and / or 'image'
 * @returns {Promise<object[]>} file records, without duplicates
 */
async function scanRoots(roots, kinds) {
  const cacheKey = `${kinds}|${roots.join('|')}`;
  const cached = scanCache.get(cacheKey);
  if (cached && Date.now() - cached.scannedAt < SCAN_CACHE_LIFETIME_MS) return cached.files;

  const seenPaths = new Set();
  const files = [];
  for (const root of roots) {
    try {
      for (const file of await mediaSource.scanFolder(root, kinds)) {
        if (seenPaths.has(file.path)) continue;
        seenPaths.add(file.path);
        files.push(file);
      }
    } catch (error) {
      // one unreadable folder must not hide the others
      reportProblem(`Scanning ${root}`, error);
    }
  }
  scanCache.set(cacheKey, { scannedAt: Date.now(), files });
  return files;
}

/**
 * The text a library screen shows when it has no folders yet.
 * @param {string} libraryName 'Videos', 'Music' or 'Pictures'
 * @returns {{ title: string, hint: string }}
 */
function describeMissingRoots(libraryName) {
  const title = `No ${libraryName} folders yet.`;
  if (!mediaSource.local) {
    return {
      title,
      hint: `Go to My Computer, open a folder, and choose "Use as ${libraryName} folder" from the left column. Or import Kiyora's folders from Settings.`,
    };
  }
  const memoryNote = mediaSource.canRememberFolders
    ? 'The browser remembers it; nothing gets installed.'
    : 'This browser forgets folders between sessions, so you pick again next time.';
  return {
    title,
    hint: `Choose Add a folder… and pick the folder your ${libraryName.toLowerCase()} are in, or drop it onto this page. ${memoryNote}`,
  };
}

// ---------------------------------------------------------------- library folders

/**
 * The name of a folder as the user knows it. A folder opened in the browser is stored under
 * an id, so its own path does not say what it is called; its display path does.
 * @param {string} folderPath
 * @returns {string} for example "Holiday" for "Photos › 2024 › Holiday"
 */
function folderDisplayName(folderPath) {
  return baseName(mediaSource.displayPath(folderPath).split(' › ').pop());
}

/** The three libraries: the key in appState.roots, the name on screen, the kind of file. */
const LIBRARIES = [
  { kind: 'videos', name: 'Videos', mediaKind: 'video' },
  { kind: 'music', name: 'Music', mediaKind: 'audio' },
  { kind: 'pictures', name: 'Pictures', mediaKind: 'image' },
];

/**
 * Whether a library already shows a folder: the folder itself, one that contains it, or
 * (the user set it up by hand) one or more folders inside it.
 * @param {string} libraryKind 'videos', 'music' or 'pictures'
 * @param {string} folderPath
 * @returns {boolean}
 */
function isFolderInLibrary(libraryKind, folderPath) {
  const wanted = folderPath.toLowerCase();
  return appState.roots[libraryKind].some((root) => {
    const existing = root.toLowerCase();
    return (
      existing === wanted || existing.startsWith(`${wanted}/`) || wanted.startsWith(`${existing}/`)
    );
  });
}

/**
 * Adds "Add a folder…" to the left column of a library screen: at the end normally, but
 * first while the library is still empty, because then it is the one thing to do.
 * @param {object[]} modes the screen's own entries
 * @param {Function} addFolder what the entry runs
 * @param {boolean} isLibraryEmpty
 * @returns {object[]}
 */
function withAddFolderMode(modes, addFolder, isLibraryEmpty) {
  const addFolderMode = { label: 'Add a folder…', run: addFolder };
  return isLibraryEmpty ? [addFolderMode, ...modes] : [...modes, addFolderMode];
}

/**
 * Decides which folders become library folders when a folder is opened.
 * A folder with one kind of media goes in whole. A folder that mixes kinds ("Media" with
 * Videos, Music and Pictures inside) is split: each library gets the subfolders that hold
 * its kind, so My Pictures is not filled with album covers and loose films are not listed
 * as a series called "Videos".
 * @param {string} folderPath the folder that was opened
 * @param {string[]} subfolders the subfolders holding this kind; '' is the folder itself
 * @param {boolean} isMixed whether the folder holds more than one kind of media
 * @returns {string[]} the paths to add to the library
 */
function chooseLibraryRoots(folderPath, subfolders, isMixed) {
  const MAX_SEPARATE_SUBFOLDERS = 4; // more than this and the whole folder is simpler
  if (subfolders.length === 0) return [];
  const mustTakeWhole =
    !isMixed || subfolders.includes('') || subfolders.length > MAX_SEPARATE_SUBFOLDERS;
  if (mustTakeWhole) return [folderPath];
  return subfolders.map((subfolder) => `${folderPath}/${subfolder}`);
}

/**
 * Puts a folder the user just opened into the libraries it has files for, so its videos
 * show up in My Videos, its songs in My Music and its photos in My Pictures straight away.
 * @param {{ path: string, name: string }} folder what pickFolder or fromDrop returned
 * @param {string} [wantedKind] 'videos', 'music' or 'pictures': the library the user was
 *   adding to; the folder goes there whatever it holds
 * @returns {Promise<string>} a sentence saying where the folder went, for a toast
 */
async function addFolderToLibraries(folder, wantedKind) {
  if (!folder || typeof folder.path !== 'string') {
    throw new TypeError('addFolderToLibraries needs the folder that was opened');
  }
  let found = { video: [], audio: [], image: [] };
  try {
    found = await mediaSource.findMediaFolders(folder.path);
  } catch (error) {
    reportProblem(`Looking through ${folder.name}`, error);
  }
  const kindCount = LIBRARIES.filter((library) => found[library.mediaKind].length > 0).length;

  const fitting = []; // the libraries this folder belongs in
  const added = []; // those of them that did not have it yet
  for (const library of LIBRARIES) {
    let roots = chooseLibraryRoots(folder.path, found[library.mediaKind], kindCount > 1);
    if (roots.length === 0 && library.kind === wantedKind) roots = [folder.path];
    if (roots.length === 0) continue;
    fitting.push(library);
    const newRoots = roots.filter((root) => !isFolderInLibrary(library.kind, root));
    if (newRoots.length === 0) continue;
    appState.roots[library.kind].push(...newRoots);
    added.push(library);
  }
  if (added.length > 0) {
    await saveRoots();
    scanCache.clear();
  }

  const listNames = (libraries) =>
    libraries
      .map((library) => `My ${library.name}`)
      .join(', ')
      .replace(/, ([^,]*)$/, ' and $1');
  if (added.length > 0) return `${folder.name} is now in ${listNames(added)}`;
  if (fitting.length > 0) return `${folder.name} is already in ${listNames(fitting)}`;
  return `Opened ${folder.name}, but found no videos, music or pictures in it`;
}

// ---------------------------------------------------------------- reading file names
// Release names look like "[Group] Show Name S01 - 03 [1080p][HEVC].mkv". These two
// functions pull the readable parts out.

/** Words that describe the encode, not the title. */
const RELEASE_NOISE_WORDS = new Set(
  (
    '2160p 1440p 1080p 1080o 720p 480p 360p 4k uhd bluray blu-ray bdrip bdmv brrip bd webrip web-dl webdl web hdtv dvdrip dvd remux cr adn funi amzn nf ' +
    'x264 x265 h264 h265 hevc avc av1 xvid divx hi10p hi10 8bit 10bit 10bits aac ac3 eac3 dd+ ddp dts flac opus mp3 dual audio dualaudio multi multisub multisubs subs sub subbed dubbed ' +
    'eng engsub english vostfr jpn jap msubs softsubs subtitle subtitles multiple repack proper uncensored uncut complete batch nced ncop v0 v1 v2 v3'
  ).split(' '),
);

/**
 * Cleans a release name down to a title, and picks out the year and season if present.
 * @param {string} rawName a file or folder name
 * @returns {{ title: string, year: number|null, season: number|null }}
 */
function parseReleaseTitle(rawName) {
  let text = stripExtension(rawName)
    .replace(/^\s*\[[^\]]+\]\s*/, '') // leading [Group]
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ') // any other [tag] or (tag)
    .replace(/[._]/g, ' ');
  text = text.replace(
    /\b10\s*bits?\b|\bdual\s*audio\b|\bmulti[\s-]*subs?\b|\baac\s*2\s*[.]?\s*0\b|\bh\s*[.]?\s*26[45]\b|\bweb\s*-\s*dl\b|\b[25]\s*[.]\s*[01]\b/gi,
    ' ',
  );
  text = text.replace(/\s[-–]\s*\d{1,3}\s*[~\-–]\s*\d{1,3}\s*$/, ''); // trailing "- 01 ~ 12"

  let year = null;
  const words = text
    .split(/\s+/)
    .filter(Boolean)
    .filter((word) => {
      const lowerWord = word.toLowerCase();
      const firstPart = lowerWord.split('-')[0];
      if (RELEASE_NOISE_WORDS.has(lowerWord) || RELEASE_NOISE_WORDS.has(firstPart)) return false;
      if (word.startsWith('-')) return false;
      if (/^[a-z]*\d{3,4}[pi]$/i.test(word)) return false; // a resolution such as 1080p
      if (/^[0-9A-F]{8}$/i.test(word)) return false; // a CRC checksum
      if (/^(19|20)\d{2}$/.test(word)) {
        year = year || Number(word);
        return false;
      }
      return true;
    });

  let title = words
    .join(' ')
    .replace(/[-\s]+$/, '')
    .replace(/^[-\s]+/, '')
    .trim();
  let season = null;
  const seasonMatch = /\bS(?:eason)?s?\s*(\d{1,2})\b.*$/i.exec(title);
  if (seasonMatch) {
    season = Number(seasonMatch[1]);
    title =
      title
        .slice(0, seasonMatch.index)
        .replace(/[-\s]+$/, '')
        .trim() || title;
  }
  return { title: title || stripExtension(text).trim(), year, season };
}

/** The ways an episode number is written, most reliable first. */
const EPISODE_PATTERNS = [
  { pattern: /\bS(\d{1,2})\s*E(\d{1,3})\b/i, hasSeason: true }, // S01E03
  { pattern: /\b(\d{1,2})x(\d{1,3})\b/i, hasSeason: true }, // 1x03
  { pattern: /\s[-–]\s*(\d{1,3})(?:v\d)?\b(?!\s*[pi]\b)/, hasSeason: false }, // " - 03"
  { pattern: /\b(?:E|Ep|Episode)\s*(\d{1,3})\b/i, hasSeason: false }, // Episode 3
  { pattern: /\b(\d{1,3})\s*$/, hasSeason: false }, // a number at the very end
];

/**
 * Finds the season and episode number in a file name.
 * @param {string} fileName
 * @returns {{ season: number|null, episode: number|null, before: string, after: string }}
 *   before / after: the text on either side of the number (the show and the episode title)
 */
function parseEpisode(fileName) {
  const text = stripExtension(fileName)
    .replace(/^\s*\[[^\]]+\]\s*/, '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[._]/g, ' ');
  for (const { pattern, hasSeason } of EPISODE_PATTERNS) {
    const match = pattern.exec(text);
    if (!match) continue;
    const after = text
      .slice(match.index + match[0].length)
      .replace(/^[\s\-–:]+/, '')
      .replace(/\s*\(.*\)\s*$/, '')
      .trim();
    return {
      season: hasSeason ? Number(match[1]) : null,
      episode: Number(hasSeason ? match[2] : match[1]),
      before: text.slice(0, match.index),
      after,
    };
  }
  return { season: null, episode: null, before: text, after: '' };
}

/** True when a file name states its episode number outright (not just a trailing number). */
function hasExplicitEpisodeNumber(fileName) {
  return /\bS\d{1,2}\s*E\d{1,3}\b|\b\d{1,2}x\d{1,3}\b|\s[-–]\s*\d{1,3}(?:v\d)?\b|\b(?:E|Ep|Episode)\s*\d{1,3}\b/i.test(
    fileName,
  );
}

/**
 * The mark a video gets in a list: watched to the end, stopped part-way, or neither.
 * @param {string} path the video's path
 * @returns {'full'|'half'|null}
 */
function resumeMark(path) {
  const resumePoint = appState.resume[path];
  if (!resumePoint) return null;
  return resumePoint.done ? 'full' : 'half';
}

// ---------------------------------------------------------------- video thumbnails
// A frame is grabbed from each video with a hidden <video> and a canvas, then kept in
// IndexedDB so it is only made once.

const videoThumbnails = (() => {
  const THUMBNAIL_WIDTH = 192;
  const THUMBNAIL_HEIGHT = 108;
  const CAPTURE_TIMEOUT_MS = 9000;
  const MAX_PARALLEL_CAPTURES = 2;

  const memoryCache = new Map();
  const waitingJobs = [];
  let runningCaptures = 0;

  /** Starts waiting captures, at most two at a time. */
  function runNextJobs() {
    while (runningCaptures < MAX_PARALLEL_CAPTURES && waitingJobs.length > 0) {
      const job = waitingJobs.shift();
      runningCaptures++;
      captureFrame(job.file)
        .then(job.resolve, () => job.resolve(null))
        .finally(() => {
          runningCaptures--;
          runNextJobs();
        });
    }
  }

  /** @returns {boolean} true when a frame is (almost) black, which means it did not decode */
  function isBlankFrame(context) {
    const pixels = context.getImageData(0, 0, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT).data;
    const SAMPLE_STEP = 64; // every 16th pixel is plenty
    let brightnessSum = 0;
    for (let i = 0; i < pixels.length; i += SAMPLE_STEP) {
      brightnessSum += pixels[i] + pixels[i + 1] + pixels[i + 2];
    }
    return brightnessSum / (pixels.length / SAMPLE_STEP) < 12;
  }

  /**
   * Loads a video off screen, seeks a little way in and draws that frame.
   * @param {object} file a video file record
   * @returns {Promise<string>} a JPEG data URL; rejects when no frame could be drawn
   */
  function captureFrame(file) {
    return new Promise((resolve, reject) => {
      const video = document.createElement('video');
      video.muted = true;
      video.preload = 'metadata';
      const finish = (dataUrl) => {
        clearTimeout(timeout);
        video.removeAttribute('src');
        video.load();
        if (dataUrl) resolve(dataUrl);
        else reject(new Error('No frame'));
      };
      const timeout = setTimeout(() => finish(null), CAPTURE_TIMEOUT_MS);

      video.addEventListener('loadedmetadata', () => {
        video.currentTime = clamp(video.duration * 0.15, 3, 600);
      });
      video.addEventListener('seeked', () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = THUMBNAIL_WIDTH;
          canvas.height = THUMBNAIL_HEIGHT;
          const context = canvas.getContext('2d');
          // crop the frame to 16:9 around its centre
          const targetRatio = THUMBNAIL_WIDTH / THUMBNAIL_HEIGHT;
          const videoRatio = video.videoWidth / video.videoHeight || targetRatio;
          let sourceWidth = video.videoWidth;
          let sourceHeight = video.videoHeight;
          let sourceX = 0;
          let sourceY = 0;
          if (videoRatio > targetRatio) {
            sourceWidth = sourceHeight * targetRatio;
            sourceX = (video.videoWidth - sourceWidth) / 2;
          } else {
            sourceHeight = sourceWidth / targetRatio;
            sourceY = (video.videoHeight - sourceHeight) / 2;
          }
          context.drawImage(
            video,
            sourceX,
            sourceY,
            sourceWidth,
            sourceHeight,
            0,
            0,
            THUMBNAIL_WIDTH,
            THUMBNAIL_HEIGHT,
          );
          finish(isBlankFrame(context) ? null : canvas.toDataURL('image/jpeg', 0.72));
        } catch (error) {
          reportProblem(`Drawing a thumbnail for ${file.name}`, error);
          finish(null);
        }
      });
      video.addEventListener('error', () => finish(null));
      video.src = mediaSource.urlFor(file);
    });
  }

  return {
    /**
     * @param {object} file a video file record
     * @returns {Promise<string|null>} a small JPEG data URL, or null when the video cannot be decoded
     */
    async forVideo(file) {
      const cacheKey = `${file.path}|${Math.floor(file.mtime || 0)}`;
      if (memoryCache.has(cacheKey)) return memoryCache.get(cacheKey);
      const stored = await mediaSource.thumbCache.get(cacheKey);
      if (stored) {
        memoryCache.set(cacheKey, stored);
        return stored;
      }
      const dataUrl = await new Promise((resolve) => {
        waitingJobs.push({ file, resolve });
        runNextJobs();
      });
      if (dataUrl) {
        memoryCache.set(cacheKey, dataUrl);
        mediaSource.thumbCache.put(cacheKey, dataUrl);
      }
      return dataUrl;
    },
  };
})();

// ---------------------------------------------------------------- music

/**
 * Shapes a music file and its tags into a track for the library and the player.
 * @param {object} file an audio file record whose tags have been read
 * @returns {object} the track
 */
function trackFromFile(file) {
  const tags = file.tags || {};
  const folder = file.dir || directoryName(file.path);
  return {
    file,
    path: file.path,
    name: file.name,
    title: tags.title || stripExtension(file.name),
    artist: tags.artist || tags.albumArtist || 'Unknown artist',
    album: tags.album || folderDisplayName(folder),
    albumArtist: tags.albumArtist || tags.artist || 'Unknown artist',
    year: tags.year,
    trackNumber: tags.track,
    discNumber: tags.disc || 1,
    genre: tags.genre || 'Unknown genre',
    duration: tags.duration,
    hasCover: Boolean(tags.cover || tags.folderCover),
    coverUrl: undefined, // undefined: not asked for yet; null: asked, none found
    mtime: file.mtime,
  };
}
