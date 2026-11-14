'use strict';
/* music-screen.js — My Music: albums, artists, songs and genres built from the tags in the
   files, plus the album, artist, song list, now-playing and queue screens. */

/** Starts a list of tracks and shows the now-playing screen. */
function playTracks(tracks, startIndex = 0, shuffled = false) {
  if (tracks.length === 0) return;
  musicPlayer.playQueue(tracks, startIndex, shuffled);
  openScreen(createNowPlayingScreen());
}

/** @returns {boolean} whether a track is the one that is playing */
function isCurrentTrack(track) {
  const current = musicPlayer.currentTrack();
  return Boolean(current && current.path === track.path);
}

/**
 * Groups tracks into albums. Two tracks belong together when album and album artist match.
 * @param {object[]} tracks
 * @returns {Array<{ title: string, artist: string, year: string, tracks: object[], coverFile: object|null, mtime: number }>}
 */
function groupIntoAlbums(tracks) {
  const albumsByKey = new Map();
  for (const track of tracks) {
    const albumKey = `${track.albumArtist}|${track.album}`.toLowerCase();
    if (!albumsByKey.has(albumKey)) {
      albumsByKey.set(albumKey, {
        title: track.album,
        artist: track.albumArtist,
        year: track.year,
        tracks: [],
        coverFile: null, // the first file of the album that carries a cover picture
        mtime: 0,
      });
    }
    const album = albumsByKey.get(albumKey);
    album.tracks.push(track);
    if (!album.coverFile && track.hasCover) album.coverFile = track.file;
    album.mtime = Math.max(album.mtime, track.mtime);
  }
  const albums = [...albumsByKey.values()];
  for (const album of albums) {
    album.tracks.sort(
      (first, second) =>
        first.discNumber - second.discNumber ||
        (first.trackNumber ?? Infinity) - (second.trackNumber ?? Infinity) ||
        naturalCompare(first.name, second.name),
    );
  }
  return albums;
}

/**
 * Groups things under a name, ignoring upper and lower case.
 * @param {object[]} things
 * @param {(thing: object) => string} nameOf
 * @returns {Array<{ name: string, members: object[] }>} sorted by name
 */
function groupByName(things, nameOf) {
  const groups = new Map();
  for (const thing of things) {
    const name = nameOf(thing);
    const key = name.toLowerCase();
    if (!groups.has(key)) groups.set(key, { name, members: [] });
    groups.get(key).members.push(thing);
  }
  return [...groups.values()].sort((first, second) => naturalCompare(first.name, second.name));
}

/** A tile for an album; its picture is the cover embedded in the files. */
function createAlbumTile(album) {
  const yearNote = album.year ? ` · ${album.year}` : '';
  return {
    label: album.title,
    kind: 'album',
    thumb: album.coverFile ? () => mediaSource.coverUrl(album.coverFile) : null,
    title: [album.title, `${album.artist}${yearNote} · ${pluralize(album.tracks.length, 'song')}`],
    run: () => openScreen(createAlbumScreen(album)),
  };
}

/**
 * A row for a song.
 * @param {object} track
 * @param {object[]} playlist the list it belongs to; choosing the row plays from there
 */
function createSongRow(track, playlist) {
  return {
    label: track.title,
    sub: track.artist,
    kind: 'audio',
    meta: track.duration ? formatTime(track.duration) : '',
    title: [track.title, `${track.artist} · ${track.album}`],
    isPlaying: () => isCurrentTrack(track), // read each time the row is drawn
    run: () => playTracks(playlist, playlist.indexOf(track)),
  };
}

