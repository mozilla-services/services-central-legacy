/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

Cu.import("resource://services-sync/repository.js");

const DONE = Repository.prototype.DONE;
const STOP = Repository.prototype.STOP;

function setup_fixtures() {
  let repo = new WBORepository();
  repo.wbos = {
    "0000deadbeef": {id: "0000deadbeef",
                     modified: 1000},
    "abcdefghijkl": {id: "abcdefghijkl",
                     modified: 2000},
    "charliesheen": {id: "charliesheen",
                     modified: 3000},
    "trololololol": {id: "trololololol",
                     modified: 4000},
    "123456789012": {id: "123456789012",
                     modified: 5000}
  };
  return repo;
}

function run_test() {
  initTestLogging();
  run_next_test();
}

add_test(function wbo_repository_stop() {
  _("Test returning STOP from a fetchCallback.");
  let repo = setup_fixtures();
  let counter = 0;
  let stopped = false;
  repo.createSession(null, function (err, session) {
    function fetchCallback(error, record) {
      if (stopped) {
        do_throw("fetchCallback should not be invoked after returning STOP!");
      }
      counter++;
      if (counter == 2) {
        stopped = true;
        Utils.nextTick(function () {
          do_check_eq(2, counter);
          session.dispose(function () {
            run_next_test();
          });
        });
        return STOP;
      }
    }
    do_check_true(!err);
    session.fetchSince(2000, fetchCallback);
  });
});

add_test(function test_guidsSince() {
  let repo = setup_fixtures();
  let expected = ["123456789012", "charliesheen", "trololololol"];
  function sessionCallback(err, session) {
    function guidsCallback(error, guids) {
      do_check_eq(error, null);
      do_check_eq(expected + "", guids.sort());
      session.dispose(function () {
        run_next_test();
      });
    }

    do_check_true(!err);
    session.guidsSince(2000, guidsCallback);
  }
  repo.createSession(null, sessionCallback);
});

add_test(function test_fetchSince() {
  let repo = setup_fixtures();
  let expected = ["123456789012", "charliesheen", "trololololol"];
  let calledDone = false;
  repo.createSession(null, function (err, session) {
    do_check_true(!err);
    session.fetchSince(2000, function fetchCallback(error, record) {
      if (calledDone) {
        do_throw("Did not expect any more items after DONE!");
      }

      do_check_eq(error, null);
      // Verify that the record is one of the ones we expect.
      if (expected.length) {
        let index = expected.indexOf(record.id);
        do_check_neq(index, -1);
        expected.splice(index, 1);
        return;
      }

      // We've reached the end of the list, so we must be done.
      do_check_eq(record, DONE);
      calledDone = true;
      session.dispose(function () {
        run_next_test();
      });
    });
  });
});

add_test(function test_timestamp() {
  let repo = setup_fixtures();
  function sessionCallback(error, session) {
    session.timestamp = 12345;
    session.dispose(function (ts) {
      do_check_eq(ts, 12345);
      run_next_test();
    });
  }
  repo.createSession(null, sessionCallback);
});

add_test(function test_fetch() {
  let repo = setup_fixtures();
  let guids = ["123456789012", "non-existent", "charliesheen", "trololololol"];
  let expected = ["123456789012", "charliesheen", "trololololol"];
  let calledDone = false;

  function sessionCallback(error, session) {
    do_check_true(!error);
    session.fetch(guids, function fetchCallback(error, record) {
      if (calledDone) {
        do_throw("Did not expect any more items after DONE!");
      }

      do_check_false(!!error);
      // Verify that the record is one of the ones we expect.
      if (expected.length) {
        let index = expected.indexOf(record.id);
        do_check_neq(index, -1);
        expected.splice(index, 1);
        return;
      }

      // We've reached the end of the list, so we must be done.
      do_check_eq(record, DONE);
      calledDone = true;
      session.dispose(function () {
        run_next_test();
      });
    });
  }

  repo.createSession(null, sessionCallback);
});

add_test(function test_store_empty() {
  _("Test adding no items to an empty WBORepository.");
  let repo = new WBORepository();
  let calledDone = false;
  let session;

  function sessionCallback(error, sess) {
    do_check_false(!!error);
    session = sess;
    sess.store(DONE);
  }

  function storeCallback(error) {
    if (calledDone) {
      do_throw("Did not expect any more items after DONE!");
    }
    do_check_eq(error, DONE);
    calledDone = true;
    do_check_eq(0, repo.count);
    session.dispose(function () {
      run_next_test();
    });
  }

  repo.createSession(storeCallback, sessionCallback);
});

add_test(function test_store() {
  _("Test adding items to WBORepository.");
  let items = [{id: "123412341234", payload: "Bar4"},
               {id: "123412341235", payload: "Bar5"}];
  let repo = new WBORepository();
  let calledDone = false;
  let session;

  function sessionCallback(error, sess) {
    session = sess;
    for each (record in items) {
      sess.store(record);
    }
    sess.store(DONE);
  }

  function storeCallback(error) {
    if (calledDone) {
      do_throw("Did not expect any more items after DONE!");
    }
    do_check_eq(error, DONE);
    calledDone = true;
    do_check_eq(2, repo.count);
    do_check_eq("Bar4", repo.wbos["123412341234"].payload);
    do_check_eq("Bar5", repo.wbos["123412341235"].payload);
    do_check_eq(undefined, repo.wbos["123412341230"]);
    session.dispose(function () {
      run_next_test();
    });
  }

  repo.createSession(storeCallback, sessionCallback);
});
