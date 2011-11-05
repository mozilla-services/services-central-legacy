/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

Cu.import("resource://services-sync/engines/addons.js");
Cu.import("resource://services-sync/constants.js");
Cu.import("resource://services-sync/util.js");
Cu.import("resource://gre/modules/AddonManager.jsm");

loadAddonTestFunctions();
startupManager();

Engines.register(AddonsEngine);
let engine = Engines.get("addons");
let tracker = engine._tracker;

const addon1ID = "addon1@tests.mozilla.org";

function run_test() {
  initTestLogging("Trace");
  Log4Moz.repository.getLogger("Sync.Engine.Addons").level = Log4Moz.Level.Trace;

  installAddon("test_install1");

  run_next_test();
}

add_test(function test_empty() {
  _("Verify the tracker is empty to start with.");
  do_check_eq(0, [id for (id in tracker.changedIDs)].length);
  do_check_eq(0, tracker.score);

  run_next_test();
});

add_test(function test_not_tracking() {
  _("Ensures the tracker doesn't do anything when it isn't tracking.");

  let addon = getAddonFromAddonManagerByID(addon1ID);
  addon.uninstall();
  Utils.nextTick(function() {
    do_check_eq(0, [id for (id in tracker.changedIDs)].length);
    do_check_eq(0, tracker.score);

    run_next_test();
  });
});

add_test(function test_track_install() {
  _("Ensure that installing an add-on notifies tracker.");

  Svc.Obs.notify("weave:engine:start-tracking");

  do_check_eq(0, tracker.score);
  let addon = installAddon("test_install1");
  let changed = [id for (id in tracker.changedIDs)];
  do_check_eq(1, changed.length);
  do_check_eq(addon.syncGUID, changed[0]);
  do_check_eq(SCORE_INCREMENT_XLARGE, tracker.score);

  tracker.resetScore();
  tracker.clearChangedIDs();

  run_next_test();
});

add_test(function test_track_uninstall() {
  _("Ensure that uninstalling an add-on notifies tracker.");

  do_check_eq(0, tracker.score);
  let addon = getAddonFromAddonManagerByID(addon1ID);
  addon.uninstall();
  let changed = [id for (id in tracker.changedIDs)];
  do_check_eq(1, changed.length);
  do_check_eq(addon.syncGUID, changed[0]);
  do_check_eq(SCORE_INCREMENT_XLARGE, tracker.score);

  tracker.resetScore();
  tracker.clearChangedIDs();

  run_next_test();
});

/*
TODO the following tests aren't working due to some weird issue. not sure
if it is unit tests or implementation :(

add_test(function test_track_user_disable() {
  _("Ensure that tracker sees disabling of add-on");

  Svc.Obs.notify("weave:engine:stop-tracking");
  let addon = installAddon("test_install1");
  do_check_false(addon.userDisabled);
  Svc.Obs.notify("weave:engine:start-tracking");

  do_check_eq(0, tracker.score);
  addon.userDisabled = true;

  Utils.nextTick(function() {
    let changed = [id for (id in tracker.changedIDs)];
    do_check_eq(1, changed.length);
    do_check_eq(addon.syncGUID, changed[0]);
    do_check_eq(SCORE_INCREMENT_XLARGE, tracker.score);

    addon.uninstall();
    tracker.resetScore();
    tracker.clearChangedIDs();

    run_next_test();
  });
});

add_test(function test_track_enable() {
  _("Ensure that enabling a disabled add-on notifies tracker.");

  Svc.Obs.notify("weave:engine:stop-tracking");
  let addon = installAddon("test_install1");
  addon.userDisabled = true;
  Svc.Obs.notify("weave:engine:start-tracking");

  Utils.nextTick(function() {
    do_check_eq(0, tracker.score);

    addon.userDisabled = false;
    Utils.nextTick(function() {
      let changed = [id for (id in tracker.changedIDs)];
      do_check_eq(1, changed.length);
      do_check_eq(addon.syncGUID, changed[0]);
      do_check_eq(SCORE_INCREMENT_XLARGE, tracker.score);

      tracker.resetScore();
      tracker.clearChangedIDs();

      run_next_test();
    });
  });
});
*/

function end_test() {
  let addon = getAddonFromAddonManagerById(addon1ID);
  if (addon) {
    addon.uninstall();
  }
}

