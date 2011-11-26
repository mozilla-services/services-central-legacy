/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

Cu.import("resource://services-sync/engines/bookmarks.js");

const TEST_NO_ICON_URI = "http://example.com/";
const TEST_ICON_URI    = "http://test.com/";
const TEST_FAVICON_URI = "http://test.com/favicon.ico";

function run_test() {
  let logger = Log4Moz.repository.rootLogger;
  Log4Moz.repository.rootLogger.addAppender(new Log4Moz.DumpAppender());
  initTestLogging();
  run_next_test();
}

add_test(function test_bookmark_record_has_icon() {
  let noIconPageURI = NetUtil.newURI(TEST_NO_ICON_URI);
  let iconPageURI   = NetUtil.newURI(TEST_ICON_URI);

  // No icon to start with.
  try {
    PlacesUtils.favicons.getFaviconForPage(iconPageURI);
    do_throw("Page has a favicon!");
  } catch (ex) { /* Page should have no favicon. */ }
  try {
    PlacesUtils.favicons.getFaviconForPage(noIconPageURI);
    do_throw("Page has a favicon!");
  } catch (ex) { /* Page should have no favicon. */ }

  // Add a page with a bookmark and icon.
  let iconId = PlacesUtils.bookmarks.insertBookmark(
    PlacesUtils.toolbarFolderId, iconPageURI,
    PlacesUtils.bookmarks.DEFAULT_INDEX, "Test bookmark 1"
  );

  // Add a page without a favicon.
  let noIconId = PlacesUtils.bookmarks.insertBookmark(
    PlacesUtils.toolbarFolderId, noIconPageURI,
    PlacesUtils.bookmarks.DEFAULT_INDEX, "Test bookmark 2"
  );

  // Set a favicon for the first page.
  PlacesUtils.favicons.setFaviconUrlForPage(
    iconPageURI, NetUtil.newURI(TEST_FAVICON_URI)
  );

  do_check_eq(PlacesUtils.favicons.getFaviconForPage(iconPageURI).spec,
              TEST_FAVICON_URI);

  let engine    = new BookmarksEngine();
  let store     = engine._store;
  let recIcon   = store.createRecord(store.GUIDForId(iconId),   "bookmarks");
  let recNoIcon = store.createRecord(store.GUIDForId(noIconId), "bookmarks");

  do_check_eq(TEST_FAVICON_URI, recIcon.faviconURI.spec);
  do_check_eq(undefined, recNoIcon.faviconURI);

  run_next_test();
});
