/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

Cu.import("resource://services-sync/engines/addons.js");
Cu.import("resource://services-sync/ext/Preferences.js");

const HTTP_PORT = 8888;

let prefs = new Preferences();

Svc.Prefs.set("addons.ignoreRepositoryChecking", true);
prefs.set("extensions.getAddons.get.url", "http://localhost:8888/search/guid:%IDS%");
loadAddonTestFunctions();
startupManager();

Engines.register(AddonsEngine);
let engine = Engines.get("addons");
let tracker = engine._tracker;
let store = engine._store;
let reconciler = engine._reconciler;

/**
 * Create a AddonsRec for this application with the fields specified.
 *
 * @param  id       Sync GUID of record
 * @param  addonId  ID of add-on
 * @param  enabled  Boolean whether record is enabled
 * @param  deleted  Boolean whether record was deleted
 */
function createRecordForThisApp(id, addonId, enabled, deleted) {
  return {
    id:            id,
    addonID:       addonId,
    enabled:       enabled,
    deleted:       !!deleted,
    applicationID: Services.appinfo.ID,
    source:        "amo"
  };
}

function createAndStartHTTPServer(port) {
  try {
    let server = new nsHttpServer();

    let install1_xpi = ExtensionsTestPath("/addons/test_install1.xpi");

    server.registerFile("/search/guid:addon1%40tests.mozilla.org",
                        do_get_file("install1-search.xml"));
    server.registerFile("/install1.xpi", do_get_file(install1_xpi));

    server.registerFile("/search/guid:missing-xpi%40tests.mozilla.org",
                        do_get_file("missing-xpi-search.xml"));

    server.start(port);

    return server;
  } catch (ex) {
    _("Got exception starting HTTP server on port " + port);
    _("Error: " + Utils.exceptionStr(ex));
    do_throw(ex);
  }
}

function run_test() {
  initTestLogging("Trace");
  Log4Moz.repository.getLogger("Sync.Engine.Addons").level = Log4Moz.Level.Trace;

  run_next_test();
}

add_test(function test_get_all_ids() {
  _("Ensures that getAllIDs() returns an appropriate set.");

  engine._refreshReconcilerState();

  let addon1 = installAddon("test_install1");
  let addon2 = installAddon("test_install2_1");

  let ids = store.getAllIDs();
  do_check_eq("object", typeof(ids));
  do_check_eq(2, Object.keys(ids).length);
  do_check_true(addon1.syncGUID in ids);
  do_check_true(addon2.syncGUID in ids);

  uninstallAddon(addon1);
  uninstallAddon(addon2);

  run_next_test();
});

add_test(function test_change_item_id() {
  _("Ensures that changeItemID() works properly.");

  let addon = installAddon("test_install1");

  let oldID = addon.syncGUID;
  let newID = Utils.makeGUID();

  store.changeItemID(oldID, newID);

  let newAddon = getAddonFromAddonManagerByID(addon.id);
  do_check_neq(null, newAddon);
  do_check_eq(newID, newAddon.syncGUID);

  uninstallAddon(newAddon);

  run_next_test();
});

add_test(function test_create() {
  _("Ensure creating/installing an add-on from a record works.");

  let server = createAndStartHTTPServer(HTTP_PORT);

  let addon = installAddon("test_install1");
  let id = addon.id;
  uninstallAddon(addon);

  let guid = Utils.makeGUID();
  let record = createRecordForThisApp(guid, id, true, false);

  let failed = store.applyIncomingBatch([record]);
  do_check_eq(0, failed.length);

  let newAddon = getAddonFromAddonManagerByID(id);
  do_check_neq(null, newAddon);
  do_check_eq(guid, newAddon.syncGUID);
  do_check_false(newAddon.userDisabled);

  uninstallAddon(newAddon);

  server.stop(run_next_test);
});

add_test(function test_create_missing_search() {
  _("Ensures that failed add-on searches are handled gracefully.");

  let server = createAndStartHTTPServer(HTTP_PORT);

  // The handler for this ID is not installed, so a search should 404.
  const id = "missing@tests.mozilla.org";
  let guid = Utils.makeGUID();
  let record = createRecordForThisApp(guid, id, true, false);

  let failed = store.applyIncomingBatch([record]);
  do_check_eq(1, failed.length);
  do_check_eq(guid, failed[0]);

  let addon = getAddonFromAddonManagerByID(id);
  do_check_eq(null, addon);

  server.stop(run_next_test);
});

add_test(function test_create_bad_install() {
  _("Ensures that add-ons without a valid install are handled gracefully.");

  let server = createAndStartHTTPServer(HTTP_PORT);

  // The handler returns a search result but the XPI will 404.
  const id = "missing-xpi@tests.mozilla.org";
  let guid = Utils.makeGUID();
  let record = createRecordForThisApp(guid, id, true, false);

  let failed = store.applyIncomingBatch([record]);
  do_check_eq(1, failed.length);
  do_check_eq(guid, failed[0]);

  let addon = getAddonFromAddonManagerByID(id);
  do_check_eq(null, addon);

  server.stop(run_next_test);
});

