/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

Cu.import("resource://services-sync/engines/addons.js");

loadAddonTestFunctions();
startupManager();

Engines.register(AddonsEngine);
let engine = Engines.get("addons");
let tracker = engine._tracker;
let store = engine._store;

const uriPrefix = "http://localhost:4444/addons/";

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
    id:                id,
    addonID:           addonId,
    userEnabled:       enabled,
    deleted:           !!deleted,
    applicationID:     Services.appinfo.ID,
    isAddonRepository: true
  };
}

/**
 * Verifies the results of AddonsStore._assembleChangesFromRecords() is sane.
 *
 * @param  changes
 *         Return from _assembleChangesFromRecords() to validate
 * @param  install
 *         Object mapping expected add-on IDs to GUIDs
 * @param  uninstall
 *         Array of add-on ids to be uninstalled
 * @param  guid
 *         Object mapping add-on ID to new GUID
 * @param  enable
 *         Array of add-on ids to be enabled
 * @param  disable
 *         Array of add-on ids to be disabled
 */
function verifyAssembledChanges(changes, install, uninstall, guid,
                                enable, disable) {
  do_check_neq(null, changes);
  do_check_eq(5, Object.keys(changes).length);
  do_check_eq(Object.keys(install).length, Object.keys(changes.install).length);
  do_check_eq(uninstall.length, Object.keys(changes.uninstall).length);
  do_check_eq(Object.keys(guid).length, Object.keys(changes.guid).length);
  do_check_eq(enable.length, Object.keys(changes.enable).length);
  do_check_eq(disable.length, Object.keys(changes.disable).length);

  for each (let [id, guid] in Iterator(install)) {
    do_check_neq(null, changes.install[id]);
    do_check_eq(guid, changes.install[id]);
  }

  uninstall.forEach(function(id) {
    do_check_neq(null, changes.uninstall[id]);
    do_check_eq(true, changes.uninstall[id]);
  });

  for each (let [id, g] in Iterator(guid)) {
    do_check_neq(null, changes.guid[id]);
    do_check_eq(g, changes.guid[id]);
  }

  enable.forEach(function(id) {
    do_check_neq(null, changes.enable[id]);
    do_check_eq(true, changes.enable[id]);
  });

  disable.forEach(function(id) {
    do_check_neq(null, changes.disable[id]);
    do_check_eq(true, changes.disable[id]);
  });
}

let addonsServer;

function run_test() {
  initTestLogging("Trace");
  Log4Moz.repository.getLogger("Sync.Engine.Addons").level = Log4Moz.Level.Trace;

  /*
  addonsServer = new nsHttpServer();
  const prefix = "../../../../toolkit/mozapps/extensions/test/xpcshell/";
  addonsServer.registerDirectory("/addons/", do_get_file(prefix + "addons"));
  addonsServer.registerDirectory("/data/", do_get_file(prefix + "data"));
  addonsServer.registerPathHandler("/redirect", function(request, response) {
    response.setStatusLine(null, 301, "Moved Permanently");
    let url = request.host + ":" + request.port + request.queryString;
    response.setHeader("Location", "http://" + url);
  });
  addonsServer.start(4444);

  const baseURL = "http://localhost:4444/repo";
  //Services.prefs.setCharPref("extensions.getAddons.search.url",
  */
  run_next_test();
}

/*
function end_test() {
  if (addonsServer) {
    addonsServer.stop();
  }
}
*/

