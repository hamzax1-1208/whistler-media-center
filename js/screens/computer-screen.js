'use strict';
/* computer-screen.js — My Computer: the folders the user opened (or, in server mode, the
   drives of the PC), and a file browser for any folder. A folder that is opened goes into
   the libraries it has files for by itself; "Use as Videos / Music / Pictures folder" in the
   file browser changes that by hand, also for a folder inside it. */

/**
 * Asks the user for a folder and reports a refusal in a message box.
 * @returns {Promise<{ path: string, name: string }|null>} null when nothing was picked
 */
async function pickFolderWithFeedback() {
  try {
    return await mediaSource.pickFolder();
  } catch (error) {
    reportProblem('Opening a folder', error);
    await showMessage('Folder access', error.message);
    return null;
  }
}

/**
 * Asks the user for a folder and puts it into the libraries it has files for, so it shows
 * up in My Videos, My Music and My Pictures without another step. A toast says where it went.
 * @param {string} [wantedKind] 'videos', 'music' or 'pictures' when the user is adding a
 *   folder to that library in particular
 * @returns {Promise<{ path: string, name: string }|null>} null when nothing was picked
 */
async function pickFolderIntoLibraries(wantedKind) {
  const folder = await pickFolderWithFeedback();
  if (!folder) return null;
  scanCache.clear();
  showToast(await addFolderToLibraries(folder, wantedKind), 3500);
  return folder;
}

/** @returns {object} the My Computer screen */
function createComputerScreen() {
  const screen = createBrowseScreen({
    watermark: 'computer',
    sectionLabel: 'MY COMPUTER',
    title: ['My Computer', ''],
    view: 'tiles',
    modes: [],
    loading: mediaSource.local ? 'Looking at the folders you opened' : 'Looking for drives',
  });

  async function openFolderPicker() {
    if (await pickFolderIntoLibraries()) await loadPlaces();
  }

  const buildModes = () => {
    const modes = [{ label: 'Refresh', run: loadPlaces }];
    if (mediaSource.local) modes.unshift({ label: 'Open a folder…', run: openFolderPicker });
    return modes;
  };

  /** What happens when a tile is chosen: open the folder, pick one, or reconnect a lost one. */
  async function openPlace(place) {
    if (place.action === 'pick') {
      await openFolderPicker();
      return;
    }
    if (place.missing) {
      const reconnected = await mediaSource.reconnectMissing(place.label);
      if (!reconnected) {
        showToast('Not reconnected', 1200);
        return;
      }
      scanCache.clear();
    }
    openScreen(createFolderScreen(place.path));
  }

  async function loadPlaces() {
    try {
      const computer = await mediaSource.listComputer();
      const items = computer.items.map((place) => ({
        ...place,
        badge: place.missing ? '?' : place.badge,
        run: () => openPlace(place),
      }));
      screen.updateSpec({
        loading: null,
        modes: buildModes(),
        items,
        status: computer.status,
        empty: mediaSource.local
          ? 'Nothing opened yet. Choose Open a folder… on the left, or drop a folder onto this page.'
          : 'No drives found.',
      });
    } catch (error) {
      reportProblem('Loading My Computer', error);
      screen.updateSpec({
        loading: null,
        modes: buildModes(),
        empty: { title: 'This PC could not be read.', hint: error.message },
      });
    }
  }

  loadPlaces();
  return screen;
}

/**
 * The contents of one folder: subfolders and playable files.
 * @param {string} folderPath
 * @returns {object} the screen
 */
