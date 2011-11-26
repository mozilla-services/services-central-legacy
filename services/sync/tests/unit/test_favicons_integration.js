/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

/*
 * Test the tracking integration between bookmarks/history and favicons.
 */

Svc.DefaultPrefs.set("registerEngines", "Bookmarks,Favicons");
Cu.import("resource://services-sync/engines.js");
Cu.import("resource://services-sync/service.js");
Cu.import("resource://services-sync/engines/favicons.js");

// Need to carefully manage these: Places will send notifications for each
// place with that favicon when a favicon changes. Use two different URIs to
// avoid overlap and double notifications.
const TEST_FAVICON_URI_1  = "http://example.com/sync1/favicon-big16.ico";
const TEST_FAVICON_URI_2  = "http://example.com/sync2/favicon-big16.ico";
const EXPIRATION_OFFSET = 500000;

// Sample file.
const ICON_16_DATAURL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAABEUlEQVQ4jbWSsXEDMQwEL0CIWAWwBdTCFtgCU0Xs4bMPVAgL+GZUwTrg/5uS7JECGwlnOLzF4UDpr6u1RkqJkIgIWmv03nkrvN/vRAQhsUks+1mkAZN+B63rDTOj7MIicZUgxlkkUkq4+88AMzsB7J23GLCrxKYg50xKiUXiRdxaw8xYdgD67nyAmOBlHgfA3cfsMR7NggN2ZHLcLftYp4Pn7jMgJNydnPOjkwgEnGtbJsH1CXhsotZKiTjDlpnRe8fdT9E2Cee7I5daKwpRShkOzAx3f5l9k7hcLoREzplaK4uCCLGuNx620Ht/sb5Ntt/+xFor8Zx87El/Ur13Yg9n7p5z/gwwg47w3H0E9Z/1BfAkJDRE3FKkAAAAAElFTkSuQmCC";

function run_test() {
  initTestLogging("Trace");
  run_next_test();
}

/**
 * We really, really care about the notifications that we get from the
 * bookmarks and history systems. This test verifies that we get onItemChanged
 * when a bookmark favicon changes, without going through the engine itself.
 */
add_test(function test_bookmark_notifications() {
  _("Testing fundamental bookmark notifications.");

  let svc = Cc["@mozilla.org/browser/nav-bookmarks-service;1"]
              .getService(Components.interfaces.nsINavBookmarksService);
  let obs = {
    onItemAdded: function () {
      _("Got onItemAdded.");
    },

    onItemChanged: function onItemChanged(aItemId,
                                          aProperty,
                                          aIsAnnotationProperty,
                                          aNewValue,
                                          aLastModified,
                                          aItemType,
                                          aParentId,
                                          aGUID,
                                          aParentGUID) {
      _("Got onItemChanged: " + aItemId + "." + aProperty + " = " + aNewValue);
      svc.removeObserver(obs);
      run_next_test();
    }
  };

  _("Adding a folder...");
  let fxuri = Utils.makeURI("http://getfirefox.com/");
  let folderID = PlacesUtils.bookmarks.createFolder(
    PlacesUtils.bookmarks.toolbarFolder, "Folder 1", 0);

  _("Adding a bookmark...");
  let bookmarkID = PlacesUtils.bookmarks.insertBookmark(
    folderID, fxuri, PlacesUtils.bookmarks.DEFAULT_INDEX, "Get Firefox!");

  svc.addObserver(obs, false);
  _("Setting a favicon...");

  let faviconURI = Utils.makeURI(TEST_FAVICON_URI_1);
  let expiration = Date.now() + EXPIRATION_OFFSET;
  Svc.Favicons.setFaviconDataFromDataURL(faviconURI, ICON_16_DATAURL, expiration);
  PlacesUtils.favicons.setFaviconUrlForPage(fxuri, faviconURI);
});

/**
 * Return the favicons and bookmarks engines, with their trackers cleaned up.
 */
function prepareEngines() {
  function fetch(name) {
    let engine = Engines.get(name);
    engine._tracker.resetScore();
    engine._tracker.clearChangedIDs();
    return engine;
  }

  return [fetch("bookmarks"), fetch("favicons")];
}

add_test(function test_bookmark_addition() {
  _("Testing that adding a bookmark and its favicon results in the favicons " +
    "engine being notified.");

  let [bookmarksEngine, faviconsEngine] = prepareEngines();
  Svc.Obs.notify("weave:engine:start-tracking");   // We skip usual startup...

  let oldNotifyFaviconChange = faviconsEngine.notifyFaviconChange;
  faviconsEngine.notifyFaviconChange = function (faviconURL) {
    _("Got notification as expected: " + faviconURL);
    oldNotifyFaviconChange.call(this, faviconURL);

    _("Prevent a sync by cutting the score down...");
    faviconsEngine._tracker.score  = 0;
    bookmarksEngine._tracker.score = 0;

    _("Make sure the favicon is marked as changed.");
    do_check_true(!!faviconsEngine.getChangedIDs()[faviconURL]);
    run_next_test();
  };

  _("Adding a folder...");
  let moURI = Utils.makeURI("http://mozilla.org/");
  let folderID = PlacesUtils.bookmarks.createFolder(
    PlacesUtils.bookmarks.toolbarFolder, "Folder 1", 0);

  _("Adding a bookmark...");
  let bookmarkID = PlacesUtils.bookmarks.insertBookmark(
    folderID, moURI, PlacesUtils.bookmarks.DEFAULT_INDEX, "Get Firefox!");

  _("Bookmark is " + bookmarkID);
  _("Folder is " + folderID);

  _("Setting a favicon...");
  let faviconURI = Utils.makeURI(TEST_FAVICON_URI_2);
  let expiration = Date.now() + EXPIRATION_OFFSET;
  Svc.Favicons.setFaviconDataFromDataURL(faviconURI, ICON_16_DATAURL, expiration);
  PlacesUtils.favicons.setFaviconUrlForPage(moURI, faviconURI);

  _("Expecting a notification.");
});