add_test(function test_assemble_changes() {
   _("Ensures that incoming records are translated to the proper changes.");

  // The following keep track of the expected state of the changes.
  let installs   = {};
  let uninstalls = [];
  let guids      = {};
  let enables    = [];
  let disables   = [];
  let records    = [];

  _("Ensure no records result in no changes.");
  let changes = store._assembleChangesFromRecords([]);
  verifyAssembledChanges(changes, installs, uninstalls, guids, enables,
                         disables);

  _("Ensure a record for a separate application ID is ignored.");
  records.push({
    id:                Utils.makeGUID(),
    addonID:          "foo",
    userEnabled:       false,
    deleted:           false,
    applicationID:     "otherID",
    isAddonRepository: true
  });
  changes = store._assembleChangesFromRecords(records);
  verifyAssembledChanges(changes, installs, uninstalls, guids, enables,
                         disables);

  _("Ensure a single incoming record for a new add-on is recognized.");
  let guid = Utils.makeGUID();
  let id = "addon1@tests.mozilla.org";

  installs[id] = guid;
  records.push(createRecordForThisApp(guid, id, true, false));
  changes = store._assembleChangesFromRecords(records);
  verifyAssembledChanges(changes, installs, uninstalls, guids, enables,
                         disables);

  _("Add another add-on for install.");
  guid = Utils.makeGUID();
  id = "addon2@tests.mozilla.org";
  installs[id] = guid;
  records.push(createRecordForThisApp(guid, id, true, false));
  changes = store._assembleChangesFromRecords(records);
  verifyAssembledChanges(changes, installs, uninstalls, guids, enables,
                         disables);

  installs = {};
  records  = [];

  // Now we need to have some add-ons installed locally so we can test further.
  let addon = installAddon("test_install1");

  _("Ensure uninstall record is recognized");
  uninstalls.push(addon.id);
  records.push(createRecordForThisApp(addon.syncGUID, addon.id, true, true));
  changes = store._assembleChangesFromRecords(records);
  verifyAssembledChanges(changes, installs, uninstalls, guids, enables,
                         disables);

  uninstalls = [];
  records    = [];

  _("Ensure Sync GUID changes are detected");
  guid = Utils.makeGUID();

  guids[addon.id]  = guid;
  records.push(createRecordForThisApp(guid, addon.id, true, false));
  changes = store._assembleChangesFromRecords(records);
  verifyAssembledChanges(changes, installs, uninstalls, guids, enables,
                         disables);

  guids   = {};
  records = [];

  _("Ensure record for disabling results in action.");
  disables.push(addon.id);
  records.push(createRecordForThisApp(addon.syncGUID, addon.id, false, false));
  changes = store._assembleChangesFromRecords(records);
  verifyAssembledChanges(changes, installs, uninstalls, guids, enables,
                         disables);

  disables = [];
  records  = [];

  _("Ensure record for enabling a disabled add-on is recognized.");
  addon.userDisabled = true;
  enables.push(addon.id);
  records.push(createRecordForThisApp(addon.syncGUID, addon.id, true, false));
  changes = store._assembleChangesFromRecords(records);
  verifyAssembledChanges(changes, installs, uninstalls, guids, enables,
                         disables);

  enables = [];
  records = [];

  // Now move on to more advanced tests.

  _("Ensure GUID change plus an enable is recognized.");
  guid = Utils.makeGUID();
  guids[addon.id]  = guid;
  enables.push(addon.id);
  records.push(createRecordForThisApp(guid, addon.id, true, false));
  changes = store._assembleChangesFromRecords(records);
  verifyAssembledChanges(changes, installs, uninstalls, guids, enables,
                         disables);
  records    = [];
  guids      = {};
  enables    = [];

  _("Ensure an uninstall record clobbers other change requests.");
  addon.userDisabled = false;
  uninstalls.push(addon.id);

  // A GUID change record.
  records.push(createRecordForThisApp(Utils.makeGUID(), addon.id, true, false));

  // A disable record.
  records.push(createRecordForThisApp(addon.syncGUID, addon.id, false, false));

  // A delete record.
  records.push(createRecordForThisApp(addon.syncGUID, addon.id, true, true));

  changes = store._assembleChangesFromRecords(records);
  verifyAssembledChanges(changes, installs, uninstalls, guids, enables,
                         disables);

  uninstalls = [];

  // Clean up after this test.
  addon.uninstall();

  run_next_test();
});

// Note that the following tests, which aim to test application of changes,
// actually call applyIncomingBatch(). This is by design. We shouldn't be
// doing anything here we don't test above in the change-generation code. So,
// we end up with a little redundant testing. But, we save writing extra tests
// for applyIncomingBatch on top of _applyChanges.

add_test(function test_apply_guid_changes() {
  _("Ensures that add-on GUIDs are updated properly.");

  let addon = installAddon("test_install1");

  let records = [];
  let newGUID = Utils.makeGUID();

  records.push(createRecordForThisApp(newGUID, addon.id, true, false));
  let failed = store.applyIncomingBatch(records);
  do_check_eq(0, failed.length);

  let newAddon = getAddonFromAddonManagerByID(addon.id);
  do_check_neq(null, newAddon);
  do_check_eq(addon.id, newAddon.id);
  do_check_eq(newGUID, newAddon.syncGUID);

  newAddon.uninstall();

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

  records = [];

  addon.uninstall();

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
