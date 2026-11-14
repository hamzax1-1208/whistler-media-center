'use strict';
/* videos-screen.js — My Videos: the video files of the library folders grouped into
   series, and the episode list of one series. */

/** Folder names that hold extras rather than episodes (creditless openings, specials...). */
const EXTRAS_FOLDER =
  /^(nc|ncop|nced|ncs|extras?|specials?|ovas?|bonus|ops?|eds?|menus?|creditless|sp)$/i;
const SEASON_FOLDER = /^(?:season|s)\s*(\d{1,2})$/i;

/**
 * Works out which series a video belongs to and which episode it is, from its file name
 * and the folders above it.
 * @param {object} file a video file record
 * @param {(folder: string) => boolean} isLibraryRoot tells whether a folder is a library folder itself
 * @returns {{ seriesKey: string, seriesTitle: string, year: number|null, folder: string,
 *             season: number|null, episode: number|null, isExtra: boolean, isFilm: boolean,
 *             episodeTitle: string|null }}
 */
function classifyVideo(file, isLibraryRoot) {
  const parsed = parseEpisode(file.name);
  let folder = file.dir;
  let seriesKey;
  let release;
  let isExtra = false;
  let isLoose = false; // a film or clip lying directly in a library folder
  let folderSeason = null;

  if (isLibraryRoot(folder)) {
    if (parsed.episode !== null && hasExplicitEpisodeNumber(file.name)) {
      // an episode without a folder of its own: the series name is in the file name
      release = parseReleaseTitle(parsed.before || file.name);
      seriesKey = `title|${release.title.toLowerCase()}`;
    } else {
      // a film on its own: it gets a tile of its own, named after the file
      isLoose = true;
      release = parseReleaseTitle(file.name);
      seriesKey = `file|${file.path.toLowerCase()}`;
    }
  } else {
    // climb out of "Extras" and "Season 2" folders to reach the series folder
    let folderName = baseName(folder);
    if (EXTRAS_FOLDER.test(folderName) && !isLibraryRoot(directoryName(folder))) {
      isExtra = true;
      folder = directoryName(folder);
      folderName = baseName(folder);
    }
    const seasonMatch = SEASON_FOLDER.exec(folderName);
    if (seasonMatch && !isLibraryRoot(directoryName(folder))) {
      folderSeason = Number(seasonMatch[1]);
      folder = directoryName(folder);
      folderName = baseName(folder);
    }
    release = parseReleaseTitle(folderName);
    seriesKey = `title|${release.title.toLowerCase()}`;
  }

  let episodeTitle = '';
  if (isLoose) episodeTitle = release.title;
  else if (parsed.after) episodeTitle = parseReleaseTitle(parsed.after).title;
  if (!episodeTitle || /^v\d$/i.test(episodeTitle)) episodeTitle = null; // "v2" is a version, not a title

  // the season can be in the file name, the folder name, or the series name
  let season = null;
  if (!isLoose) {
    const seasonInName = parsed.before ? parseReleaseTitle(parsed.before).season : null;
    season = parsed.season ?? folderSeason ?? seasonInName ?? release.season ?? null;
  }

  return {
    seriesKey,
    seriesTitle: release.title,
    year: release.year,
    folder,
    season,
    episode: isExtra || isLoose ? null : parsed.episode,
    isExtra,
    isFilm: isLoose,
    episodeTitle,
  };
}

/** Sorts episodes by season, then number, then file name; unnumbered ones go last. */
function compareEpisodes(first, second) {
  return (
    (first.season || 0) - (second.season || 0) ||
    (first.episode ?? Infinity) - (second.episode ?? Infinity) ||
    naturalCompare(first.name, second.name)
  );
}

/**
 * Groups video files into series.
 * @param {object[]} files video file records; each gets season, episode, isExtra and episodeTitle added
 * @param {string[]} roots the video library folders
 * @returns {Array<{ title: string, year: number|null, dir: string, isFilm: boolean,
 *                   episodes: object[], mtime: number }>}
 */
function groupIntoSeries(files, roots) {
  const normalize = (folder) => folder.replace(/[\\/]+$/, '').toLowerCase();
  const normalizedRoots = roots.map(normalize);
  const isLibraryRoot = (folder) => normalizedRoots.includes(normalize(folder));

  const seriesByKey = new Map();
  for (const file of files) {
    const details = classifyVideo(file, isLibraryRoot);
    if (!seriesByKey.has(details.seriesKey)) {
      seriesByKey.set(details.seriesKey, {
        title: details.seriesTitle,
        year: details.year,
        dir: details.folder,
        isFilm: details.isFilm, // a single film rather than a series
        episodes: [],
        mtime: 0,
      });
    }
    const series = seriesByKey.get(details.seriesKey);
    Object.assign(file, {
      season: details.season,
      episode: details.episode,
      isExtra: details.isExtra,
      episodeTitle: details.episodeTitle,
    });
    series.episodes.push(file);
    series.mtime = Math.max(series.mtime, file.mtime);
  }

  const allSeries = [...seriesByKey.values()];
  for (const series of allSeries) series.episodes.sort(compareEpisodes);
  return allSeries;
}

