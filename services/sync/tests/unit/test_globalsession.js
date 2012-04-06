/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

Cu.import("resource://services-sync/global.js");

function run_test() {
  initTestLogging();

  run_next_test();
}

add_test(function test_global_session_create() {
  _("Ensure creation of GlobalSession instances works.");

  let state = new GlobalState();
  let session = new GlobalSession(state);

  run_next_test();
});
