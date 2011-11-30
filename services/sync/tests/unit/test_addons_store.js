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
