/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

Cu.import("resource://services-sync/repository.js");
Cu.import("resource://services-sync/synchronizer.js");
Cu.import("resource://services-sync/log4moz.js");

function run_test() {
  run_next_test();
}

add_test(function test_empty_repositories() {
  _("Test syncing two empty repositories.");
  let r1 = new WBORepository();
  let r2 = new WBORepository();
  let s1 = new Synchronizer();
  s1.repositoryA = r1;
  s1.repositoryB = r2;
  function synchronizeCallback(error) {
    do_check_true(!error);
    do_check_eq(0, Object.keys(r1.wbos).length);
    do_check_eq(0, Object.keys(r2.wbos).length);
    // TODO: uncomment when Synchronizer is implemented.
    //do_check_true(s1.lastSyncLocal > 0);
    run_next_test();
  }
  s1.synchronize(synchronizeCallback);
});

add_test(function test_empty_to_full() {
  _("Test syncing an empty repository to a full repository.");
  run_next_test();
});

add_test(function test_full_to_empty() {
  _("Test syncing a full repository to an empty repository.");
  run_next_test();
});