/** @returns {object} the My Music screen */
function createMusicScreen() {
  const roots = appState.roots.music || [];
  const NOTHING_FOUND =
    'Unable to view your music. Either the folders contain no audio files, or they could not be read.';
  let tracks = [];
  let albums = [];
  let view = 'albums'; // 'albums', 'artists', 'songs' or 'genres'

  const screen = createBrowseScreen({
    watermark: 'music',
    sectionLabel: 'MY MUSIC',
    title: ['My Music', ''],
    view: 'tiles',
    modes: [],
    searchable: true,
    loading: 'Looking through your music folders',
  });

  const selectView = (newView) => () => {
    view = newView;
    showItems();
  };
  const buildModes = () =>
    withAddFolderMode(
      [
        { label: 'Albums', isOn: view === 'albums', run: selectView('albums') },
        { label: 'Artists', isOn: view === 'artists', run: selectView('artists') },
        { label: 'Songs', isOn: view === 'songs', run: selectView('songs') },
        { label: 'Genres', isOn: view === 'genres', run: selectView('genres') },
        { label: 'Shuffle all', run: () => playTracks(tracks, 0, true) },
      ],
      addFolder,
      roots.length === 0,
    );

  const createArtistTile = (artist) => {
    const albumWithCover = artist.members.find((album) => album.coverFile);
    return {
      label: artist.name,
      kind: 'album',
      thumb: albumWithCover ? () => mediaSource.coverUrl(albumWithCover.coverFile) : null,
      title: [artist.name, pluralize(artist.members.length, 'album')],
      run: () => openScreen(createArtistScreen(artist.name, artist.members)),
    };
  };
  const createGenreRow = (genre) => ({
    label: genre.name,
    kind: 'audio',
    meta: String(genre.members.length),
    title: [genre.name, pluralize(genre.members.length, 'song')],
    run: () => openScreen(createSongListScreen(genre.name, genre.members)),
  });

  function showItems() {
    if (roots.length === 0) return;
    const changes = { modes: buildModes(), empty: NOTHING_FOUND };
    switch (view) {
      case 'artists':
        changes.view = 'tiles';
        changes.items = groupByName(albums, (album) => album.artist).map(createArtistTile);
        break;
      case 'songs': {
        const songs = tracks
          .slice()
          .sort((first, second) => naturalCompare(first.title, second.title));
        changes.view = 'rows';
        changes.items = songs.map((track) => createSongRow(track, songs));
        break;
      }
      case 'genres':
        changes.view = 'rows';
        changes.items = groupByName(tracks, (track) => track.genre).map(createGenreRow);
        break;
      default:
        changes.view = 'tiles';
        changes.items = albums
          .slice()
          .sort((first, second) => naturalCompare(first.title, second.title))
          .map(createAlbumTile);
        break;
    }
    screen.updateSpec(changes);
  }

  async function loadLibrary() {
    if (roots.length === 0) {
      screen.updateSpec({
        loading: null,
        empty: describeMissingRoots('Music'),
        modes: buildModes(),
      });
      return;
    }
    const files = await scanRoots(roots, ['audio']);
    await mediaSource.loadTags(files, (doneCount, totalCount) => {
      // reading tags is the slow part, so show how far it has got
      const loadingNote = screen.element && selectElement('.loading-note', screen.element);
      if (currentScreen === screen && loadingNote) {
        loadingNote.textContent = `Reading tags — ${doneCount} of ${totalCount}`;
      }
    });
    tracks = files.map(trackFromFile);
    albums = groupIntoAlbums(tracks);
    screen.updateSpec({
      loading: null,
      status: `${pluralize(tracks.length, 'song')} · ${pluralize(albums.length, 'album')}`,
    });
    showItems();
  }

  screen.onTrackChange = () => {
    if (view === 'songs') screen.repaintItems();
  };

  function showLoadProblem(error) {
    reportProblem('Loading My Music', error);
    screen.updateSpec({
      loading: null,
      empty: { title: 'Your music could not be read.', hint: error.message },
    });
  }

  /** Asks for another folder for this library and reads the library again. */
  async function addFolder() {
    if (!mediaSource.local) {
      openScreen(createComputerScreen()); // in server mode a folder is chosen from the drives
      return;
    }
    if (!(await pickFolderIntoLibraries('music'))) return;
    screen.updateSpec({ loading: 'Looking through your music folders', items: [] });
    await loadLibrary().catch(showLoadProblem);
  }

  loadLibrary().catch(showLoadProblem);
  return screen;
}

/** The track list of one album. */
function createAlbumScreen(album) {
  const screen = createBrowseScreen({
    watermark: 'music',
    sectionLabel: album.artist,
    title: [album.title, album.artist],
    view: 'rows',
    numbered: true,
    modes: [
      { label: 'Play album', run: () => playTracks(album.tracks) },
      { label: 'Shuffle album', run: () => playTracks(album.tracks, 0, true) },
      {
        label: 'Add to queue',
        run: () => {
          if (musicPlayer.playback.queue.length === 0) {
            playTracks(album.tracks);
          } else {
            musicPlayer.addToQueue(album.tracks);
            showToast(`Queued ${pluralize(album.tracks.length, 'song')}`);
          }
        },
      },
    ],
    items: album.tracks.map((track, index) => ({
      ...createSongRow(track, album.tracks),
      number: track.trackNumber ?? index + 1,
      sub: null, // the artist is already in the heading
    })),
  });

  if (album.coverFile) {
    mediaSource
      .coverUrl(album.coverFile)
      .then((coverUrl) => {
        if (!coverUrl) return;
        screen.spec.heroUrl = coverUrl;
        screen.paint();
      })
      .catch((error) => reportProblem(`Reading the cover of ${album.title}`, error));
  }
  screen.onTrackChange = () => screen.repaintItems(); // moves the "playing" bars
  return screen;
}

