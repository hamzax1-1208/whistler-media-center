'use strict';
/* settings-screen.js — Settings: four pages (General, Look, Library folders, About) of rows
   whose value changes with Enter, plus the "Profile and preferences" form. */

/** @returns {object} the Settings screen */
function createSettingsScreen() {
  let page = 'general'; // 'general', 'look', 'library' or 'about'
  let kiyoraFolders = null; // library folders of the Kiyora desktop app, when the server finds them
  let serverIsRunning = false;

  const screen = createBrowseScreen({
    watermark: 'settings',
    sectionLabel: 'SETTINGS',
    title: ['Settings', ''],
    view: 'rows',
    modes: [],
  });

  const onOff = (enabled) => (enabled ? 'On' : 'Off');

  /**
   * Makes the action of a row that steps through a fixed set of values.
   * @param {string} settingName
   * @param {Array} values the values in the order Enter steps through them
   */
  const cycleSetting = (settingName, values) => async () => {
    const nextIndex = (values.indexOf(getSetting(settingName)) + 1) % values.length;
    await saveSettings({ [settingName]: values[nextIndex] });
    showPage();
  };

  /** Shorthand for a settings row. */
  const settingRow = (label, value, title, run, kind = 'gear') => ({
    label,
    value,
    kind,
    title,
    run,
  });

  // ---------------------------------------------------------------- the profile form

  async function editProfile() {
    const profile = await formPanel.openProfile();
    if (!profile) return; // cancelled
    await saveSettings(profile);
    setVolume(profile.volume, { announce: false, save: false });
    showToast(`Saved. Hello, ${profile.displayName}.`);
    showPage();
  }

  // ---------------------------------------------------------------- General

  async function forgetResumePoints() {
    const question = 'Forget where every video was stopped, and which ones were watched?';
    if (!(await confirmAction('FORGET RESUME POINTS', question))) return;
    for (const path of Object.keys(appState.resume)) await clearResumePoint(path);
    showPage();
  }

  function buildGeneralRows() {
    const languageCodes = SUBTITLE_LANGUAGES.map((language) => language.code);
    const preferredLanguage =
      SUBTITLE_LANGUAGES.find((language) => language.code === getSetting('subtitleLang')) ||
      SUBTITLE_LANGUAGES[0];
    let soundsValue = onOff(getSetting('sounds'));
    if (getSetting('sounds') && !uiSounds.isAvailable()) soundsValue = 'On (no files)';

    return [
      settingRow(
        'Clock',
        getSetting('clock24') ? '24-hour' : '12-hour',
        ['Clock', 'How the start screen shows the time'],
        cycleSetting('clock24', [false, true]),
      ),
      settingRow(
        'Slide show interval',
        `${getSetting('slideshowSeconds')} seconds`,
        ['Slide show', 'Seconds each picture stays up'],
        cycleSetting('slideshowSeconds', [3, 5, 8, 12, 20]),
      ),
      settingRow(
        'Pan and zoom pictures',
        onOff(getSetting('kenBurns')),
        ['Pan and zoom', 'Ken Burns drift during slide shows'],
        cycleSetting('kenBurns', [true, false]),
      ),
      settingRow(
        'Music visualizer',
        onOff(getSetting('visualizer')),
        ['Visualizer', 'Spectrum bars on the now-playing screen'],
        cycleSetting('visualizer', [true, false]),
      ),
      settingRow(
        'Play next episode automatically',
        onOff(getSetting('autoplayNext')),
        ['Autoplay', 'Continue to the next video when one ends'],
        cycleSetting('autoplayNext', [true, false]),
      ),
      settingRow(
        'Subtitles',
        getSetting('subtitles') === 'off' ? 'Off' : 'Automatic',
        ['Subtitles', 'Pick a track automatically when a video starts, or start with them off'],
        cycleSetting('subtitles', ['auto', 'off']),
      ),
      settingRow(
        'Preferred subtitle language',
        preferredLanguage.name,
        ['Subtitle language', 'Embedded track to prefer; the player menu can override per video'],
        cycleSetting('subtitleLang', languageCodes),
      ),
      settingRow(
        'Subtitle size',
        getSetting('subtitleSize') === 'large' ? 'Large' : 'Normal',
        ['Subtitle size', 'Cue text size in the video player'],
        cycleSetting('subtitleSize', ['normal', 'large']),
      ),
      settingRow(
        'The roast',
        onOff(getSetting('roast')),
        ['The roast', 'Declines reaction videos on principle, like Neptune does'],
        cycleSetting('roast', [true, false]),
      ),
      settingRow(
        'Sounds',
        soundsValue,
        [
          'Sounds',
          'Navigation tick and select note. Put focus.wav, select.wav, error.wav, intro.wav in assets/sounds/',
        ],
        cycleSetting('sounds', [true, false]),
      ),
      settingRow(
        'Forget resume points',
        String(Object.keys(appState.resume).length),
        ['Resume points', 'Where each video was stopped'],
        forgetResumePoints,
      ),
    ];
  }

  // ---------------------------------------------------------------- Look

  function buildLookRows() {
    const rows = Object.entries(THEMES).map(([themeId, theme]) =>
      settingRow(
        theme.name,
        currentThemeId() === themeId ? '●' : '',
        [theme.name, theme.description],
        async () => {
          await saveSettings({ theme: themeId });
          applyTheme();
          showPage();
          showToast(`Theme: ${theme.name}`, 1200);
        },
      ),
    );
    rows.push(
      settingRow(
        'Full screen',
        onOff(Boolean(document.fullscreenElement)),
        ['Full screen', 'F toggles this anywhere'],
        () => {
          toggleFullscreen();
          setTimeout(showPage, 300); // the browser needs a moment to switch
        },
      ),
    );
    // "Source" switches between reading folders in the browser and reading the PC through server.js
    if (mediaSource.local && serverIsRunning) {
      rows.push(
        settingRow(
          'Source',
          'Browser folders',
          ['Source', 'A server.js is running here too; switch to read the whole PC through it'],
          () => {
            localStorage.removeItem('whistler.mode');
            location.reload();
          },
          'drive',
        ),
      );
    }
    if (!mediaSource.local) {
      rows.push(
        settingRow(
          'Source',
          'This PC (server)',
          ['Source', 'Switch to folders you open in the browser; nothing installed'],
          () => {
            localStorage.setItem('whistler.mode', 'local');
            location.reload();
          },
          'drive',
        ),
      );
    }
    return rows;
  }

  // ---------------------------------------------------------------- Library folders

  async function removeLibraryFolder(library, root) {
    const question = `Stop showing "${mediaSource.displayPath(root)}" in My ${library.name}? Nothing on disk is touched.`;
    if (!(await confirmAction('REMOVE FOLDER', question))) return;
    appState.roots[library.kind] = appState.roots[library.kind].filter(
      (candidate) => candidate !== root,
    );
    await saveRoots();
    scanCache.clear();
    showPage();
  }

  async function addLibraryFolder() {
    if (!mediaSource.local) {
      openScreen(createComputerScreen());
      return;
    }
    if (await pickFolderIntoLibraries()) showPage();
  }

  async function importKiyoraFolders() {
    const folderCount = LIBRARIES.reduce(
      (count, library) => count + kiyoraFolders[library.kind].length,
      0,
    );
    if (
      !(await confirmAction('IMPORT FROM KIYORA', `Add Kiyora's ${folderCount} library folders?`))
    )
      return;
    for (const { kind } of LIBRARIES) {
      appState.roots[kind] = [...new Set(appState.roots[kind].concat(kiyoraFolders[kind]))];
    }
    await saveRoots();
    scanCache.clear();
    showToast('Imported');
    showPage();
  }

  function buildLibraryRows() {
    const rows = [];
    for (const library of LIBRARIES) {
      for (const root of appState.roots[library.kind]) {
        const displayPath = mediaSource.displayPath(root);
        rows.push({
          label: displayPath,
          sub: library.name.toUpperCase(),
          kind: library.mediaKind,
          title: [folderDisplayName(root), `${library.name.toUpperCase()} · ${displayPath}`],
          run: () => removeLibraryFolder(library, root),
        });
      }
    }
    rows.push({
      label: mediaSource.local ? 'Open a folder…' : 'Add a folder…',
      kind: 'plus',
      title: [
        'Add a folder',
        mediaSource.local
          ? 'Pick a folder; it goes into the libraries it has videos, music or pictures for'
          : 'Opens My Computer; pick a folder and choose "Use as … folder"',
      ],
      run: addLibraryFolder,
    });
    if (kiyoraFolders) {
      rows.push({
        label: 'Import folders from Kiyora',
        kind: 'up',
        title: ['Kiyora', 'Use the same library folders as the PC app'],
        run: importKiyoraFolders,
      });
    }
    return rows;
  }

  // ---------------------------------------------------------------- About

  /** The About page: its text and key table are the "about-template" of index.html. */
  function createAboutPage() {
    const aboutPage = cloneTemplate('about-template');
    let sourceNote =
      'It is reading this PC through the optional server.js. The page also works with no server at all.';
    if (mediaSource.local && mediaSource.canRememberFolders) {
      sourceNote =
        'It reads your folders through the browser. Nothing is installed and nothing runs in the background; you opened the folders once and the browser remembers.';
    } else if (mediaSource.local) {
      sourceNote =
        'It reads your folders through the browser. Nothing is installed. This browser cannot remember folder access between sessions, so you pick the folder again (or drop it onto the page) each time; your library and resume points are kept.';
    }
    selectElement('.about-source', aboutPage).textContent =
      `${sourceNote} Plain HTML, CSS and JavaScript.`;
    return aboutPage;
  }

  // ---------------------------------------------------------------- pages

  const selectPage = (newPage) => () => {
    page = newPage;
    showPage();
  };
  const buildModes = () => [
    { label: 'General', isOn: page === 'general', run: selectPage('general') },
    { label: 'Look', isOn: page === 'look', run: selectPage('look') },
    { label: 'Library folders', isOn: page === 'library', run: selectPage('library') },
    { label: 'About Whistler', isOn: page === 'about', run: selectPage('about') },
    { label: 'Edit profile…', run: editProfile },
  ];

  function showPage() {
    let items = [];
    let extra = null;
    switch (page) {
      case 'look':
        items = buildLookRows();
        break;
      case 'library':
        items = buildLibraryRows();
        break;
      case 'about':
        extra = createAboutPage;
        break;
      default:
        items = buildGeneralRows();
        break;
    }
    screen.updateSpec({
      modes: buildModes(),
      items,
      extra,
      empty: page === 'about' ? null : 'Nothing here.',
    });
  }

  // two things arrive later and add rows: Kiyora's folders and whether server.js is running
  mediaSource
    .loadKiyoraFolders()
    .then((folders) => {
      kiyoraFolders = folders;
      showPage();
    })
    .catch((error) => reportProblem('Looking for Kiyora', error));
  if (mediaSource.local) {
    Source.isServerAvailable().then((available) => {
      serverIsRunning = available;
      showPage();
    });
  }

  showPage();
  return screen;
}