function createFolderScreen(folderPath) {
  const displayPath = mediaSource.displayPath(folderPath);
  const folderName = folderDisplayName(folderPath);
  const roots = appState.roots;
  let sortBy = 'name'; // 'name' or 'date'
  let listing = null; // { parent, entries } once the folder has been read

  const screen = createBrowseScreen({
    watermark: 'computer',
    sectionLabel: folderName.toUpperCase(),
    title: [folderName, displayPath],
    view: 'rows',
    modes: [],
    loading: 'Reading folder',
  });

  const samePath = (first, second) => first.toLowerCase() === second.toLowerCase();
  const isLibraryFolder = (kind) => roots[kind].some((root) => samePath(root, folderPath));
  const entriesOfKind = (kind) =>
    listing ? listing.entries.filter((entry) => entry.kind === kind) : [];

  /** Adds this folder to a library, or takes it out again; asks first either way. */
  async function toggleLibraryFolder({ kind, name }) {
    if (isLibraryFolder(kind)) {
      const question = `Stop showing "${displayPath}" in My ${name}? Nothing on disk is touched.`;
      if (!(await confirmAction(`REMOVE ${name.toUpperCase()} FOLDER`, question))) return;
      roots[kind] = roots[kind].filter((root) => !samePath(root, folderPath));
      showToast(`Removed from My ${name}`);
    } else {
      const question = `Add "${displayPath}" to your ${name} library? Everything inside it, including subfolders, will show up in My ${name}.`;
      if (!(await confirmAction(`USE AS ${name.toUpperCase()} FOLDER`, question))) return;
      roots[kind].push(folderPath);
      showToast(`Added to My ${name}`);
    }
    await saveRoots();
    scanCache.clear();
    screen.updateSpec({ modes: buildModes() });
  }

  async function forgetThisFolder() {
    const question = `Forget "${displayPath}"? The browser drops its access; nothing on disk is touched.`;
    if (!(await confirmAction('FORGET FOLDER', question))) return;
    await mediaSource.forgetFolder(folderPath);
    scanCache.clear();
    goBack();
  }

  const toFolderPlayerItem = (entry) => ({
    file: entry,
    path: entry.path,
    label: parseReleaseTitle(entry.name).title,
    series: folderName,
  });

  /** Plays the folder's music from one file on; the tags are read first for the titles. */
  async function playFolderMusic(audioEntries, startIndex) {
    await mediaSource.loadTags(audioEntries);
    playTracks(audioEntries.map(trackFromFile), startIndex);
  }

  const selectSort = (newSort) => () => {
    sortBy = newSort;
    showEntries();
  };

  function buildModes() {
    const videos = entriesOfKind('video');
    const songs = entriesOfKind('audio');
    const pictures = entriesOfKind('image');
    const modes = [];
    if (listing && listing.parent) modes.push({ label: 'Up one level', run: () => goBack() });
    modes.push(
      { label: 'Sort by name', isOn: sortBy === 'name', run: selectSort('name') },
      { label: 'Sort by date', isOn: sortBy === 'date', run: selectSort('date') },
    );
    if (videos.length > 0) {
      modes.push({
        label: `Play all videos (${videos.length})`,
        run: () => videoPlayer.open(videos.map(toFolderPlayerItem), 0),
      });
    }
    if (songs.length > 0) {
      modes.push({
        label: `Play all music (${songs.length})`,
        run: () => playFolderMusic(songs, 0),
      });
    }
    if (pictures.length > 0) {
      modes.push({
        label: `Slide show (${pictures.length})`,
        run: () => photoViewer.open(pictures, 0, true),
      });
    }
    for (const library of LIBRARIES) {
      modes.push({
        label: `Use as ${library.name} folder`,
        isOn: isLibraryFolder(library.kind),
        run: () => toggleLibraryFolder(library),
      });
    }
    // only a folder the user opened directly (not one inside it) can be forgotten
    if (mediaSource.local && !folderPath.includes('/')) {
      modes.push({ label: 'Forget this folder', run: forgetThisFolder });
    }
    return modes;
  }

  /** Folders first, then files; within each, by name or newest first. */
  function compareEntries(first, second) {
    const firstIsFolder = first.kind === 'dir';
    const secondIsFolder = second.kind === 'dir';
    if (firstIsFolder !== secondIsFolder) return firstIsFolder ? -1 : 1;
    if (sortBy === 'date') return (second.mtime || 0) - (first.mtime || 0);
    return naturalCompare(first.name, second.name);
  }

  function openEntry(entry, sortedEntries) {
    const ofSameKind = sortedEntries.filter((candidate) => candidate.kind === entry.kind);
    const position = ofSameKind.indexOf(entry);
    switch (entry.kind) {
      case 'dir':
        openScreen(createFolderScreen(entry.path));
        break;
      case 'video':
        videoPlayer.open(ofSameKind.map(toFolderPlayerItem), position);
        break;
      case 'audio':
        playFolderMusic(ofSameKind, position);
        break;
      case 'image':
        photoViewer.open(ofSameKind, position, false);
        break;
      default:
        break;
    }
  }

  function createEntryRow(entry, sortedEntries) {
    const isFolder = entry.kind === 'dir';
    return {
      label: entry.name,
      kind: entry.kind,
      meta: isFolder ? '' : formatBytes(entry.size),
      mark: entry.kind === 'video' ? () => resumeMark(entry.path) : null,
      title: isFolder
        ? [entry.name, mediaSource.displayPath(entry.path)]
        : [stripExtension(entry.name), `${formatDate(entry.mtime)} · ${formatBytes(entry.size)}`],
      run: () => openEntry(entry, sortedEntries),
    };
  }

  function showEntries() {
    const sortedEntries = listing.entries.slice().sort(compareEntries);
    screen.updateSpec({
      loading: null,
      modes: buildModes(),
      items: sortedEntries.map((entry) => createEntryRow(entry, sortedEntries)),
      empty: 'Nothing playable in this folder. Only folders and media files are shown.',
    });
  }

  mediaSource
    .listFolder(folderPath)
    .then((folderListing) => {
      listing = folderListing;
      showEntries();
    })
    .catch((error) => {
      reportProblem(`Opening ${displayPath}`, error);
      screen.updateSpec({
        loading: null,
        modes: [{ label: 'Up one level', run: () => goBack() }],
        empty: { title: "Can't open this folder.", hint: error.message },
      });
    });
  return screen;
}
