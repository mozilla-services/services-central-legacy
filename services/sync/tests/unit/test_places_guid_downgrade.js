Cu.import("resource://services-sync/async.js");
Cu.import("resource://services-sync/util.js");
Cu.import("resource://services-sync/engines.js");
Cu.import("resource://services-sync/engines/history.js");
Cu.import("resource://services-sync/engines/bookmarks.js");

const kDBName = "places.sqlite";
const storageSvc = Cc["@mozilla.org/storage/service;1"]
                     .getService(Ci.mozIStorageService);

const fxuri = Utils.makeURI("http://getfirefox.com/");
const tburi = Utils.makeURI("http://getthunderbird.com/");

function setPlacesDatabase(aFileName) {
  removePlacesDatabase();
  _("Copying over places.sqlite.");
  let file = do_get_file(aFileName);
  file.copyTo(gProfD, kDBName);
}

function removePlacesDatabase() {
  _("Removing places.sqlite.");
  let file = gProfD.clone();
  file.append(kDBName);
  try {
    file.remove(false);
  } catch (ex) {
    // Windows is awesome. NOT.
  }
}

Svc.Obs.add("places-shutdown", function () {
  do_timeout(0, removePlacesDatabase);
});


// Verify initial database state. Function borrowed from places tests.
function test_initial_state() {
  // Mostly sanity checks our starting DB to make sure it's setup as we expect
  // it to be.
  let dbFile = gProfD.clone();
  dbFile.append(kDBName);
  let db = storageSvc.openUnsharedDatabase(dbFile);

  let stmt = db.createStatement("PRAGMA journal_mode");
  do_check_true(stmt.executeStep());
  // WAL journal mode should have been unset this database when it was migrated
  // down to v10.
  do_check_neq(stmt.getString(0).toLowerCase(), "wal");
  stmt.finalize();

  do_check_true(db.indexExists("moz_bookmarks_guid_uniqueindex"));
  do_check_true(db.indexExists("moz_places_guid_uniqueindex"));

  // There should be a non-zero amount of bookmarks without a guid.
  stmt = db.createStatement(
    "SELECT COUNT(1) "
  + "FROM moz_bookmarks "
  + "WHERE guid IS NULL "
  );
  do_check_true(stmt.executeStep());
  do_check_neq(stmt.getInt32(0), 0);
  stmt.finalize();

  // There should be a non-zero amount of places without a guid.
  stmt = db.createStatement(
    "SELECT COUNT(1) "
  + "FROM moz_places "
  + "WHERE guid IS NULL "
  );
  do_check_true(stmt.executeStep());
  do_check_neq(stmt.getInt32(0), 0);
  stmt.finalize();

  // Check our schema version to make sure it is actually at 10.
  do_check_eq(db.schemaVersion, 10);

  db.close();
}

function test_history_guids() {
  let engine = new HistoryEngine();
  let store = engine._store;

  PlacesUtils.history.addPageWithDetails(fxuri, "Get Firefox!",
                                         Date.now() * 1000);
  PlacesUtils.history.addPageWithDetails(tburi, "Get Thunderbird!",
                                         Date.now() * 1000);

  // Hack: flush the places db by adding a random bookmark.
  let uri = Utils.makeURI("http://mozilla.com/");
  let fxid = PlacesUtils.bookmarks.insertBookmark(
    PlacesUtils.bookmarks.toolbarFolder,
    uri,
    PlacesUtils.bookmarks.DEFAULT_INDEX,
    "Mozilla");

  let fxguid = store.GUIDForUri(fxuri, true);
  let tbguid = store.GUIDForUri(tburi, true);
  dump("fxguid: " + fxguid + "\n");
  dump("tbguid: " + tbguid + "\n");

  _("History: Verify GUIDs are added to the guid column.");
  let stmt = PlacesUtils.history.DBConnection.createAsyncStatement(
    "SELECT id FROM moz_places WHERE guid = :guid");

  stmt.params.guid = fxguid;
  let result = Async.querySpinningly(stmt, ["id"]);
  do_check_eq(result.length, 1);

  stmt.params.guid = tbguid;
  result = Async.querySpinningly(stmt, ["id"]);
  do_check_eq(result.length, 1);

  _("History: Verify GUIDs weren't added to annotations.");
  stmt = PlacesUtils.history.DBConnection.createAsyncStatement(
    "SELECT a.content AS guid FROM moz_annos a WHERE guid = :guid");

  stmt.params.guid = fxguid;
  result = Async.querySpinningly(stmt, ["guid"]);
  do_check_eq(result.length, 0);

  stmt.params.guid = tbguid;
  result = Async.querySpinningly(stmt, ["guid"]);
  do_check_eq(result.length, 0);
}

function test_bookmark_guids() {
  let engine = new BookmarksEngine();
  let store = engine._store;

  let fxid = PlacesUtils.bookmarks.insertBookmark(
    PlacesUtils.bookmarks.toolbarFolder,
    fxuri,
    PlacesUtils.bookmarks.DEFAULT_INDEX,
    "Get Firefox!");
  let tbid = PlacesUtils.bookmarks.insertBookmark(
    PlacesUtils.bookmarks.toolbarFolder,
    tburi,
    PlacesUtils.bookmarks.DEFAULT_INDEX,
    "Get Thunderbird!");

  let fxguid = store.GUIDForId(fxid);
  let tbguid = store.GUIDForId(tbid);

  _("Bookmarks: Verify GUIDs are added to the guid column.");
  let stmt = PlacesUtils.history.DBConnection.createAsyncStatement(
    "SELECT id FROM moz_bookmarks WHERE guid = :guid");

  stmt.params.guid = fxguid;
  let result = Async.querySpinningly(stmt, ["id"]);
  do_check_eq(result.length, 1);
  do_check_eq(result[0].id, fxid);

  stmt.params.guid = tbguid;
  result = Async.querySpinningly(stmt, ["id"]);
  do_check_eq(result.length, 1);
  do_check_eq(result[0].id, tbid);

  _("Bookmarks: Verify GUIDs weren't added to annotations.");
  stmt = PlacesUtils.history.DBConnection.createAsyncStatement(
    "SELECT a.content AS guid FROM moz_items_annos a WHERE guid = :guid");

  stmt.params.guid = fxguid;
  result = Async.querySpinningly(stmt, ["guid"]);
  do_check_eq(result.length, 0);

  stmt.params.guid = tbguid;
  result = Async.querySpinningly(stmt, ["guid"]);
  do_check_eq(result.length, 0);
}

function run_test() {
  setPlacesDatabase("places_v10_from_v11.sqlite");

  _("Verify initial setup: v11 database is available");
  test_initial_state();
  test_history_guids();
  test_bookmark_guids();
}
