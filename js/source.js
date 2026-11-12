'use strict';
/* source.js — where the media comes from. There are two sources with the same functions,
   so the screens never need to know which one they are talking to:

   Local source   The page reads folders by itself. In Chrome and Edge the File System Access
                  API hands over a folder and the browser remembers it; in Firefox and Safari a
                  folder is picked (or dropped) each session. Every parser runs in the page.
                  Nothing is installed and nothing runs in the background.
   Server source  The optional server.js reads the PC and the page asks it over HTTP. For
                  watching from another device on the network.

   Paths: the local source has no real paths. An opened folder gets an id, and everything
   inside it is addressed as "id/sub/folder/file.mkv".                                    */

const Source = (() => {
  const DATABASE_NAME = 'whistler';
  const DATABASE_VERSION = 2;
  const STORE_NAMES = ['thumbs', 'handles', 'tags', 'subs'];
  const STATE_KEY = 'whistler.state';
  const MODE_KEY = 'whistler.mode';
  const SERVER_PROBE_TIMEOUT_MS = 1500;

  /** Folders that are never worth scanning. */
  const SKIPPED_FOLDERS =
    /^(\.|\$|node_modules$|System Volume Information$|Windows$|Program Files|AppData$|\$RECYCLE)/i;

  // ---------------------------------------------------------------- IndexedDB
  // Thumbnails, read tags, extracted subtitles and folder handles are kept here. Every
  // function resolves with "nothing" instead of failing: the caches are optional.

  let databasePromise = null;

  /** @returns {Promise<IDBDatabase|null>} the database, or null when the browser refuses one */
  function openDatabase() {
    if (!databasePromise) {
      databasePromise = new Promise((resolve) => {
        const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
        request.onupgradeneeded = () => {
          for (const storeName of STORE_NAMES) {
            if (!request.result.objectStoreNames.contains(storeName))
              request.result.createObjectStore(storeName);
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
      });
    }
    return databasePromise;
  }

  /** Runs one write (put or delete) and resolves when the transaction is over. */
  async function writeToStore(storeName, write) {
    const db = await openDatabase();
    if (!db) return;
    await new Promise((resolve) => {
      try {
        const transaction = db.transaction(storeName, 'readwrite');
        write(transaction.objectStore(storeName));
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => resolve();
      } catch (error) {
        reportProblem(`Writing to the "${storeName}" cache`, error);
        resolve();
      }
    });
  }

  const database = {
    /** @returns {Promise<*>} the stored value, or null */
    async get(storeName, key) {
      const db = await openDatabase();
      if (!db) return null;
      return new Promise((resolve) => {
        const request = db.transaction(storeName).objectStore(storeName).get(key);
        request.onsuccess = () => resolve(request.result ?? null);
        request.onerror = () => resolve(null);
      });
    },
    put(storeName, key, value) {
      return writeToStore(storeName, (store) => store.put(value, key));
    },
    remove(storeName, key) {
      return writeToStore(storeName, (store) => store.delete(key));
    },
    /** @returns {Promise<Array<{ key: *, value: * }>>} everything in a store */
    async all(storeName) {
      const db = await openDatabase();
      if (!db) return [];
      return new Promise((resolve) => {
        const rows = [];
        const request = db.transaction(storeName).objectStore(storeName).openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) {
            resolve(rows);
            return;
          }
          rows.push({ key: cursor.key, value: cursor.value });
          cursor.continue();
        };
        request.onerror = () => resolve(rows);
      });
    },
  };

  /** Frame thumbnails are cached the same way by both sources. */
  const thumbCache = {
    get: (key) => database.get('thumbs', key),
    put: (key, value) => database.put('thumbs', key, value),
  };

  // ---------------------------------------------------------------- shared by both sources

  const createEmptyState = () => ({
    roots: { videos: [], music: [], pictures: [] },
    resume: {},
    settings: {},
  });

  /**
   * Applies a change to the saved state.
   * @param {object} state
   * @param {{ roots?: object, settings?: object, resume?: object, clearResume?: string }} patch
   */
  function applyStatePatch(state, patch) {
    if (patch.roots) state.roots = patch.roots;
    if (patch.settings) Object.assign(state.settings, patch.settings);
    if (patch.resume) Object.assign(state.resume, patch.resume);
    if (patch.clearResume) delete state.resume[patch.clearResume];
  }

  /** Picks the subtitle tracks, audio tracks and chapters out of what the Matroska parser read. */
  function describeMatroskaTracks(matroskaInfo) {
    const TRACK_TYPE_AUDIO = 2;
    const TRACK_TYPE_SUBTITLE = 17;
    const isTextSubtitle = (track) =>
      track.type === TRACK_TYPE_SUBTITLE && /S_TEXT\/(UTF8|ASS|SSA)/i.test(track.codec);
    return {
      subs: matroskaInfo.tracks.filter(isTextSubtitle).map((track) => ({
        n: track.n,
        lang: track.lang,
        langIETF: track.langIETF,
        name: track.name,
        default: track.default,
        forced: track.forced,
        kind: /ASS|SSA/i.test(track.codec) ? 'ass' : 'srt',
      })),
      audio: matroskaInfo.tracks
        .filter((track) => track.type === TRACK_TYPE_AUDIO)
        .map((track) => ({
          n: track.n,
          lang: track.lang,
          name: track.name,
          default: track.default,
          codec: track.codec.replace(/^A_/, ''),
        })),
      chapters: matroskaInfo.chapters,
    };
  }

  // ---------------------------------------------------------------- local source

  function createLocalSource() {
    const source = { local: true, state: createEmptyState(), needsReconnect: false, thumbCache };
    const folders = new Map(); // folder id -> { id, name, handle }; handle is missing when the browser forgot it
    const directoryCache = new Map(); // path -> directory handle
    const recordCache = new Map(); // path -> file record
    const coverByFolder = new Map(); // folder path -> the record of its cover.jpg
    const objectUrls = new Map(); // file path -> blob: URL
    const coverUrls = new Map(); // file path -> blob: URL of its embedded cover

    const splitPath = (path) => path.split('/').filter(Boolean);
    const joinPath = (...parts) => parts.filter(Boolean).join('/');
    const folderIdOf = (path) => splitPath(path)[0];
    const naturalPathOrder = (first, second) =>
      first.path.localeCompare(second.path, undefined, { numeric: true, sensitivity: 'base' });

    // ------------------------------------------------ saved state

    /** @returns {Promise<boolean>} whether the page may read a folder right now */
    async function hasReadPermission(folder) {
      if (!folder.handle) return false; // the browser could not keep this one
      try {
        return (await folder.handle.queryPermission({ mode: 'read' })) === 'granted';
      } catch {
        return false; // the folder was moved or deleted
      }
    }

    source.loadState = async () => {
      try {
        const saved = JSON.parse(localStorage.getItem(STATE_KEY) || '{}');
        source.state = Object.assign(createEmptyState(), saved);
      } catch (error) {
        reportProblem('Reading the saved state', error);
        source.state = createEmptyState();
      }
      for (const row of await database.all('handles')) folders.set(row.key, row.value);
      // a library folder inside an opened folder that no longer exists is dropped
      for (const kind of Object.keys(source.state.roots)) {
        source.state.roots[kind] = source.state.roots[kind].filter((root) =>
          folders.has(folderIdOf(root)),
        );
      }
      source.needsReconnect = false;
      for (const folder of folders.values()) {
        if (!(await hasReadPermission(folder))) source.needsReconnect = true;
      }
      return source.state;
    };

    source.saveState = async (patch) => {
      applyStatePatch(source.state, patch);
      try {
        localStorage.setItem(STATE_KEY, JSON.stringify(source.state));
      } catch (error) {
        throw new Error('The browser storage is full or blocked', { cause: error });
      }
      return source.state;
    };

    // ------------------------------------------------ opening folders
    // Two ways in. Chrome and Edge: showDirectoryPicker, and the handle can be stored.
    // Everyone else: a folder <input> or a dropped folder, which give a flat list of files
    // that is turned into a tree with the same functions as a real handle.

    source.canRememberFolders = typeof window.showDirectoryPicker === 'function';
    source.isSupported = () =>
      source.canRememberFolders || 'webkitdirectory' in document.createElement('input');

    /** A stand-in for a FileSystemDirectoryHandle, built from files the page already has. */
    function createVirtualDirectory(name) {
      return {
        kind: 'directory',
        name,
        isVirtual: true,
        directories: new Map(),
        files: new Map(),
        async *entries() {
          yield* this.directories;
          yield* this.files;
        },
        async getDirectoryHandle(childName) {
          const child = this.directories.get(childName);
          if (!child) throw new Error('No such folder');
          return child;
        },
        async queryPermission() {
          return 'granted';
        },
        async requestPermission() {
          return 'granted';
        },
        async isSameEntry(other) {
          return Boolean(other) && other.isVirtual === true && other.name === this.name;
        },
      };
    }

    /**
     * @param {string} rootName
     * @param {Array<{ relativePath: string, file: File }>} entries paths relative to the root
     * @returns {object} the root virtual directory
     */
    function buildVirtualTree(rootName, entries) {
      const root = createVirtualDirectory(rootName);
      for (const { relativePath, file } of entries) {
        const parts = relativePath.split('/').filter(Boolean);
        if (parts.length === 0) continue;
        const fileName = parts.pop();
        let directory = root;
        for (const part of parts) {
          if (!directory.directories.has(part))
            directory.directories.set(part, createVirtualDirectory(part));
          directory = directory.directories.get(part);
        }
        directory.files.set(fileName, { kind: 'file', name: fileName, getFile: async () => file });
      }
      return root;
    }

    /** Builds a tree from a FileList; a folder input reports each file as "Root/sub/file". */
    function treeFromFileList(fileList) {
      const files = [...fileList];
      if (files.length === 0) return null;
      const partsOf = (file) => (file.webkitRelativePath || file.name).split('/');
      const firstParts = partsOf(files[0]);
      const rootName = firstParts.length > 1 ? firstParts[0] : 'Dropped files';
      const entries = files.map((file) => {
        const parts = partsOf(file);
        return { relativePath: (parts.length > 1 ? parts.slice(1) : parts).join('/'), file };
      });
      return buildVirtualTree(rootName, entries);
    }

    /** Asks for a folder with a hidden <input type="file" webkitdirectory>. */
    function pickWithFileInput() {
      return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.webkitdirectory = true;
        input.multiple = true;
        input.hidden = true;
        document.body.appendChild(input);
        let isSettled = false;
        const settle = (tree) => {
          if (isSettled) return;
          isSettled = true;
          input.remove();
          resolve(tree);
        };
        input.addEventListener('change', () => settle(treeFromFileList(input.files)));
        input.addEventListener('cancel', () => settle(null));
        // browsers without a "cancel" event: the window gets focus back and nothing was chosen
        window.addEventListener('focus', () => setTimeout(() => settle(null), 1500), {
          once: true,
        });
        input.click();
      });
    }

    /**
     * Adds an opened folder to the list, unless the same folder is already there.
     * @returns {Promise<{ path: string, name: string }>}
     */
    async function registerFolder(handle) {
      for (const folder of folders.values()) {
        try {
          if (folder.handle && (await folder.handle.isSameEntry(handle)))
            return { path: folder.id, name: folder.name };
        } catch {
          // a handle that has gone stale cannot be compared; treat it as a different folder
        }
      }
      const id = `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const folder = { id, name: handle.name, handle };
      folders.set(id, folder);
      directoryCache.clear();
      // a real handle can be stored; a virtual tree cannot, so only a note that it existed is kept
      const stored = handle.isVirtual ? { id, name: handle.name, transient: true } : folder;
      await database.put('handles', id, stored);
      return { path: id, name: handle.name };
    }

    source.pickFolder = async () => {
      if (!source.isSupported()) {
        throw new Error(
          'This browser has no folder access at all. Use Chrome, Edge, Firefox or Safari, or run the optional server.js.',
        );
      }
      let handle = null;
      if (source.canRememberFolders) {
        try {
          handle = await window.showDirectoryPicker({ mode: 'read' });
        } catch {
          return null; // the user closed the picker
        }
      } else {
        handle = await pickWithFileInput();
      }
      return handle ? registerFolder(handle) : null;
    };

    /**
     * Opens what was dropped onto the page.
     * @param {DataTransfer} dataTransfer
     * @returns {Promise<Array<{ path: string, name: string }>>} the folders that were opened
     */
    source.fromDrop = async (dataTransfer) => {
      const droppedEntries = [...(dataTransfer.items || [])]
        .map((item) => (item.webkitGetAsEntry ? item.webkitGetAsEntry() : null))
        .filter(Boolean);

      // a directory reader hands its entries over in batches until an empty one
      const readDirectory = (directoryEntry) =>
        new Promise((resolve) => {
          const reader = directoryEntry.createReader();
          const children = [];
          const readBatch = () => {
            reader.readEntries(
              (batch) => {
                if (batch.length === 0) {
                  resolve(children);
                  return;
                }
                children.push(...batch);
                readBatch();
              },
              () => resolve(children),
            );
          };
          readBatch();
        });
      const fileOf = (fileEntry) =>
        new Promise((resolve) => fileEntry.file(resolve, () => resolve(null)));

      async function collectFiles(directoryEntry, prefix, entries) {
        for (const child of await readDirectory(directoryEntry)) {
          if (child.isDirectory) {
            await collectFiles(child, `${prefix}${child.name}/`, entries);
          } else {
            const file = await fileOf(child);
            if (file) entries.push({ relativePath: prefix + child.name, file });
          }
        }
      }

      const openedFolders = [];
      const looseFiles = [];
      for (const entry of droppedEntries) {
        if (entry.isDirectory) {
          const entries = [];
          await collectFiles(entry, '', entries);
          openedFolders.push(await registerFolder(buildVirtualTree(entry.name, entries)));
        } else {
          const file = await fileOf(entry);
          if (file) looseFiles.push({ relativePath: file.name, file });
        }
      }
      if (droppedEntries.length === 0 && dataTransfer.files && dataTransfer.files.length > 0) {
        const tree = treeFromFileList(dataTransfer.files);
        if (tree) openedFolders.push(await registerFolder(tree));
      } else if (looseFiles.length > 0) {
        openedFolders.push(await registerFolder(buildVirtualTree('Dropped files', looseFiles)));
      }
      return openedFolders;
    };

    // ------------------------------------------------ reconnecting in a new session

    /** Chrome and Edge: asks for permission to read the remembered folders again. */
    source.reconnect = async () => {
      let allGranted = true;
      for (const folder of folders.values()) {
        if (!folder.handle) {
          allGranted = false; // picked again one by one with reconnectMissing
          continue;
        }
        try {
          let permission = await folder.handle.queryPermission({ mode: 'read' });
          if (permission !== 'granted')
            permission = await folder.handle.requestPermission({ mode: 'read' });
          if (permission !== 'granted') allGranted = false;
        } catch {
          allGranted = false;
        }
      }
      source.needsReconnect = !allGranted;
      directoryCache.clear();
      return allGranted;
    };

    /** @returns {string[]} the names of the folders the browser forgot */
    source.missingFolders = () =>
      [...folders.values()].filter((folder) => !folder.handle).map((folder) => folder.name);

    /**
     * Firefox and Safari: asks for a forgotten folder again. It keeps its id, so the library
     * folders and resume points that point into it still work.
     */
    source.reconnectMissing = async (folderName) => {
      const folder = [...folders.values()].find(
        (candidate) => !candidate.handle && candidate.name === folderName,
      );
      if (!folder) return false;
      const tree = await pickWithFileInput();
      if (!tree) return false;
      folder.handle = tree;
      folder.name = tree.name;
      directoryCache.clear();
      source.needsReconnect = source.missingFolders().length > 0;
      return true;
    };

    source.forgetFolder = async (folderId) => {
      folders.delete(folderId);
      await database.remove('handles', folderId);
      for (const kind of Object.keys(source.state.roots)) {
        source.state.roots[kind] = source.state.roots[kind].filter(
          (root) => folderIdOf(root) !== folderId,
        );
      }
      await source.saveState({});
    };

    /** "f8k2x/Shows/Season 1" -> "My Folder › Shows › Season 1". */
    source.rootLabel = (path) => {
      const parts = splitPath(path);
      const folder = folders.get(parts[0]);
      if (!folder) return path;
      return [folder.name, ...parts.slice(1)].join(' › ');
    };
    source.displayPath = source.rootLabel;

    // ------------------------------------------------ reading folders

    async function directoryHandleFor(path) {
      if (directoryCache.has(path)) return directoryCache.get(path);
      const parts = splitPath(path);
      const folder = folders.get(parts[0]);
      if (!folder || !folder.handle) throw new Error('Folder is no longer available');
      let directory = folder.handle;
      for (const part of parts.slice(1)) directory = await directory.getDirectoryHandle(part);
      directoryCache.set(path, directory);
      return directory;
    }

    /** Makes the record the screens work with: name, path, kind, size, date and the File itself. */
    async function createFileRecord(folderPath, name, fileHandle) {
      const file = await fileHandle.getFile();
      const record = {
        name,
        path: joinPath(folderPath, name),
        dir: folderPath,
        kind: Parsers.kindOf(name),
        size: file.size,
        mtime: file.lastModified,
        file,
      };
      recordCache.set(record.path, record);
      if (record.kind === 'image' && Parsers.COVER_NAMES.includes(name.toLowerCase())) {
        coverByFolder.set(folderPath, record);
      }
      return record;
    }

    /** Lists one folder: subfolders and media files, no hidden or system entries. */
    source.listFolder = async (path) => {
      const directory = await directoryHandleFor(path);
      const entries = [];
      for await (const [name, entry] of directory.entries()) {
        if (/^(\$|\.)/.test(name)) continue;
        if (entry.kind === 'directory') {
          const childPath = joinPath(path, name);
          directoryCache.set(childPath, entry);
          entries.push({ name, path: childPath, kind: 'dir' });
          continue;
        }
        const kind = Parsers.kindOf(name);
        if (kind === 'file') continue; // not a media file
        try {
          const record = await createFileRecord(path, name, entry);
          if (kind !== 'subs') entries.push(record); // subtitle files are remembered, not listed
        } catch (error) {
          reportProblem(`Reading ${name}`, error);
        }
      }
      const parts = splitPath(path);
      const openedFolder = folders.get(parts[0]);
      const name =
        parts.length > 1 ? parts[parts.length - 1] : (openedFolder && openedFolder.name) || path;
      const parent = parts.length > 1 ? parts.slice(0, -1).join('/') : null;
      return { path, name, parent, entries };
    };

    /**
     * Walks a folder and everything under it.
     * @param {string} rootPath
     * @param {string[]} kinds the kinds of file to return
     * @param {{ budgetMs?: number }} [options] how long the walk may take
     * @returns {Promise<object[]>} file records sorted by path
     */
    source.scanFolder = async (rootPath, kinds, options = {}) => {
      const MAX_FILES = 40000;
      const MAX_DEPTH = 8;
      const deadline = Date.now() + (options.budgetMs || 60000);
      // subtitle files and cover pictures are recorded on the way, for the videos and albums next to them
      const recordedKinds = new Set([...kinds, 'subs']);
      const files = [];
      const pending = [{ path: rootPath, depth: 0 }];

      while (pending.length > 0 && files.length < MAX_FILES && Date.now() < deadline) {
        const { path, depth } = pending.shift();
        let directory;
        try {
          directory = await directoryHandleFor(path);
        } catch {
          continue; // this branch is gone; the rest may still be readable
        }
        try {
          for await (const [name, entry] of directory.entries()) {
            if (entry.kind === 'directory') {
              if (depth < MAX_DEPTH && !SKIPPED_FOLDERS.test(name)) {
                const childPath = joinPath(path, name);
                directoryCache.set(childPath, entry);
                pending.push({ path: childPath, depth: depth + 1 });
              }
              continue;
            }
            const kind = Parsers.kindOf(name);
            const isCoverPicture =
              kind === 'image' && Parsers.COVER_NAMES.includes(name.toLowerCase());
            if (!recordedKinds.has(kind) && !isCoverPicture) continue;
            try {
              const record = await createFileRecord(path, name, entry);
              record.root = rootPath;
              if (kinds.includes(kind)) files.push(record);
            } catch {
              // one unreadable file does not stop the scan
            }
          }
        } catch (error) {
          reportProblem(`Scanning ${path}`, error); // permission lost or folder removed part-way
        }
      }
      return files.sort(naturalPathOrder);
    };

    // ------------------------------------------------ files

    /** @returns {string} a blob: URL a <video>, <audio> or <img> can play; made once per file */
    source.urlFor = (fileOrPath) => {
      const record = typeof fileOrPath === 'string' ? recordCache.get(fileOrPath) : fileOrPath;
      if (!record || !record.file) return '';
      if (!objectUrls.has(record.path))
        objectUrls.set(record.path, URL.createObjectURL(record.file));
      return objectUrls.get(record.path);
    };

    /** A byte reader over a File, for the parsers. */
    const readerFor = (file) =>
      new Parsers.Reader(async (position, length) => {
        return new Uint8Array(await file.slice(position, position + length).arrayBuffer());
      }, file.size);

    /**
     * Reads the tags of every file that has none yet, four files at a time, and stores them
     * on the record as file.tags.
     * @param {object[]} files
     * @param {(done: number, total: number) => void} [onProgress]
     */
    source.loadTags = async (files, onProgress) => {
      const WORKER_COUNT = 4;
      const untagged = files.filter((file) => !file.tags);
      let nextIndex = 0;
      let doneCount = 0;

      async function worker() {
        while (nextIndex < untagged.length) {
          const file = untagged[nextIndex++];
          const cacheKey = `${file.path}|${file.size}|${file.mtime}`;
          let tags = await database.get('tags', cacheKey);
          if (!tags) {
            try {
              tags = await Parsers.readTags(readerFor(file.file), file.name, false);
            } catch (error) {
              reportProblem(`Reading the tags of ${file.name}`, error);
              tags = {};
            }
            await database.put('tags', cacheKey, tags);
          }
          file.tags = { ...tags };
          if (!file.tags.cover && coverByFolder.has(file.dir)) {
            file.tags.folderCover = coverByFolder.get(file.dir).path;
          }
          doneCount++;
          if (onProgress && (doneCount % 25 === 0 || doneCount === untagged.length)) {
            onProgress(doneCount, untagged.length);
          }
        }
      }
      await Promise.all(Array.from({ length: WORKER_COUNT }, worker));
      return files;
    };

    /** @returns {Promise<string|null>} a URL for the cover embedded in a file or lying next to it */
    source.coverUrl = async (record) => {
      if (!record || !record.tags) return null;
      if (record.tags.cover) {
        if (coverUrls.has(record.path)) return coverUrls.get(record.path);
        try {
          const tags = await Parsers.readTags(readerFor(record.file), record.name, true);
          if (tags.coverData) {
            const url = URL.createObjectURL(new Blob([tags.coverData], { type: tags.cover }));
            coverUrls.set(record.path, url);
            return url;
          }
        } catch (error) {
          reportProblem(`Reading the cover of ${record.name}`, error);
        }
      }
      return record.tags.folderCover ? source.urlFor(record.tags.folderCover) : null;
    };

    /** The subtitle file next to a video: same name, .srt or .vtt; the shortest name wins. */
    function findSidecar(videoRecord) {
      const videoBaseName = videoRecord.name.replace(/\.[^.]+$/, '').toLowerCase();
      const candidates = [...recordCache.values()].filter(
        (record) =>
          record.kind === 'subs' &&
          record.dir === videoRecord.dir &&
          /\.(srt|vtt)$/i.test(record.name) &&
          record.name.toLowerCase().startsWith(videoBaseName),
      );
      candidates.sort((first, second) => first.name.length - second.name.length);
      return candidates[0] || null;
    }

    /** @returns {Promise<{ subs: object[], audio: object[], chapters: object[], sidecar: boolean }>} */
    source.loadTracks = async (record) => {
      const tracks = { subs: [], audio: [], chapters: [], sidecar: Boolean(findSidecar(record)) };
      if (!/\.(mkv|webm)$/i.test(record.name)) return tracks;
      try {
        const matroskaInfo = await Parsers.mkvInfo(readerFor(record.file));
        if (matroskaInfo) Object.assign(tracks, describeMatroskaTracks(matroskaInfo));
      } catch (error) {
        reportProblem(`Reading the tracks of ${record.name}`, error);
      }
      return tracks;
    };

    /**
     * @param {object} record a video file record
     * @param {number|string} choice a subtitle track number, or 'file' for the file next to the video
     * @returns {Promise<string|null>} a blob: URL of the subtitles as WebVTT
     */
    source.subtitleUrl = async (record, choice, onProgress) => {
      let webVtt = null;
      if (choice === 'file') {
        const sidecar = findSidecar(record);
        if (!sidecar) return null;
        webVtt = Parsers.srtToVtt(await sidecar.file.text());
      } else {
        // pulling a track out of a large file takes a moment, so the result is kept
        const cacheKey = `${record.path}|${choice}|${record.size}|${record.mtime}`;
        webVtt = await database.get('subs', cacheKey);
        if (!webVtt) {
          webVtt = await Parsers.mkvExtractSubs(readerFor(record.file), choice, onProgress);
          if (webVtt) await database.put('subs', cacheKey, webVtt);
        }
      }
      return webVtt ? URL.createObjectURL(new Blob([webVtt], { type: 'text/vtt' })) : null;
    };

    // ------------------------------------------------ My Computer

    source.listComputer = async () => {
      const items = [...folders.values()].map((folder) => ({
        label: folder.name,
        kind: 'drive',
        path: folder.id,
        missing: !folder.handle,
        title: [
          folder.name,
          folder.handle ? 'Folder you opened' : 'Needs to be picked again this session',
        ],
      }));
      const memoryNote = source.canRememberFolders
        ? 'The browser remembers it.'
        : 'This browser forgets it when the tab closes, so you pick again next time.';
      items.push({
        label: 'Open a folder…',
        kind: 'up',
        action: 'pick',
        title: ['Open a folder', `Pick any folder on this PC. ${memoryNote}`],
      });
      const count = folders.size;
      const countNote =
        count > 0
          ? `${count} folder${count === 1 ? '' : 's'} opened in this browser`
          : 'Nothing opened yet';
      return { items, status: `${countNote} · you can also drop a folder onto this page` };
    };

    /** Kiyora's folders can only be read by the server. */
    source.loadKiyoraFolders = async () => null;

    return source;
  }

  // ---------------------------------------------------------------- server source

  function createServerSource() {
    const source = { local: false, state: createEmptyState(), needsReconnect: false, thumbCache };
    const mediaUrl = (path) => `/media?path=${encodeURIComponent(path)}`;
    const apiUrl = (route, parameters) =>
      `/api/${route}${parameters ? `?${new URLSearchParams(parameters)}` : ''}`;

    /** GET /api/<route>; throws with the server's message when the answer is an error. */
    async function getJson(route, parameters) {
      const response = await fetch(apiUrl(route, parameters));
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || response.statusText);
      }
      return response.json();
    }

    /** POST /api/<route> with a JSON body. */
    async function postJson(route, body) {
      const response = await fetch(apiUrl(route), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(response.statusText);
      return response.json();
    }

    source.loadState = async () => {
      source.state = Object.assign(createEmptyState(), await getJson('state'));
      return source.state;
    };
    source.saveState = async (patch) => {
      applyStatePatch(source.state, patch);
      await postJson('state', patch);
      return source.state;
    };

    // the server reads the disk directly, so there is nothing to pick or reconnect
    source.canRememberFolders = true;
    source.isSupported = () => true;
    source.reconnect = async () => true;
    source.pickFolder = async () => null;
    source.missingFolders = () => [];
    source.reconnectMissing = async () => false;
    source.rootLabel = (path) => path;
    source.displayPath = (path) => path;

    source.listFolder = (path) => getJson('ls', { path });
    source.scanFolder = async (rootPath, kinds) => {
      const result = await getJson('scan', { path: rootPath, kinds: kinds.join(',') });
      for (const file of result.files) file.root = rootPath;
      return result.files;
    };
    source.urlFor = (fileOrPath) =>
      mediaUrl(typeof fileOrPath === 'string' ? fileOrPath : fileOrPath.path);

    /** Asks the server for the tags of the files that have none yet, a few hundred at a time. */
    source.loadTags = async (files, onProgress) => {
      const BATCH_SIZE = 300;
      const untagged = files.filter((file) => !file.tags);
      for (let start = 0; start < untagged.length; start += BATCH_SIZE) {
        const batch = untagged.slice(start, start + BATCH_SIZE);
        try {
          const tagsByPath = await postJson('tags', { paths: batch.map((file) => file.path) });
          for (const file of batch) file.tags = tagsByPath[file.path] || {};
        } catch (error) {
          reportProblem('Reading tags from the server', error);
          for (const file of batch) file.tags = {};
        }
        if (onProgress) onProgress(Math.min(untagged.length, start + BATCH_SIZE), untagged.length);
      }
      return files;
    };

    source.coverUrl = async (record) => {
      const hasCover = record && record.tags && (record.tags.cover || record.tags.folderCover);
      return hasCover ? apiUrl('cover', { path: record.path }) : null;
    };
    source.loadTracks = async (record) => {
      const response = await fetch(apiUrl('tracks', { path: record.path }));
      return response.ok ? response.json() : { subs: [], audio: [], chapters: [], sidecar: false };
    };
    source.subtitleUrl = async (record, choice) => {
      const parameters =
        choice === 'file' ? { path: record.path } : { path: record.path, track: choice };
      const url = apiUrl('subs', parameters);
      const response = await fetch(url);
      return response.ok ? url : null;
    };

    source.listComputer = async () => {
      const [drives, home] = await Promise.all([getJson('drives'), getJson('home')]);
      const items = drives.map((drive) => {
        const label = `Local Disk (${drive.name})`;
        const usedPercent = drive.total ? Math.round((1 - drive.free / drive.total) * 100) : null;
        const spaceNote = drive.total
          ? `${formatBytes(drive.free)} free of ${formatBytes(drive.total)}`
          : '';
        return {
          label,
          kind: 'drive',
          path: drive.path,
          title: [label, spaceNote],
          badge: usedPercent === null ? null : `${usedPercent}%`,
        };
      });
      for (const folder of home.special) {
        items.push({
          label: folder.name,
          kind: 'dir',
          path: folder.path,
          title: [folder.name, folder.path],
        });
      }
      if (home.onedrive) {
        items.push({
          label: 'OneDrive',
          kind: 'dir',
          path: home.onedrive,
          title: ['OneDrive', home.onedrive],
        });
      }
      return { items, status: `${home.user} on ${home.host}` };
    };

    /** The library folders of the Kiyora desktop app, or null when it is not installed. */
    source.loadKiyoraFolders = async () => {
      try {
        return await getJson('kiyora');
      } catch {
        return null;
      }
    };

    return source;
  }

  // ---------------------------------------------------------------- choosing a source

  /** @returns {Promise<boolean>} whether this page is being served by server.js */
  async function isServerAvailable() {
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), SERVER_PROBE_TIMEOUT_MS);
    try {
      const response = await fetch('/api/home', { signal: abortController.signal });
      return response.ok && (response.headers.get('content-type') || '').includes('json');
    } catch {
      return false; // opened from disk or from a plain web host: no server
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Chooses the source: the server when the page comes from server.js, unless the user
   * asked for browser folders in Settings; otherwise the local source.
   */
  async function detect() {
    const prefersLocal = localStorage.getItem(MODE_KEY) === 'local';
    if (!prefersLocal && (await isServerAvailable())) return createServerSource();
    return createLocalSource();
  }

  return { detect, isServerAvailable };
})();
