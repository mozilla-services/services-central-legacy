/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

Cu.import("resource://services-sync/repository.js");

const DONE = Repository.prototype.DONE;

/**
 * A repository based on a simple map of GUID -> WBO.
 */
function WBORepository(wbos) {
  this.wbos = wbos || {};
  Repository.call(this);
}
WBORepository.prototype = {

  __proto__: Repository.prototype,

  /**
   * Repository API
   */

  guidsSince: function guidsSince(timestamp, guidsCallback) {
    guidsCallback(null, [guid for ([guid, wbo] in Iterator(this.wbos))
                              if (wbo.modified > timestamp)]);
  },

  fetchSince: function fetchSince(timestamp, fetchCallback) {
    for (let [guid, wbo] in Iterator(this.wbos)) {
      if (wbo.modified > timestamp) {
        fetchCallback(null, wbo);
      }
    }
    fetchCallback(null, DONE);
  },

  fetch: function fetch(guids, fetchCallback) {
    for (let i = 0; i < guids.length; i++) {
      let wbo = this.wbos[guids[i]];
      if (wbo) {
        fetchCallback(null, wbo);
      }
    }
    fetchCallback(null, DONE);
  },

  store: function store(recs, storeCallback) {
    for (let i = 0; i < recs.length; i++) {
      let record = recs[i];
      this.wbos[record.id] = record;
    }
    storeCallback(DONE);
  },

  /**
   * Helpers
   */

  get count() {
    return [guid for (guid in this.wbos)].length;
  }
};

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
  run_next_test();
}

add_test(function test_guidsSince() {
  let repo = setup_fixtures();
  let expected = ["123456789012", "charliesheen", "trololololol"];
  repo.guidsSince(2000, function guidsCallback(error, guids) {
    do_check_eq(error, null);
    do_check_eq(expected + "", guids.sort());
    run_next_test();
  });
});


add_test(function test_fetchSince() {
  let repo = setup_fixtures();
  let expected = ["123456789012", "charliesheen", "trololololol"];
  let calledDone = false;
  repo.fetchSince(2000, function fetchCallback(error, record) {
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
    run_next_test();
  });
});


add_test(function test_fetch() {
  let repo = setup_fixtures();
  let guids = ["123456789012", "non-existent", "charliesheen", "trololololol"];
  let expected = ["123456789012", "charliesheen", "trololololol"];
  let calledDone = false;
  repo.fetch(guids, function fetchCallback(error, record) {
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
    run_next_test();
  });
});

add_test(function test_store_empty() {
  _("Test adding no items to an empty WBORepository.");
  let repo = new WBORepository();
  repo.store([], function (error) {
    do_check_eq(error, DONE);
    do_check_eq(0, repo.count);
    run_next_test();
  });
});

add_test(function test_store() {
  _("Test adding items to WBORepository.");
  let items = [{id: "123412341234", foo: "Bar4"},
               {id: "123412341235", foo: "Bar5"}];
  let repo = new WBORepository();

  let calledDone = false;
  repo.store(items, function storeCallback(error) {
    if (calledDone) {
      do_throw("Did not expect any more items after DONE!");
    }
    do_check_eq(error, DONE);
    calledDone = true;
    do_check_eq(2, repo.count);
    do_check_eq("Bar4", repo.wbos["123412341234"].foo);
    do_check_eq("Bar5", repo.wbos["123412341235"].foo);
    do_check_eq(undefined, repo.wbos["123412341230"]);
    run_next_test();
  });
});
