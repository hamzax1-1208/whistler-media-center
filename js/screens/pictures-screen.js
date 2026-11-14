'use strict';
/* pictures-screen.js — My Pictures: one tile per folder that holds pictures, and the
   pictures of one folder. Opening a picture starts the photo viewer (js/photo-viewer.js). */

/** @returns {object} the My Pictures screen */
function createPicturesScreen() {
  const roots = appState.roots.pictures || [];
  let folders = [];
  let sortBy = 'name'; // 'name' or 'date'

  const screen = createBrowseScreen({
    watermark: 'pictures',
    sectionLabel: 'MY PICTURES',
    title: ['My Pictures', ''],
    view: 'tiles',
    modes: [],
    searchable: true,
    loading: 'Looking through your picture folders',
  });

  const selectSort = (newSort) => () => {
    sortBy = newSort;
    showFolders();
  };
  const buildModes = () =>
    withAddFolderMode(
      [
        {
          label: 'Play slide show',
          run: () =>
            photoViewer.open(
              folders.flatMap((folder) => folder.files),
              0,
              true,
            ),
        },
        { label: 'Sort by name', isOn: sortBy === 'name', run: selectSort('name') },
        { label: 'Sort by date', isOn: sortBy === 'date', run: selectSort('date') },
      ],
      addFolder,
      roots.length === 0,
    );

  /** A tile for a folder; its picture is a contact sheet of the first four pictures. */
  const createFolderTile = (folder) => ({
    label: folder.name,
    kind: 'image',
    mosaic: folder.files.slice(0, 4).map((file) => mediaSource.urlFor(file)),
    title: [
      folder.name,
      `${pluralize(folder.files.length, 'picture')} · ${formatDate(folder.mtime)}`,
    ],
    run: () => openScreen(createPhotoFolderScreen(folder)),
  });

  /**
   * Groups picture files by the folder they are in.
   * @param {object[]} files image file records
   */
  function groupByFolder(files) {
    const foldersByPath = new Map();
    for (const file of files) {
      if (!foldersByPath.has(file.dir)) {
        foldersByPath.set(file.dir, {
          name: folderDisplayName(file.dir),
          dir: file.dir,
          files: [],
          mtime: 0,
        });
      }
      const folder = foldersByPath.get(file.dir);
      folder.files.push(file);
      folder.mtime = Math.max(folder.mtime, file.mtime);
    }
    return [...foldersByPath.values()];
  }

  function showFolders() {
    if (roots.length === 0) return;
    const sorted = folders
      .slice()
      .sort((first, second) =>
        sortBy === 'date' ? second.mtime - first.mtime : naturalCompare(first.name, second.name),
      );
    screen.updateSpec({
      modes: buildModes(),
      view: 'tiles',
      items: sorted.map(createFolderTile),
      empty: 'No pictures found in your folders.',
    });
  }

  async function loadLibrary() {
    if (roots.length === 0) {
      screen.updateSpec({
        loading: null,
        empty: describeMissingRoots('Pictures'),
        modes: buildModes(),
      });
      return;
    }
    const files = await scanRoots(roots, ['image']);
    folders = groupByFolder(files);
    screen.updateSpec({
      loading: null,
      status: `${pluralize(files.length, 'picture')} in ${pluralize(folders.length, 'folder')}`,
    });
    showFolders();
  }

  function showLoadProblem(error) {
    reportProblem('Loading My Pictures', error);
    screen.updateSpec({
      loading: null,
      empty: { title: 'Your pictures could not be read.', hint: error.message },
    });
  }

  /** Asks for another folder for this library and reads the library again. */
  async function addFolder() {
    if (!mediaSource.local) {
      openScreen(createComputerScreen()); // in server mode a folder is chosen from the drives
      return;
    }
    if (!(await pickFolderIntoLibraries('pictures'))) return;
    screen.updateSpec({ loading: 'Looking through your picture folders', items: [] });
    await loadLibrary().catch(showLoadProblem);
  }

  loadLibrary().catch(showLoadProblem);
  return screen;
}

/**
 * The pictures of one folder.
 * @param {{ name: string, files: object[] }} folder
 * @returns {object} the screen
 */
function createPhotoFolderScreen(folder) {
  let sortBy = 'name'; // 'name' or 'date'

  const screen = createBrowseScreen({
    watermark: 'pictures',
    sectionLabel: folder.name,
    title: [folder.name, pluralize(folder.files.length, 'picture')],
    view: 'tiles',
    modes: [],
  });

  const sortedFiles = () =>
    folder.files
      .slice()
      .sort((first, second) =>
        sortBy === 'date' ? first.mtime - second.mtime : naturalCompare(first.name, second.name),
      );
  const selectSort = (newSort) => () => {
    sortBy = newSort;
    showPictures();
  };
  const buildModes = () => [
    {
      label: 'Play slide show',
      // start from the highlighted picture when the highlight is on one
      run: () =>
        photoViewer.open(
          sortedFiles(),
          screen.focusColumn === 'items' ? screen.itemIndex : 0,
          true,
        ),
    },
    { label: 'Sort by name', isOn: sortBy === 'name', run: selectSort('name') },
    { label: 'Sort by date', isOn: sortBy === 'date', run: selectSort('date') },
  ];

  function showPictures() {
    const files = sortedFiles();
    screen.updateSpec({
      modes: buildModes(),
      items: files.map((file, index) => ({
        label: stripExtension(file.name),
        kind: 'image',
        thumb: mediaSource.urlFor(file),
        title: [stripExtension(file.name), formatDate(file.mtime)],
        run: () => photoViewer.open(files, index, false),
      })),
    });
  }

  showPictures();
  return screen;
}