/** What an episode is called in lists and in the player. */
function episodeLabel(file) {
  if (file.episodeTitle) return file.episodeTitle;
  if (file.episode !== null && file.episode !== undefined) return `Episode ${file.episode}`;
  return parseReleaseTitle(file.name).title;
}

/** Turns a video file into an entry of the player's queue. */
function toPlayerItem(file) {
  return {
    file,
    path: file.path,
    label: episodeLabel(file),
    series: file.seriesTitle || folderDisplayName(file.dir),
  };
}

/**
 * Builds the row of one episode.
 * @param {object} file the episode's file record
 * @param {object[]} queue the list it plays in, so Next goes to the following episode
 */
function createEpisodeRow(file, queue) {
  const tags = file.tags || {};
  const label = episodeLabel(file);

  let number = null;
  if (file.episode !== null && file.episode !== undefined) {
    const paddedEpisode = String(file.episode).padStart(2, '0');
    number = file.season ? `${file.season}×${paddedEpisode}` : paddedEpisode;
  }
  const details = [file.seriesTitle || folderDisplayName(file.dir)];
  if (tags.width) details.push(`${tags.width}×${tags.height}`);
  if (tags.codec) details.push(tags.codec);

  return {
    label,
    number,
    kind: 'video',
    mark: () => resumeMark(file.path), // the dot in front of the row; read each time it is drawn
    meta: tags.duration ? formatTime(tags.duration) : formatDate(file.mtime),
    title: [label, details.join(' · ')],
    run: () => videoPlayer.open(queue.map(toPlayerItem), queue.indexOf(file)),
  };
}

/** @returns {object} the My Videos screen */
function createVideosScreen() {
  const roots = appState.roots.videos || [];
  const NOTHING_FOUND = 'No videos found in your folders.';
  let files = [];
  let allSeries = [];
  let view = 'series'; // 'series', 'folders' or 'recent'
  let sortBy = 'name'; // 'name' or 'date'

  const screen = createBrowseScreen({
    watermark: 'videos',
    sectionLabel: 'MY VIDEOS',
    title: ['My Videos', ''],
    view: 'tiles',
    modes: [],
    searchable: true,
    loading: 'Looking through your video folders',
  });

  const selectView = (newView) => () => {
    view = newView;
    showItems();
  };
  const selectSort = (newSort) => () => {
    sortBy = newSort;
    showItems();
  };
  const buildModes = () =>
    withAddFolderMode(
      [
        { label: 'Series', isOn: view === 'series', run: selectView('series') },
        { label: 'Folders', isOn: view === 'folders', run: selectView('folders') },
        { label: 'Recently added', isOn: view === 'recent', run: selectView('recent') },
        { label: 'Sort by name', isOn: sortBy === 'name', run: selectSort('name') },
        { label: 'Sort by date', isOn: sortBy === 'date', run: selectSort('date') },
      ],
      addFolder,
      roots.length === 0,
    );

  const compareGroups = (first, second) =>
    sortBy === 'date' ? second.mtime - first.mtime : naturalCompare(first.title, second.title);

  /** A tile for a film, a series or a folder; its picture is a frame of the first video. */
  const createGroupTile = (group) => {
    if (group.isFilm) {
      // a film has nothing to list: its tile plays it
      const film = group.episodes[0];
      return {
        label: group.title,
        kind: 'video',
        title: [group.title, group.year ? `Film · ${group.year}` : 'Film'],
        thumb: () => videoThumbnails.forVideo(film),
        run: () => videoPlayer.open([toPlayerItem(film)], 0),
      };
    }
    const episodeCount = group.episodes.length;
    const yearNote = group.year ? ` · ${group.year}` : '';
    return {
      label: group.title,
      kind: 'video',
      title: [group.title, `${pluralize(episodeCount, 'episode')}${yearNote}`],
      thumb: () => videoThumbnails.forVideo(group.episodes[0]),
      badge: String(episodeCount),
      run: () => openScreen(createEpisodesScreen(group)),
    };
  };

  /** The line at the bottom: how many videos, and how many series and films they make. */
  function describeLibrary() {
    const filmCount = allSeries.filter((group) => group.isFilm).length;
    const seriesCount = allSeries.length - filmCount;
    const parts = [pluralize(files.length, 'video')];
    if (seriesCount > 0) parts.push(`${seriesCount} series`);
    if (filmCount > 0) parts.push(pluralize(filmCount, 'film'));
    return parts.join(' · ');
  }

  /** The videos grouped by the folder they are in, ignoring the series detection. */
  function groupByFolder() {
    const folders = new Map();
    for (const file of files) {
      if (!folders.has(file.dir)) {
        folders.set(file.dir, {
          title: folderDisplayName(file.dir),
          dir: file.dir,
          episodes: [],
          mtime: 0,
        });
      }
      const folder = folders.get(file.dir);
      folder.episodes.push(file);
      folder.mtime = Math.max(folder.mtime, file.mtime);
    }
    return [...folders.values()];
  }

  function showItems() {
    if (roots.length === 0) return;
    const changes = { modes: buildModes(), empty: NOTHING_FOUND };
    switch (view) {
      case 'recent': {
        const RECENT_LIMIT = 60;
        const recentFiles = files
          .slice()
          .sort((first, second) => second.mtime - first.mtime)
          .slice(0, RECENT_LIMIT);
        changes.view = 'rows';
        changes.items = recentFiles.map((file) => createEpisodeRow(file, recentFiles));
        break;
      }
      case 'folders':
        changes.view = 'tiles';
        changes.items = groupByFolder().sort(compareGroups).map(createGroupTile);
        break;
      default:
        changes.view = 'tiles';
        changes.items = allSeries.slice().sort(compareGroups).map(createGroupTile);
        break;
    }
    screen.updateSpec(changes);
  }

  async function loadLibrary() {
    if (roots.length === 0) {
      screen.updateSpec({
        loading: null,
        empty: describeMissingRoots('Videos'),
        modes: buildModes(),
      });
      return;
    }
    files = await scanRoots(roots, ['video']);
    allSeries = groupIntoSeries(files, roots);
    screen.updateSpec({
      loading: null,
      status: describeLibrary(),
    });
    showItems();
  }

  function showLoadProblem(error) {
    reportProblem('Loading My Videos', error);
    screen.updateSpec({
      loading: null,
      empty: { title: 'Your videos could not be read.', hint: error.message },
    });
  }

  /** Asks for another folder for this library and reads the library again. */
  async function addFolder() {
    if (!mediaSource.local) {
      openScreen(createComputerScreen()); // in server mode a folder is chosen from the drives
      return;
    }
    if (!(await pickFolderIntoLibraries('videos'))) return;
    screen.updateSpec({ loading: 'Looking through your video folders', items: [] });
    await loadLibrary().catch(showLoadProblem);
  }

  loadLibrary().catch(showLoadProblem);
  return screen;
}

