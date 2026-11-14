'use strict';
/* video-player.js — the full-screen video player: the on-screen display, the options menu
   (subtitles, chapters, speed, picture), resume points, hold-to-scan and its keys.
   The markup is the <section id="player"> of index.html. */

const videoPlayer = (() => {
  const playerElement = selectElement('#player');
  const video = selectElement('#video');
  const menuElement = selectElement('#player-menu');
  const menuList = selectElement('#player-menu-list');
  const keyLegend = selectElement('#key-legend');

  const SEEK_STEP_SECONDS = 10;
  const CHAPTERLESS_SKIP_SECONDS = 90;
  const HOLD_TO_SCAN_MS = 450;
  const OSD_HIDE_DELAY_MS = 3000;
  const LIFTED_SUBTITLE_LINE = -5; // text lines up from the bottom: clear of the on-screen display
  const RESUME_SAVE_INTERVAL_MS = 5000;
  const SPEEDS = [0.75, 1, 1.25, 1.5, 2];

  const state = {
    isOpen: false,
    queue: [], // { file, path, label, series }
    index: -1,
    trackInfo: null, // subtitle tracks, audio tracks and chapters of the current file
    // 'off', 'file:<name>' (a subtitle file next to the video), 'loaded' (a file opened by
    // hand) or the number of a track inside the video
    subtitleChoice: 'off',
    lastSubtitleChoice: null,
    // what the viewer chose by hand, kept for the next episodes of the same queue:
    // { kind: 'off' }, { kind: 'track', language, name } or { kind: 'file', tag }
    rememberedSubtitle: null,
    subtitleUrl: null,
    loadedSubtitle: null, // { name, url, forPath } of a subtitle file the user opened
    speed: 1,
    zoom: 'fit', // 'fit' or 'fill'
    menu: null, // { kind, title, items, focusedIndex } while the options menu is open
    hasEnded: false,
    lastSavedAt: 0,
    hideOsdTimer: 0,
    // hold Left / Right to scan
    heldKey: null,
    heldSince: 0,
    scanSpeed: 0,
    scanDirection: 0,
    scanStartedAt: 0,
    scanTimer: 0,
    wasPlayingBeforeScan: false,
  };

  const currentItem = () => state.queue[state.index];

  // ---------------------------------------------------------------- languages and labels

  // ISO 639 codes as they appear in Matroska files (two and three letters)
  const LANGUAGE_NAMES = {
    eng: 'English',
    en: 'English',
    jpn: 'Japanese',
    ja: 'Japanese',
    tur: 'Turkish',
    tr: 'Turkish',
    spa: 'Spanish',
    es: 'Spanish',
    ger: 'German',
    deu: 'German',
    de: 'German',
    fre: 'French',
    fra: 'French',
    fr: 'French',
    por: 'Portuguese',
    pt: 'Portuguese',
    ita: 'Italian',
    it: 'Italian',
    rus: 'Russian',
    ru: 'Russian',
    ara: 'Arabic',
    ar: 'Arabic',
    kor: 'Korean',
    ko: 'Korean',
    chi: 'Chinese',
    zho: 'Chinese',
    zh: 'Chinese',
    pol: 'Polish',
    pl: 'Polish',
    dut: 'Dutch',
    nld: 'Dutch',
    nl: 'Dutch',
    und: 'Unknown',
  };

  /** The browser's own list of language names, for the codes the table above does not have. */
  const browserLanguageNames =
    typeof Intl !== 'undefined' && Intl.DisplayNames
      ? new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' })
      : null;

  /** "eng" or "en-US" -> "English". An unknown code is returned as it is. */
  function languageName(code) {
    const baseCode = (code || 'und').toLowerCase().split('-')[0];
    if (LANGUAGE_NAMES[baseCode]) return LANGUAGE_NAMES[baseCode];
    try {
      return (browserLanguageNames && browserLanguageNames.of(baseCode)) || code;
    } catch {
      return code; // not a language code at all
    }
  }

  /** The language of a subtitle track, from its tag or, failing that, from its name. */
  function trackLanguage(track) {
    const tagged = languageName(track.langIETF || track.lang);
    if (tagged !== 'Unknown') return tagged;
    const namedLanguage = Object.values(LANGUAGE_NAMES).find(
      (name) => name !== 'Unknown' && new RegExp(`\\b${name}`, 'i').test(track.name || ''),
    );
    return namedLanguage || 'Unknown';
  }

  /** What the menu calls a subtitle track, for example "English – Full Subtitles". */
  function subtitleLabel(track) {
    const language = trackLanguage(track);
    const trackName = (track.name || '').trim();
    let label = language;
    // a name that already says the language ("Spanish (Latin America)") stands on its own
    const nameSaysLanguage = trackName.toLowerCase().includes(language.toLowerCase());
    if (trackName && (language === 'Unknown' || nameSaysLanguage)) label = trackName;
    else if (trackName) label = `${language} – ${trackName}`;
    return label + (track.forced ? ' (forced)' : '');
  }

  // ---- subtitle files next to the video ("Film.tr.srt")

  const sidecars = () => (state.trackInfo && state.trackInfo.sidecars) || [];
  const sidecarChoice = (sidecar) => `file:${sidecar.name}`;
  const isSidecarChoice = (choice) => typeof choice === 'string' && choice.startsWith('file:');

  /** "Film.tr.srt" next to "Film.mkv" -> "tr"; "Film.srt" -> "". */
  function sidecarTag(sidecar) {
    const item = currentItem();
    const videoBaseName = item ? stripExtension(item.file.name) : '';
    return stripExtension(sidecar.name)
      .slice(videoBaseName.length)
      .replace(/^\./, '')
      .toLowerCase();
  }

  /** The language a subtitle file is marked with in its name, or null. */
  function sidecarLanguage(sidecar) {
    const knownNames = Object.values(LANGUAGE_NAMES).filter((name) => name !== 'Unknown');
    for (const word of sidecarTag(sidecar).split(/[.\-_ ]+/)) {
      if (word !== 'und' && LANGUAGE_NAMES[word]) return LANGUAGE_NAMES[word];
      const spelledOut = knownNames.find((name) => name.toLowerCase() === word);
      if (spelledOut) return spelledOut;
    }
    return null;
  }

  /** What the menu calls a subtitle file: its language, else its tag, else a plain name. */
  function sidecarLabel(sidecar) {
    return sidecarLanguage(sidecar) || sidecarTag(sidecar) || 'Subtitle file next to the video';
  }

  /** The name of the subtitles that are showing, for the menu and the toast. */
  function currentSubtitleName() {
    const choice = state.subtitleChoice;
    if (choice === 'off') return 'Off';
    if (choice === 'loaded') return state.loadedSubtitle ? state.loadedSubtitle.name : 'Off';
    if (isSidecarChoice(choice)) {
      const sidecar = sidecars().find((candidate) => sidecarChoice(candidate) === choice);
      if (!sidecar) return 'Off';
      return sidecarLanguage(sidecar) ? `${sidecarLabel(sidecar)} (file)` : 'Subtitle file';
    }
    const tracks = state.trackInfo ? state.trackInfo.subs : [];
    const track = tracks.find((candidate) => candidate.n === choice);
    return track ? subtitleLabel(track) : 'Off';
  }

  // ---------------------------------------------------------------- on-screen display

  /** Shows the on-screen display and hides it again after a few seconds of playback. */
  function showOsd() {
    playerElement.classList.remove('osd-hidden');
    liftSubtitles();
    clearTimeout(state.hideOsdTimer);
    state.hideOsdTimer = setTimeout(() => {
      if (video.paused || state.scanSpeed || state.menu) return;
      playerElement.classList.add('osd-hidden');
      liftSubtitles();
    }, OSD_HIDE_DELAY_MS);
  }

  /**
   * Keeps the subtitles readable: while the on-screen display is showing, the lines at the
   * bottom of the picture move up above it, and come back down when it hides. Lines with a
   * place of their own (the top of the picture) are left alone.
   */
  function liftSubtitles() {
    const isOsdShowing = !playerElement.classList.contains('osd-hidden');
    const wantedLine = isOsdShowing ? LIFTED_SUBTITLE_LINE : 'auto';
    for (const track of video.textTracks) {
      let hasMoved = false;
      for (const cue of track.cues || []) {
        const isBottomCue =
          cue.snapToLines && (cue.line === 'auto' || cue.line === LIFTED_SUBTITLE_LINE);
        if (!isBottomCue || cue.line === wantedLine) continue;
        cue.line = wantedLine;
        hasMoved = true;
      }
      // a line already on screen keeps its old place until the track is drawn afresh
      if (hasMoved && track.mode === 'showing') {
        track.mode = 'hidden';
        track.mode = 'showing';
      }
    }
  }

  /** How far the file is loaded past the current position, in seconds. */
  function bufferedEnd(position) {
    for (let i = 0; i < video.buffered.length; i++) {
      if (video.buffered.start(i) <= position && video.buffered.end(i) >= position)
        return video.buffered.end(i);
    }
    return 0;
  }

  /** Updates the times, the progress bar and the scan / pause indicator. */
  function paintOsd() {
    if (!state.isOpen) return;
    const duration = video.duration || 0;
    const position = video.currentTime || 0;
    const percent = duration ? (position / duration) * 100 : 0;
    selectElement('#osd-position').textContent = formatTime(position);
    selectElement('#osd-duration').textContent = formatTime(duration);
    selectElement('#osd-fill').style.width = `${percent}%`;
    selectElement('#osd-knob').style.left = `${percent}%`;
    selectElement('.osd-bar').setAttribute('aria-valuenow', String(Math.round(percent)));
    selectElement('#osd-buffer').style.width =
      `${duration ? (bufferedEnd(position) / duration) * 100 : 0}%`;

    let indicator = '';
    if (state.scanSpeed) indicator = `${state.scanDirection > 0 ? '▶▶' : '◀◀'} ${state.scanSpeed}×`;
    else if (video.paused) indicator = '‖ PAUSED';
    selectElement('#osd-scan').textContent = indicator;
  }

  // ---------------------------------------------------------------- resume points

  /** Saves where the video is, or marks it watched in its last minute. */
  async function saveResume() {
    const item = currentItem();
    if (!item || !video.duration) return;
    state.lastSavedAt = Date.now();
    const position = video.currentTime;
    const isWatched = state.hasEnded || position > video.duration - 60;
    if (position < 20 && !isWatched) return; // barely started: nothing worth resuming
    await saveResumePoint(
      item.path,
      isWatched ? { t: 0, done: true } : { t: position, done: false },
    );
  }

  // ---------------------------------------------------------------- subtitles

  /**
   * Removes the subtitle track from the video.
   * @param {boolean} [dropLoaded] also forget a hand-picked file that belongs to another video
   */
  function clearSubtitleTracks(dropLoaded = true) {
    for (const trackElement of video.querySelectorAll('track')) trackElement.remove();
    if (state.subtitleUrl && state.subtitleUrl.startsWith('blob:'))
      URL.revokeObjectURL(state.subtitleUrl);
    state.subtitleUrl = null;
    const item = currentItem();
    if (
      dropLoaded &&
      state.loadedSubtitle &&
      state.loadedSubtitle.forPath !== (item && item.path)
    ) {
      URL.revokeObjectURL(state.loadedSubtitle.url);
      state.loadedSubtitle = null;
    }
  }

  /** Adds a WebVTT file to the video and switches it on. */
  function addSubtitleTrack(url, label) {
    const trackElement = document.createElement('track');
    trackElement.kind = 'subtitles';
    trackElement.label = label;
    trackElement.srclang = 'en';
    trackElement.src = url;
    trackElement.default = true;
    video.appendChild(trackElement);
    trackElement.track.mode = 'showing';
    // the cues arrive a moment later; place them once they are there
    trackElement.addEventListener('load', liftSubtitles);
  }

  function applySubtitleSize() {
    video.classList.toggle('large-cues', getSetting('subtitleSize') === 'large');
  }

  /**
   * Notes what the viewer chose by hand, so the next episode starts the same way: the same
   * language and track name, the same kind of subtitle file, or no subtitles.
   * @param {number|string} choice a track number, 'file:<name>', 'loaded' or 'off'
   */
  function rememberSubtitleChoice(choice) {
    if (choice === 'off') {
      state.rememberedSubtitle = { kind: 'off' };
    } else if (isSidecarChoice(choice)) {
      const sidecar = sidecars().find((candidate) => sidecarChoice(candidate) === choice);
      state.rememberedSubtitle = sidecar ? { kind: 'file', tag: sidecarTag(sidecar) } : null;
    } else if (typeof choice === 'number') {
      const tracks = state.trackInfo ? state.trackInfo.subs : [];
      const track = tracks.find((candidate) => candidate.n === choice);
      state.rememberedSubtitle = track
        ? { kind: 'track', language: trackLanguage(track), name: track.name }
        : null;
    } else {
      state.rememberedSubtitle = null; // a file opened by hand belongs to one video only
    }
  }

  /**
   * The subtitles matching what the viewer chose earlier in this queue, if this video has them.
   * @returns {number|string|null} a choice, or null when nothing was chosen or nothing matches
   */
  function pickRememberedSubtitle(trackInfo) {
    const remembered = state.rememberedSubtitle;
    if (!remembered) return null;
    if (remembered.kind === 'off') return 'off';
    if (remembered.kind === 'file') {
      const sameFile = trackInfo.sidecars.find((sidecar) => sidecarTag(sidecar) === remembered.tag);
      return sameFile ? sidecarChoice(sameFile) : null;
    }
    const sameLanguage = trackInfo.subs.filter(
      (track) => trackLanguage(track) === remembered.language,
    );
    const sameTrack =
      sameLanguage.find((track) => track.name === remembered.name) ||
      sameLanguage.find((track) => !track.forced);
    return sameTrack ? sameTrack.n : null;
  }

  /**
   * Chooses the subtitles a video starts with. What the viewer picked for the episode
   * before comes first. Otherwise: a subtitle file marked with the preferred language, a
   * track in that language (full dialogue rather than signs and songs), any subtitle file
   * next to the video, then any track.
   * @param {object} trackInfo
   * @returns {number|string} a track number, 'file:<name>' or 'off'
   */
  function pickSubtitle(trackInfo) {
    const remembered = pickRememberedSubtitle(trackInfo);
    if (remembered !== null) return remembered;
    if (getSetting('subtitles') === 'off') return 'off';

    const preferredLanguage = languageName(getSetting('subtitleLang') || 'eng');
    const candidates = trackInfo.subs.filter((track) => !track.forced);
    const isSignsTrack = (track) => /sign|song/i.test(track.name);
    const bestOf = (tracks) =>
      tracks.find((track) => /full|dialog/i.test(track.name)) ||
      tracks.find((track) => track.default && !isSignsTrack(track)) ||
      tracks.find((track) => !isSignsTrack(track)) ||
      tracks[0];

    const fileInPreferredLanguage = trackInfo.sidecars.find(
      (sidecar) => sidecarLanguage(sidecar) === preferredLanguage,
    );
    if (fileInPreferredLanguage) return sidecarChoice(fileInPreferredLanguage);
    const inPreferredLanguage = bestOf(
      candidates.filter((track) => trackLanguage(track) === preferredLanguage),
    );
    if (inPreferredLanguage) return inPreferredLanguage.n;
    if (trackInfo.sidecars.length > 0) return sidecarChoice(trackInfo.sidecars[0]);
    const anyTrack = bestOf(candidates);
    return anyTrack ? anyTrack.n : 'off';
  }

  /**
   * Switches to a subtitle track (or off).
   * @param {number|string} choice a track number, 'file:<name>' or 'off'
   * @param {boolean} announce true when the viewer asked for it: show a toast about the
   *   result and remember the choice for the next episode
   */
  async function applySubtitle(choice, announce) {
    const item = currentItem();
    state.subtitleChoice = choice;
    if (choice !== 'off') state.lastSubtitleChoice = choice;
    if (announce) rememberSubtitleChoice(choice);
    clearSubtitleTracks();
    if (choice === 'off') {
      if (announce) showToast('Subtitles off', 900);
      return;
    }
    if (announce && mediaSource.local && typeof choice === 'number')
      showToast('Reading subtitles from the file…', 2500);

    let url = null;
    try {
      url = await mediaSource.subtitleUrl(item.file, choice);
    } catch (error) {
      reportProblem(`Extracting subtitles from ${item.label}`, error);
    }
    // the user moved on while the file was being read
    if (currentItem() !== item || state.subtitleChoice !== choice) {
      if (url && url.startsWith('blob:')) URL.revokeObjectURL(url);
      return;
    }
    if (!url) {
      state.subtitleChoice = 'off';
      if (announce) showToast('No usable subtitles in that track', 1400);
      return;
    }
    state.subtitleUrl = url;
    addSubtitleTrack(url, currentSubtitleName());
    if (announce) showToast(`Subtitles: ${currentSubtitleName()}`, 1400);
  }

  /** Shows a subtitle file the user opened by hand. */
  function applyLoadedSubtitle(subtitle, announce) {
    state.subtitleChoice = 'loaded';
    state.lastSubtitleChoice = 'loaded';
    if (announce) rememberSubtitleChoice('loaded');
    clearSubtitleTracks(false);
    addSubtitleTrack(subtitle.url, subtitle.name);
    if (announce) showToast(`Subtitles: ${subtitle.name}`, 1400);
  }

  /** Lets the user open an .srt, .vtt, .ass or .ssa file from anywhere on disk. */
  function pickSubtitleFile() {
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.srt,.vtt,.ass,.ssa,text/plain';
    fileInput.hidden = true;
    document.body.appendChild(fileInput);
    fileInput.addEventListener('change', async () => {
      const chosenFile = fileInput.files && fileInput.files[0];
      fileInput.remove();
      if (!chosenFile) return;
      try {
        const bytes = new Uint8Array(await chosenFile.arrayBuffer());
        const webVtt = Parsers.srtToVtt(Parsers.decodeSubtitleBytes(bytes));
        // a file with no readable cue at all is some other kind of text file
        if (!webVtt.includes('-->')) throw new Error('No subtitle lines found in the file');
        const url = URL.createObjectURL(new Blob([webVtt], { type: 'text/vtt' }));
        const item = currentItem();
        state.loadedSubtitle = { name: chosenFile.name, url, forPath: item && item.path };
        applyLoadedSubtitle(state.loadedSubtitle, true);
      } catch (error) {
        reportProblem(`Reading ${chosenFile.name}`, error);
        showToast(`"${chosenFile.name}" could not be read as a subtitle file`, 2500);
      }
    });
    fileInput.click();
  }

  /** S key: subtitles off, or back on with the track that was showing last. */
  function cycleSubtitles() {
    if (state.subtitleChoice !== 'off') {
      applySubtitle('off', true);
      return;
    }
    if (state.lastSubtitleChoice === 'loaded' && state.loadedSubtitle) {
      applyLoadedSubtitle(state.loadedSubtitle, true);
      return;
    }
    const trackInfo = state.trackInfo;
    if (!trackInfo) {
      showToast('Still reading the file…', 900);
      return;
    }
    let choice = state.lastSubtitleChoice;
    // a choice left over from the video before may not exist in this one
    const existsHere =
      trackInfo.subs.some((track) => track.n === choice) ||
      trackInfo.sidecars.some((sidecar) => sidecarChoice(sidecar) === choice);
    if (!existsHere) {
      const firstFullTrack = trackInfo.subs.find((track) => !track.forced);
      if (firstFullTrack) choice = firstFullTrack.n;
      else if (trackInfo.sidecars.length > 0) choice = sidecarChoice(trackInfo.sidecars[0]);
      else choice = null;
    }
    if (choice === null) showToast('No subtitles in this file', 1200);
    else applySubtitle(choice, true);
  }

  // ---------------------------------------------------------------- chapters

  const chapters = () => (state.trackInfo && state.trackInfo.chapters) || [];

  /** @returns {number} the index of the chapter being played, or -1 before the first one */
  function currentChapterIndex() {
    let chapterIndex = -1;
    chapters().forEach((chapter, index) => {
      if (video.currentTime >= chapter.start) chapterIndex = index;
    });
    return chapterIndex;
  }

  /**
   * Jumps to the next or previous chapter; without chapters, skips 90 seconds.
   * @param {number} direction 1 or -1
   */
  function jumpChapter(direction) {
    const chapterList = chapters();
    if (chapterList.length === 0) {
      video.currentTime = clamp(
        video.currentTime + direction * CHAPTERLESS_SKIP_SECONDS,
        0,
        video.duration || 0,
      );
      showToast(direction > 0 ? 'Skip +90 s' : 'Skip −90 s', 800);
      showOsd();
      return;
    }
    let targetIndex = currentChapterIndex();
    if (direction > 0) {
      targetIndex++;
    } else {
      // a few seconds into a chapter, "previous" restarts it; otherwise it goes one back
      const secondsIntoChapter =
        targetIndex >= 0 ? video.currentTime - chapterList[targetIndex].start : 0;
      if (secondsIntoChapter <= 3) targetIndex--;
    }
    if (targetIndex >= chapterList.length) return;
    if (targetIndex < 0) {
      video.currentTime = 0;
    } else {
      video.currentTime = chapterList[targetIndex].start + 0.01;
      showToast(chapterList[targetIndex].name || `Chapter ${targetIndex + 1}`, 1200);
    }
    showOsd();
  }

  // ---------------------------------------------------------------- options menu

  function closeMenu() {
    state.menu = null;
    menuElement.hidden = true;
    menuList.replaceChildren();
  }

  /**
   * @param {string} kind 'main', 'subtitles' or 'chapters'
   * @param {string} title
   * @param {Array<{label: string, value?: string, isOn?: boolean, run: Function}>} items
   * @param {number} [focusedIndex]
   */
  function openMenu(kind, title, items, focusedIndex = 0) {
    state.menu = { kind, title, items, focusedIndex: Math.max(0, focusedIndex) };
    renderMenu();
    showOsd();
  }

  function renderMenu() {
    const menu = state.menu;
    if (!menu) return;
    selectElement('#player-menu-title').textContent = menu.title;
    menuList.replaceChildren();
    menu.items.forEach((item, index) => {
      const row = cloneTemplate('player-menu-item-template');
      selectElement('.player-menu-label', row).textContent = item.label;
      setOptionalText(selectElement('.player-menu-value', row), item.value);
      if (item.isOn !== undefined) {
        const dot = selectElement('.player-menu-dot', row);
        dot.hidden = false;
        dot.classList.toggle('is-on', Boolean(item.isOn));
      }
      row.classList.toggle('is-focused', index === menu.focusedIndex);
      row.addEventListener('mouseenter', () => {
        if (menu.focusedIndex === index) return;
        menu.focusedIndex = index;
        renderMenu();
      });
      row.addEventListener('click', (event) => {
        event.stopPropagation();
        menu.focusedIndex = index;
        activateMenuItem();
      });
      menuList.appendChild(row);
    });
    menuElement.hidden = false;
  }

  function activateMenuItem() {
    const item = state.menu && state.menu.items[state.menu.focusedIndex];
    if (item && item.run) item.run();
  }

  function buildMainMenuItems() {
    const trackInfo = state.trackInfo || { subs: [], audio: [], chapters: [] };
    const items = [
      {
        label: video.paused ? 'Play' : 'Pause',
        run: () => {
          togglePlayback();
          closeMenu();
        },
      },
      { label: 'Subtitles', value: currentSubtitleName(), run: openSubtitlesMenu },
    ];
    if (trackInfo.audio.length > 1) {
      items.push({
        label: 'Audio',
        value: trackInfo.audio.map((track) => languageName(track.lang)).join(' / '),
        run: () =>
          showToast(
            "A browser can't switch audio tracks. It plays the file's default; remux with the track you want first.",
            4000,
          ),
      });
    }
    if (trackInfo.chapters.length > 0) {
      items.push({
        label: 'Chapters',
        value: String(trackInfo.chapters.length),
        run: openChaptersMenu,
      });
    }
    items.push(
      {
        label: 'Speed',
        value: `${state.speed}×`,
        run: () => {
          state.speed = SPEEDS[(SPEEDS.indexOf(state.speed) + 1) % SPEEDS.length];
          if (!state.scanSpeed) video.playbackRate = state.speed;
          refreshMainMenu();
        },
      },
      {
        label: 'Picture',
        value: state.zoom === 'fit' ? 'Fit to screen' : 'Fill screen',
        run: () => {
          state.zoom = state.zoom === 'fit' ? 'fill' : 'fit';
          video.classList.toggle('fill-screen', state.zoom === 'fill');
          refreshMainMenu();
        },
      },
      {
        label: 'Subtitle size',
        value: getSetting('subtitleSize') === 'large' ? 'Large' : 'Normal',
        run: async () => {
          await saveSettings({
            subtitleSize: getSetting('subtitleSize') === 'large' ? 'normal' : 'large',
          });
          applySubtitleSize();
          refreshMainMenu();
        },
      },
      {
        label: 'Full screen',
        isOn: Boolean(document.fullscreenElement),
        run: () => {
          toggleFullscreen();
          setTimeout(refreshMainMenu, 300);
        },
      },
      {
        label: 'Restart from beginning',
        run: () => {
          video.currentTime = 0;
          closeMenu();
        },
      },
    );
    if (state.index < state.queue.length - 1) {
      items.push({
        label: 'Next episode',
        run: () => {
          closeMenu();
          saveResume();
          loadItem(state.index + 1);
        },
      });
    }
    items.push({
      label: 'Mark as watched and stop',
      run: async () => {
        state.hasEnded = true;
        await saveResume();
        close();
      },
    });
    items.push({
      label: 'Key legend',
      run: () => {
        closeMenu();
        keyLegend.hidden = false;
        showOsd();
      },
    });
    return items;
  }

  function openMainMenu(focusedIndex = 0) {
    openMenu('main', 'Options', buildMainMenuItems(), focusedIndex);
  }

  /** Rebuilds the main menu after one of its values changed, keeping the highlight. */
  function refreshMainMenu() {
    if (!state.menu || state.menu.kind !== 'main') return;
    const items = buildMainMenuItems();
    state.menu.items = items;
    state.menu.focusedIndex = Math.min(state.menu.focusedIndex, items.length - 1);
    renderMenu();
  }

  function openSubtitlesMenu() {
    const trackInfo = state.trackInfo || { subs: [], sidecars: [], pictureSubtitleCount: 0 };
    const choose = (choice) => () => {
      applySubtitle(choice, true);
      closeMenu();
    };
    const items = [{ label: 'Off', isOn: state.subtitleChoice === 'off', run: choose('off') }];
    for (const sidecar of trackInfo.sidecars) {
      items.push({
        label: sidecarLabel(sidecar),
        value: `${Parsers.extOf(sidecar.name).toUpperCase()} FILE`,
        isOn: state.subtitleChoice === sidecarChoice(sidecar),
        run: choose(sidecarChoice(sidecar)),
      });
    }
    for (const track of trackInfo.subs) {
      items.push({
        label: subtitleLabel(track),
        value: track.kind.toUpperCase(),
        isOn: state.subtitleChoice === track.n,
        run: choose(track.n),
      });
    }
    if (state.loadedSubtitle) {
      items.push({
        label: state.loadedSubtitle.name,
        value: 'FILE',
        isOn: state.subtitleChoice === 'loaded',
        run: () => {
          applyLoadedSubtitle(state.loadedSubtitle, true);
          closeMenu();
        },
      });
    }
    items.push({
      label: 'Open a subtitle file…',
      value: 'SRT ASS VTT',
      run: () => {
        closeMenu();
        pickSubtitleFile();
      },
    });
    const hasNothingToShow =
      trackInfo.subs.length === 0 && trackInfo.sidecars.length === 0 && !state.loadedSubtitle;
    if (!state.trackInfo) {
      items.splice(1, 0, { label: 'Still reading the file…', run: () => {} });
    } else if (trackInfo.pictureSubtitleCount > 0) {
      // Blu-ray and DVD subtitles are pictures, which only a real player can draw
      const count = trackInfo.pictureSubtitleCount;
      const note = `${pluralize(count, 'picture subtitle track')} (PGS / VobSub)`;
      const explain = () =>
        showToast(
          "A browser can't show subtitles stored as pictures. Open a subtitle file instead.",
          4000,
        );
      items.splice(1, 0, { label: note, value: "CAN'T SHOW", run: explain });
    } else if (hasNothingToShow) {
      items.splice(1, 0, { label: 'No subtitle tracks in this file', run: () => {} });
    }
    openMenu(
      'subtitles',
      'Subtitles',
      items,
      items.findIndex((item) => item.isOn),
    );
  }

  function openChaptersMenu() {
    const items = chapters().map((chapter, index) => ({
      label: chapter.name || `Chapter ${index + 1}`,
      value: formatTime(chapter.start),
      isOn: currentChapterIndex() === index,
      run: () => {
        video.currentTime = chapter.start + 0.01;
        closeMenu();
        showOsd();
      },
    }));
    openMenu('chapters', 'Chapters', items, currentChapterIndex());
  }

  // ---------------------------------------------------------------- playback

  function togglePlayback() {
    if (video.paused) playMedia(video);
    else video.pause();
  }

  /** Starts the video at a queue position, offering to resume where it was stopped. */
  async function loadItem(queueIndex) {
    state.index = queueIndex;
    state.hasEnded = false;
    state.scanSpeed = 0;
    state.trackInfo = null;
    state.subtitleChoice = 'off';
    closeMenu();
    const item = currentItem();
    selectElement('#osd-name').textContent = item.label;
    selectElement('#osd-series').textContent = item.series || '';
    clearSubtitleTracks();
    applySubtitleSize();
    video.src = mediaSource.urlFor(item.file);
    video.load();
    video.playbackRate = state.speed;

    // subtitle tracks and chapters are read from the file while the video starts
    mediaSource
      .loadTracks(item.file)
      .then((trackInfo) => {
        if (!trackInfo || currentItem() !== item) return;
        state.trackInfo = trackInfo;
        applySubtitle(pickSubtitle(trackInfo), false);
      })
      .catch((error) => reportProblem(`Reading the tracks of ${item.label}`, error));

    const resumePoint = appState.resume[item.path];
    let startAt = 0;
    if (resumePoint && !resumePoint.done && resumePoint.t > 30) {
      const answer = await showDialog({
        title: 'Resume playback',
        text: `${item.label}\nYou stopped at ${formatTime(resumePoint.t)}.`,
        buttons: ['Resume', 'Start over'],
      });
      if (answer === 0) startAt = resumePoint.t;
    }
    if (currentItem() !== item) return;
    if (startAt > 0) {
      if (video.readyState >= 1) video.currentTime = startAt;
      else
        video.addEventListener(
          'loadedmetadata',
          () => {
            video.currentTime = startAt;
          },
          { once: true },
        );
    }
    playMedia(video, item.label);
    showOsd();
  }

  /** Scanning: playing fast forward, or stepping backwards, while Left / Right is held. */
  function startScan(direction) {
    state.scanDirection = direction;
    state.scanSpeed = 2;
    state.wasPlayingBeforeScan = !video.paused;
    state.scanStartedAt = Date.now();
    if (direction > 0) {
      video.playbackRate = 2;
      playMedia(video);
    } else {
      video.pause();
    }
    state.scanTimer = setInterval(() => {
      // the longer the key is held, the faster: 2x, 4x after two seconds, 8x after four
      const heldFor = Date.now() - state.scanStartedAt;
      let wantedSpeed = 2;
      if (heldFor > 4000) wantedSpeed = 8;
      else if (heldFor > 2000) wantedSpeed = 4;
      if (wantedSpeed !== state.scanSpeed) {
        state.scanSpeed = wantedSpeed;
        if (direction > 0) video.playbackRate = Math.min(wantedSpeed, 16);
      }
      // browsers cannot play backwards, so rewind is a series of small jumps
      if (direction < 0)
        video.currentTime = Math.max(0, video.currentTime - state.scanSpeed * 0.25);
      paintOsd();
    }, 250);
    paintOsd();
    showOsd();
  }

  function stopScan() {
    if (!state.scanSpeed) return;
    clearInterval(state.scanTimer);
    state.scanTimer = 0;
    state.scanSpeed = 0;
    video.playbackRate = state.speed;
    if (state.wasPlayingBeforeScan) playMedia(video);
    paintOsd();
    showOsd();
  }

  /** Stops the video, saves the resume point and goes back to the screen underneath. */
  async function close() {
    if (!state.isOpen) return;
    stopScan();
    if (!state.hasEnded) await saveResume();
    state.isOpen = false;
    playerElement.hidden = true;
    video.pause();
    video.removeAttribute('src');
    video.load();
    clearSubtitleTracks();
    closeMenu();
    keyLegend.hidden = true;
    rerenderCurrentScreen();
  }

  /**
   * Opens the player on a list of videos.
   * @param {Array<{file: object, path: string, label: string, series: string}>} queue
   * @param {number} startIndex which one to start with
   */
  async function open(queue, startIndex) {
    const firstItem = queue[startIndex];
    if (!firstItem) return;
    const REACTION_VIDEO = /\b(reaction|reacts?|unboxing|gone wrong|top ?\d+|prank|mukbang)\b/i;
    if (getSetting('roast') && REACTION_VIDEO.test(firstItem.file.name)) {
      const answer = await showDialog({
        title: 'Whistler declines',
        text: `"${firstItem.file.name}" looks like a reaction video, an unboxing, or a top-ten. Neptune won't play those on principle and Whistler inherited the principle.\nPlay it anyway?`,
        buttons: ['Play it', 'Fair enough'],
        defaultIndex: 1,
      });
      if (answer !== 0) return;
    }
    musicPlayer.audio.pause();
    state.queue = queue;
    state.rememberedSubtitle = null; // a new queue starts from the saved preferences again
    state.lastSubtitleChoice = null;
    state.isOpen = true;
    playerElement.hidden = false;
    keyLegend.hidden = true;
    updateNowPlayingBar();
    loadItem(startIndex);
  }

  // ---------------------------------------------------------------- video and mouse events

  video.addEventListener('timeupdate', () => {
    paintOsd();
    const dueForSave = Date.now() - state.lastSavedAt > RESUME_SAVE_INTERVAL_MS;
    if (currentItem() && video.duration && !state.scanSpeed && dueForSave) saveResume();
  });
  video.addEventListener('play', paintOsd);
  video.addEventListener('pause', paintOsd);
  video.addEventListener('ended', async () => {
    state.hasEnded = true;
    await saveResume();
    if (getSetting('autoplayNext') && state.index < state.queue.length - 1)
      loadItem(state.index + 1);
    else close();
  });
  video.addEventListener('error', async () => {
    if (!state.isOpen) return;
    const item = currentItem();
    const codec =
      item && item.file.tags && item.file.tags.codec ? ` (${item.file.tags.codec})` : '';
    await showMessage(
      "Can't play this file",
      `${item ? item.label : ''}${codec}\nThe browser has no decoder for it. H.264 and AV1 play everywhere; HEVC needs the HEVC Video Extension on Windows; 10-bit or older codecs may not play.`,
    );
    if (state.index < state.queue.length - 1 && getSetting('autoplayNext'))
      loadItem(state.index + 1);
    else close();
  });

  playerElement.addEventListener('mousemove', showOsd);
  playerElement.addEventListener('click', (event) => {
    if (event.target !== video) return;
    togglePlayback();
    showOsd();
  });
  playerElement.addEventListener('dblclick', (event) => {
    if (event.target === video) toggleFullscreen();
  });
  playerElement.addEventListener('wheel', (event) => changeVolume(event.deltaY < 0 ? 5 : -5), {
    passive: true,
  });
  selectElement('.osd-bar').addEventListener('click', (event) => {
    const bar = event.currentTarget.getBoundingClientRect();
    if (video.duration)
      video.currentTime = (video.duration * (event.clientX - bar.left)) / bar.width;
    showOsd();
  });
  selectElement('#osd-subtitles-button').addEventListener('click', (event) => {
    event.stopPropagation();
    openSubtitlesMenu();
  });
  selectElement('#osd-options-button').addEventListener('click', (event) => {
    event.stopPropagation();
    if (state.menu) closeMenu();
    else openMainMenu();
  });
  selectElement('#osd-close-button').addEventListener('click', (event) => {
    event.stopPropagation();
    close();
  });

  // ---------------------------------------------------------------- keys

  /** Keys while the options menu is open. Every key is taken so nothing reaches the video. */
  function handleMenuKey(keyName) {
    const menu = state.menu;
    switch (keyName) {
      case 'up':
        menu.focusedIndex = (menu.focusedIndex + menu.items.length - 1) % menu.items.length;
        break;
      case 'down':
        menu.focusedIndex = (menu.focusedIndex + 1) % menu.items.length;
        break;
      case 'enter':
      case 'space':
      case 'right':
        activateMenuItem();
        return true;
      case 'back':
      case 'left':
      case 'o':
      case 'i':
        // a submenu goes back to the main menu, with the highlight on the entry it came from
        if (menu.kind === 'main') closeMenu();
        else openMainMenu(menu.kind === 'subtitles' ? 1 : 2);
        return true;
      default:
        return true;
    }
    renderMenu();
    showOsd();
    return true;
  }

  /** Left / Right: a tap seeks 10 seconds (on key up), holding the key scans. */
  function handleSeekKey(keyName, event) {
    if (event && event.repeat) {
      const heldLongEnough =
        state.heldKey === keyName && Date.now() - state.heldSince > HOLD_TO_SCAN_MS;
      if (!state.scanSpeed && heldLongEnough) startScan(keyName === 'right' ? 1 : -1);
      return;
    }
    state.heldKey = keyName;
    state.heldSince = Date.now();
  }

  /**
   * @param {string} keyName
   * @param {KeyboardEvent|{repeat: boolean}} [event]
   * @returns {boolean} true when the key was used
   */
  function handleKey(keyName, event) {
    if (state.menu) return handleMenuKey(keyName);
    switch (keyName) {
      case 'back':
        if (!keyLegend.hidden) keyLegend.hidden = true;
        else close();
        return true;
      case 'enter':
      case 'space':
      case 'playpause':
        togglePlayback();
        showOsd();
        return true;
      case 'left':
      case 'right':
        handleSeekKey(keyName, event);
        return true;
      case 'up':
      case 'o':
      case 'i':
        openMainMenu();
        return true;
      case 'down':
        showOsd();
        return true;
      case '+':
      case '=':
        changeVolume(5);
        return true;
      case '-':
      case '_':
        changeVolume(-5);
        return true;
      case '.':
      case '>':
        jumpChapter(1);
        return true;
      case ',':
      case '<':
        jumpChapter(-1);
        return true;
      case 'n':
      case 'next':
      case 'pgdn':
        if (state.index < state.queue.length - 1) {
          saveResume();
          loadItem(state.index + 1);
        }
        return true;
      case 'p':
      case 'prev':
      case 'pgup':
        if (video.currentTime > 5) {
          video.currentTime = 0;
        } else if (state.index > 0) {
          saveResume();
          loadItem(state.index - 1);
        }
        return true;
      case 'm':
        video.muted = !video.muted;
        showToast(video.muted ? 'Muted' : 'Sound on', 800);
        return true;
      case 's':
      case 'c':
        cycleSubtitles();
        return true;
      case 'f':
        toggleFullscreen();
        return true;
      case 'h':
        keyLegend.hidden = !keyLegend.hidden;
        showOsd();
        return true;
      case 'stop':
        close();
        return true;
      default:
        return false;
    }
  }

  /** Releasing Left / Right ends a scan, or completes a tap with a 10 second seek. */
  function handleKeyUp(keyName) {
    if (keyName !== 'left' && keyName !== 'right') return;
    if (state.scanSpeed) {
      stopScan();
    } else if (state.heldKey === keyName) {
      const step = keyName === 'right' ? SEEK_STEP_SECONDS : -SEEK_STEP_SECONDS;
      video.currentTime = clamp(video.currentTime + step, 0, video.duration || 0);
      showOsd();
      paintOsd();
    }
    state.heldKey = null;
  }

  return { isOpen: () => state.isOpen, open, close, handleKey, handleKeyUp };
})();
