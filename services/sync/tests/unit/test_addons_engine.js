/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

Cu.import("resource://gre/modules/AddonManager.jsm");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://services-sync/async.js");
Cu.import("resource://services-sync/engines/addons.js");

loadAddonTestFunctions();
startupManager();

Engines.register(AddonsEngine);
let engine = Engines.get("addons");


// This is a basic sanity test for the unit test itself. If this breaks, the
// add-ons API likely changed upstream.
add_test(function test_addon_install() {
  _("Ensure basic add-on APIs work as expected.");

  let install = getAddonInstall("test_install1");
  do_check_neq(install, null);
  do_check_eq(install.type, "extension");
  do_check_eq(install.name, "Test 1");

  run_next_test();
});

function run_test() {
  initTestLogging("Trace");
  Log4Moz.repository.getLogger("Sync.Engine.Addons").level = Log4Moz.Level.Trace;
  run_next_test();
}