/**
 * The episode list of one series (or of one folder).
 * @param {{ title: string, episodes: object[] }} series
 * @returns {object} the screen
 */
function createEpisodesScreen(series) {
  const episodes = series.episodes;
  let sortBy = 'episode'; // 'episode', 'name' or 'date'
  for (const episode of episodes) episode.seriesTitle = series.title;

  const screen = createBrowseScreen({
    watermark: 'videos',
    sectionLabel: series.title,
    title: [series.title, pluralize(episodes.length, 'episode')],
    view: 'rows',
    numbered: true,
    modes: [],
  });

  const isWatched = (episode) =>
    Boolean(appState.resume[episode.path] && appState.resume[episode.path].done);
  const selectSort = (newSort) => () => {
    sortBy = newSort;
    showEpisodes();
  };

  async function markAllWatched() {
    const question = `Mark all ${episodes.length} episodes of ${series.title} as watched?`;
    if (!(await confirmAction('MARK AS WATCHED', question))) return;
    for (const episode of episodes) await saveResumePoint(episode.path, { t: 0, done: true });
    showEpisodes();
  }

  const buildModes = () => [
    {
      label: 'Play',
      run: () => {
        // carry on with the first episode that has not been watched
        const nextEpisode = episodes.find((episode) => !isWatched(episode)) || episodes[0];
        videoPlayer.open(episodes.map(toPlayerItem), episodes.indexOf(nextEpisode));
      },
    },
    { label: 'Play from start', run: () => videoPlayer.open(episodes.map(toPlayerItem), 0) },
    { label: 'Sort by episode', isOn: sortBy === 'episode', run: selectSort('episode') },
    { label: 'Sort by name', isOn: sortBy === 'name', run: selectSort('name') },
    { label: 'Sort by date', isOn: sortBy === 'date', run: selectSort('date') },
    { label: 'Mark all as watched', run: markAllWatched },
  ];

  function showEpisodes() {
    const sorted = episodes.slice(); // already in episode order
    if (sortBy === 'name') {
      sorted.sort((first, second) =>
        naturalCompare(first.episodeTitle || first.name, second.episodeTitle || second.name),
      );
    } else if (sortBy === 'date') {
      sorted.sort((first, second) => first.mtime - second.mtime);
    }
    screen.updateSpec({
      modes: buildModes(),
      items: sorted.map((file) => createEpisodeRow(file, sorted)),
    });
  }

  showEpisodes();
  // durations and resolutions appear once the files' headers have been read
  mediaSource
    .loadTags(episodes)
    .then(showEpisodes)
    .catch((error) => reportProblem(`Reading the details of ${series.title}`, error));
  return screen;
}