/** The albums of one artist, oldest first. */
function createArtistScreen(artistName, artistAlbums) {
  const allTracks = () => artistAlbums.flatMap((album) => album.tracks);
  const byYearThenTitle = (first, second) =>
    (first.year || '9999').localeCompare(second.year || '9999') ||
    naturalCompare(first.title, second.title);
  return createBrowseScreen({
    watermark: 'music',
    sectionLabel: 'ARTISTS',
    title: [artistName, pluralize(artistAlbums.length, 'album')],
    view: 'tiles',
    modes: [
      { label: 'Play all', run: () => playTracks(allTracks()) },
      { label: 'Shuffle all', run: () => playTracks(allTracks(), 0, true) },
    ],
    items: artistAlbums.slice().sort(byYearThenTitle).map(createAlbumTile),
  });
}

/** A plain list of songs, used for a genre. */
function createSongListScreen(listName, tracks) {
  const songs = tracks.slice().sort((first, second) => naturalCompare(first.title, second.title));
  const screen = createBrowseScreen({
    watermark: 'music',
    sectionLabel: 'GENRES',
    title: [listName, pluralize(songs.length, 'song')],
    view: 'rows',
    modes: [
      { label: 'Play all', run: () => playTracks(songs) },
      { label: 'Shuffle', run: () => playTracks(songs, 0, true) },
    ],
    items: songs.map((track) => createSongRow(track, songs)),
  });
  screen.onTrackChange = () => screen.repaintItems(); // moves the "playing" bars
  return screen;
}

/** The queue: what is lined up to play, in order. */
function createQueueScreen() {
  const queue = musicPlayer.playback.queue;
  const screen = createBrowseScreen({
    watermark: 'music',
    sectionLabel: 'NOW PLAYING',
    title: ['Queue', pluralize(queue.length, 'song')],
    view: 'rows',
    numbered: true,
    modes: [
      {
        label: 'Clear queue',
        run: () => {
          musicPlayer.stop();
          goBack();
        },
      },
    ],
    items: queue.map((track, index) => ({
      ...createSongRow(track, queue),
      number: index + 1,
      run: () => {
        musicPlayer.playQueue(queue, index, false);
        goBack();
      },
    })),
  });
  screen.onTrackChange = () => screen.repaintItems(); // moves the "playing" bars
  return screen;
}

