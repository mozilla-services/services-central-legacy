/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

Cu.import("resource://services-sync/repository.js");
Cu.import("resource://services-sync/synchronizer.js");
Cu.import("resource://services-sync/log4moz.js");

function run_test() {
  initTestLogging();
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
    _("lastSyncA: " + s1.lastSyncA);
    _("lastSyncB: " + s1.lastSyncB);
    do_check_true(s1.lastSyncA > 0);
    do_check_true(s1.lastSyncB > 0);
    run_next_test();
  }
  s1.synchronize(synchronizeCallback);
});

add_test(function test_empty_to_full() {
  _("Test syncing an empty repository to a full repository.");
  let r1 = new WBORepository();
  let r2 = new WBORepository();

  let now = Date.now();
  r2.wbos = {
    "123412341234": {id: "123412341234",
                     modified: now + 10000,
                     payload: "Bar4"},
    "123412341235": {id: "123412341235",
                     modified: now + 10002,
                     payload: "Bar5"}
  };

  let s1 = new Synchronizer();
  s1.repositoryA = r1;
  s1.repositoryB = r2;
  function synchronizeCallback(error) {
    do_check_true(!error);
    do_check_eq(2, Object.keys(r1.wbos).length);
    do_check_eq(2, Object.keys(r2.wbos).length);
    _("lastSyncA: " + s1.lastSyncA);
    _("lastSyncB: " + s1.lastSyncB);
    do_check_true(s1.lastSyncA > 0);
    do_check_true(s1.lastSyncB > 0);
    run_next_test();
  }
  s1.synchronize(synchronizeCallback);
  run_next_test();
});

add_test(function test_full_to_empty() {
  _("Test syncing a full repository to an empty repository.");
  let r1 = new WBORepository();
  let r2 = new WBORepository();

  let now = Date.now();
  r1.wbos = {
    "123412341234": {id: "123412341234",
                     modified: now + 10000,
                     payload: "Bar4"},
    "123412341235": {id: "123412341235",
                     modified: now + 10002,
                     payload: "Bar5"}
  };

  let s1 = new Synchronizer();
  s1.repositoryA = r1;
  s1.repositoryB = r2;
  function synchronizeCallback(error) {
    do_check_true(!error);
    do_check_eq(2, Object.keys(r1.wbos).length);
    do_check_eq(2, Object.keys(r2.wbos).length);
    _("lastSyncA: " + s1.lastSyncA);
    _("lastSyncB: " + s1.lastSyncB);
    do_check_true(s1.lastSyncA > 0);
    do_check_true(s1.lastSyncB > 0);
    run_next_test();
  }
  s1.synchronize(synchronizeCallback);
  run_next_test();
});

// TODO:
// * Exchanging items, verifying contents of each repository afterwards
// * Implement and verify store/time in-session tracking, verifying that store
//   isn't being called for items that we just uploaded
// * Error handling
// * Synchronizing through middleware
// * Multiple synchronize() calls, both with and without new items, and
//   modifying one or both ends