add_test(function test_remove() {
  _("Ensure removing add-ons from deleted records works.");

  let addon = installAddon("test_install1");
  let record = createRecordForThisApp(addon.syncGUID, addon.id, true, true);

  let failed = store.applyIncomingBatch([record]);
  do_check_eq(0, failed.length);

  let newAddon = getAddonFromAddonManagerByID(addon.id);
  do_check_eq(null, newAddon);

  run_next_test();
});

add_test(function test_apply_enabled() {
  _("Ensures that changes to the userEnabled flag apply.");

  let addon = installAddon("test_install1");
  do_check_false(addon.userDisabled);

  let records = [];
  records.push(createRecordForThisApp(addon.syncGUID, addon.id, false, false));
  _("Ensure application of a disable record works as expected.");
  let failed = store.applyIncomingBatch(records);
  do_check_eq(0, failed.length);
  addon = getAddonFromAddonManagerByID(addon.id);
  do_check_true(addon.userDisabled);

  records = [];

  _("Ensure enable record works as expected.");
  records.push(createRecordForThisApp(addon.syncGUID, addon.id, true, false));
  failed = store.applyIncomingBatch(records);
  do_check_eq(0, failed.length);
  addon = getAddonFromAddonManagerByID(addon.id);
  do_check_false(addon.userDisabled);

  uninstallAddon(addon);

  run_next_test();
});

add_test(function test_ignore_different_appid() {
  _("Ensure that incoming records with a different application ID are ignored.");

  // We test by creating a record that should result in an update.
  let addon = installAddon("test_install1");
  do_check_false(addon.userDisabled);

  let record = createRecordForThisApp(addon.syncGUID, addon.id, false, false);
  record.applicationID = "FAKE_ID";

  let failed = store.applyIncomingBatch([record]);
  do_check_eq(0, failed.length);

  let newAddon = getAddonFromAddonManagerByID(addon.id);
  do_check_false(addon.userDisabled);

  uninstallAddon(addon);

  run_next_test();
});

add_test(function test_ignore_unknown_source() {
  _("Ensure incoming records with unknown source are ignored.");

  let addon = installAddon("test_install1");

  let record = createRecordForThisApp(addon.syncGUID, addon.id, false, false);
  record.source = "DUMMY_SOURCE";

  let failed = store.applyIncomingBatch([record]);
  do_check_eq(0, failed.length);

  let newAddon = getAddonFromAddonManagerByID(addon.id);
  do_check_false(addon.userDisabled);

  uninstallAddon(addon);

  run_next_test();
});

add_test(function test_apply_uninstall() {
  _("Ensures that uninstalling an add-on from a record works.");

  let addon = installAddon("test_install1");

  let records = [];
  records.push(createRecordForThisApp(addon.syncGUID, addon.id, true, true));
  let failed = store.applyIncomingBatch(records);
  do_check_eq(0, failed.length);

  addon = getAddonFromAddonManagerByID(addon.id);
  do_check_eq(null, addon);

  run_next_test();
});

add_test(function test_ignore_untrusted_source_uris() {
  _("Ensures that source URIs from insecure schemes are rejected.");

  Svc.Prefs.set("addons.ignoreRepositoryChecking", false);

  let ioService = Cc["@mozilla.org/network/io-service;1"]
                  .getService(Ci.nsIIOService);

  const bad = ["http://example.com/foo.xpi",
               "ftp://example.com/foo.xpi",
               "silly://example.com/foo.xpi"];

  const good = ["https://example.com/foo.xpi", "ftps://example.com/foo.xpi"];

  for each (let s in bad) {
    let sourceURI = ioService.newURI(s, null, null);
    let addon = {sourceURI: sourceURI, name: "foo"};

    try {
      store.getInstallFromSearchResult(addon, null);
    } catch (ex) {
      do_check_neq(null, ex);
      do_check_eq(0, ex.message.indexOf("Insecure source URI"));
      continue;
    }

    // We should never get here if an exception is thrown.
    do_check_true(false);
  }

  let count = 0;
  for each (let s in good) {
    let sourceURI = ioService.newURI(s, null, null);
    let addon = {sourceURI: sourceURI, name: "foo", id: "foo"};

    // Despite what you might think, we don't get an error in the callback.
    // The install won't work because the underlying Addon instance wasn't
    // proper. But, that just results in an AddonInstall that is missing
    // certain values. We really just care that the callback is being invoked
    // anyway.
    let callback = function(error, install) {
      do_check_eq(null, error);
      do_check_neq(null, install);
      do_check_eq(sourceURI.spec, install.sourceURI.spec);

      count += 1;

      if (count >= good.length) {
        run_next_test();
      }
    };

    store.getInstallFromSearchResult(addon, callback);
  }
});

/*
add_test(function test_wipe() {
  _("Ensures that wiping causes add-ons to be uninstalled.");

  let addon1 = installAddon("test_install1");
  let addon2 = installAddon("test_install2_1");

  store.wipe();

  let addon = getAddonFromAddonManagerByID(addon1.id);
  do_check_eq(null, addon);
  addon = getAddonFromAddonManagerByID(addon2.id);
  do_check_eq(null, addon);

  run_next_test();
});
*/