/** The now-playing screen: cover, title, spectrum and the playback commands. */
function createNowPlayingScreen() {
  const SPECTRUM_BARS = 40;
  const screen = { isNowPlaying: true, modeIndex: 0, animationFrame: 0, element: null };

  const buildModes = () => {
    const { shuffle: isShuffled, repeat } = musicPlayer.playback;
    const repeatNote = { off: '', all: ' all', one: ' one' }[repeat];
    return [
      {
        label: musicPlayer.audio.paused ? 'Play' : 'Pause',
        run: () => musicPlayer.togglePlayback(),
      },
      { label: 'View queue', run: () => openScreen(createQueueScreen()) },
      { label: 'Shuffle', isOn: isShuffled, run: () => musicPlayer.setShuffle(!isShuffled) },
      {
        label: `Repeat${repeatNote}`,
        isOn: repeat !== 'off',
        run: () => musicPlayer.cycleRepeat(),
      },
      {
        label: 'Visualizer',
        isOn: getSetting('visualizer'),
        run: () => saveSettings({ visualizer: !getSetting('visualizer') }),
      },
      {
        label: 'Stop',
        run: () => {
          musicPlayer.stop();
          goBack();
        },
      },
    ];
  };

  function paint() {
    screen.element.querySelectorAll('.mode-item').forEach((modeItem, index) => {
      modeItem.classList.toggle('is-focused', index === screen.modeIndex);
    });
  }

  /** Runs a command and redraws, since most of them change a label or a dot. */
  function runMode(mode) {
    mode.run();
    if (currentScreen === screen) screen.render();
  }

  /** Draws the time, the progress bar and the spectrum; repeats every frame. */
  function drawFrame() {
    if (!screen.element || !screen.element.isConnected) return;
    const audio = musicPlayer.audio;
    const canvas = selectElement('.now-playing-spectrum', screen.element);
    const context = canvas.getContext('2d');
    const total = audio.duration ? ` / ${formatTime(audio.duration)}` : '';
    selectElement('.time-value', screen.element).textContent =
      formatTime(audio.currentTime) + total;
    const progress = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
    selectElement('.now-playing-fill', screen.element).style.width = `${progress}%`;

    context.clearRect(0, 0, canvas.width, canvas.height);
    if (getSetting('visualizer')) {
      const levels = musicPlayer.readSpectrum(SPECTRUM_BARS);
      const barWidth = canvas.width / SPECTRUM_BARS;
      const accentColor =
        getComputedStyle(document.body).getPropertyValue('--green').trim() || '#B6EE6C';
      for (let bar = 0; bar < SPECTRUM_BARS; bar++) {
        const level = levels ? levels[bar] : 0;
        const barHeight = levels ? level * (canvas.height - 4) : 2;
        const left = bar * barWidth + 2;
        context.fillStyle = `rgba(255, 255, 255, ${0.35 + level * 0.55})`;
        context.fillRect(left, canvas.height - barHeight, barWidth - 4, barHeight);
        context.fillStyle = accentColor; // a cap in the theme's accent colour
        context.fillRect(left, canvas.height - barHeight - 2, barWidth - 4, 2);
      }
    }
    screen.animationFrame = requestAnimationFrame(drawFrame);
  }

  screen.render = () => {
    const track = musicPlayer.currentTrack();
    const element = cloneTemplate('now-playing-template');
    screen.element = element;
    selectElement('.title-main', element).textContent = track ? track.title : 'Nothing playing';
    selectElement('.title-sub', element).textContent = track
      ? `${track.artist} · ${track.album}`
      : '';

    const modeList = selectElement('.mode-list', element);
    const modes = buildModes();
    screen.modeIndex = clamp(screen.modeIndex, 0, modes.length - 1);
    modes.forEach((mode, index) => {
      const modeItem = cloneTemplate('mode-template');
      selectElement('.mode-label', modeItem).textContent = mode.label;
      if (mode.isOn !== undefined) {
        const dot = selectElement('.mode-dot', modeItem);
        dot.hidden = false;
        dot.classList.toggle('is-on', Boolean(mode.isOn));
      }
      modeItem.addEventListener('mouseenter', () => {
        screen.modeIndex = index;
        paint();
      });
      modeItem.addEventListener('click', () => {
        screen.modeIndex = index;
        runMode(mode);
      });
      modeList.appendChild(modeItem);
    });

    const cover = selectElement('.now-playing-cover', element);
    const glyph = selectElement('.now-playing-glyph', element);
    setIcon(glyph, 'disc');
    cover.addEventListener('error', () => {
      cover.hidden = true;
      glyph.hidden = false;
    });
    if (track && track.coverUrl) {
      cover.src = track.coverUrl;
      cover.alt = `Cover of ${track.album}`;
      cover.hidden = false;
      glyph.hidden = true;
      element.style.setProperty('--hero', `url("${track.coverUrl}")`);
    }
    const yearNote = track && track.year ? ` · ${track.year}` : '';
    selectElement('.track-title', element).textContent = track ? track.title : '';
    selectElement('.track-artist', element).textContent = track ? `${track.artist}${yearNote}` : '';

    // a click on the progress bar seeks
    const progressBar = selectElement('.now-playing-bar', element);
    progressBar.addEventListener('click', (event) => {
      const bar = progressBar.getBoundingClientRect();
      const audio = musicPlayer.audio;
      if (audio.duration)
        audio.currentTime = (audio.duration * (event.clientX - bar.left)) / bar.width;
    });

    mountScreen(element);
    paint();
    cancelAnimationFrame(screen.animationFrame);
    drawFrame();
  };

  screen.handleKey = (keyName) => {
    const modes = buildModes();
    switch (keyName) {
      case 'up':
        screen.modeIndex = Math.max(0, screen.modeIndex - 1);
        break;
      case 'down':
        screen.modeIndex = Math.min(modes.length - 1, screen.modeIndex + 1);
        break;
      case 'enter':
        runMode(modes[screen.modeIndex]);
        return true;
      case 'space':
        musicPlayer.togglePlayback();
        screen.render();
        return true;
      case 'right':
      case 'n':
        musicPlayer.next();
        return true;
      case 'left':
      case 'p':
        musicPlayer.previous();
        return true;
      case 'back':
        goBack();
        return true;
      default:
        return false;
    }
    paint();
    return true;
  };

  screen.leave = () => cancelAnimationFrame(screen.animationFrame);
  screen.onTrackChange = () => screen.render();
  return screen;
}
