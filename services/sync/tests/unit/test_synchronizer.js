/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

Cu.import("resource://services-sync/repository.js");
Cu.import("resource://services-sync/synchronizer.js");
Cu.import("resource://services-sync/log4moz.js");

function run_test() {
  initTestLogging();
  run_next_test();
}

/**
 * Doesn't check modification time.
 */
function wbo_eq(a, b) {
  _("Comparing " + a.id + " to " + b.id + "…");
  do_check_true(!!a);
  do_check_true(!!b);
  do_check_eq(a.id, b.id);
  do_check_eq(a.payload, b.payload);
}

/**
 * Ensure that the WBOs in each repository are the same according to wbo_eq.
 */
function wbos_eq(r1, r2) {
  _("Comparing repositories…");
  do_check_eq(r1.count, r2.count);
  for (let [guid, wbo] in Iterator(r1.wbos)) {
    wbo_eq(wbo, r2.wbos[guid]);
  }
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
    wbos_eq(r1, r2);
    run_next_test();
  }
  s1.synchronize(synchronizeCallback);
});

function setup_repositories() {
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
  return [s1, r1, r2];
}

add_test(function test_empty_to_full() {
  _("Test syncing an empty repository to a full repository.");
  let [s1, r1, r2] = setup_repositories();
  function synchronizeCallback(error) {
    do_check_true(!error);
    do_check_eq(2, r1.count);
    do_check_eq(2, r2.count);
    _("lastSyncA: " + s1.lastSyncA);
    _("lastSyncB: " + s1.lastSyncB);
    do_check_true(s1.lastSyncA > 0);
    do_check_true(s1.lastSyncB > 0);
    wbos_eq(r1, r2);
    run_next_test();
  }
  s1.synchronize(synchronizeCallback);
});

add_test(function test_full_to_empty() {
  _("Test syncing a full repository to an empty repository.");
  let [s1, r1, r2] = setup_repositories();
  // Swap them around.
  s1.repositoryA = r2;
  s1.repositoryB = r1;

  function synchronizeCallback(error) {
    do_check_true(!error);
    do_check_eq(2, r1.count);
    do_check_eq(2, r2.count);
    _("lastSyncA: " + s1.lastSyncA);
    _("lastSyncB: " + s1.lastSyncB);
    do_check_true(s1.lastSyncA > 0);
    do_check_true(s1.lastSyncB > 0);
    wbos_eq(r1, r2);
    run_next_test();
  }
  s1.synchronize(synchronizeCallback);
});

add_test(function test_modify() {
  _("Test syncing a full repository to an empty repository, modifying items, " +
    "then syncing back.");
  let [s1, r1, r2] = setup_repositories();
  function checkResult(error) {
    do_check_true(!error);
    do_check_eq(2, r1.count);
    do_check_eq(2, r2.count);
    _("lastSyncA: " + s1.lastSyncA);
    _("lastSyncB: " + s1.lastSyncB);
    do_check_true(s1.lastSyncA > 0);
    do_check_true(s1.lastSyncB > 0);
    wbos_eq(r1, r2);
  }

  function firstSyncCallback(error) {
    checkResult(error);

    // Modify an item in each.
    let item1 = r1.wbos["123412341234"];
    let item2 = r2.wbos["123412341235"];
    item1.modified = Date.now() + 1;
    item2.modified = Date.now() + 2;
    item1.payload  = "BarChanged1";
    item2.payload  = "BarChanged2";

    Utils.nextTick(function () {
      s1.synchronize(secondSyncCallback);
    });
  }

  function secondSyncCallback(error) {
    checkResult(error);

    // Check that each item made it across.
    do_check_eq(r2.wbos["123412341234"].payload, "BarChanged1");
    do_check_eq(r1.wbos["123412341235"].payload, "BarChanged2");

    run_next_test();
  }

  s1.synchronize(firstSyncCallback);
});


// TODO:
// * Exchanging items, verifying contents of each repository afterwards
// * Implement and verify store/time in-session tracking, verifying that store
//   isn't being called for items that we just uploaded
// * Error handling
// * Synchronizing through middleware
// * Multiple synchronize() calls, both with and without new items, and
//   modifying one or both ends
