/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

Cu.import("resource://services-sync/engines/addons.js");

Svc.Prefs.set("addons.ignoreRepositoryChecking", true);

loadAddonTestFunctions();
startupManager();

Engines.register(AddonsEngine);
let engine = Engines.get("addons");
let tracker = engine._tracker;
let store = engine._store;
let reconciler = engine._reconciler;

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
    id:            id,
    addonID:       addonId,
    enabled:       enabled,
    deleted:       !!deleted,
    applicationID: Services.appinfo.ID,
    source:        "amo"
  };
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

  // TODO

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
