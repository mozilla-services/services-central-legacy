/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

Cu.import("resource://services-sync/repository.js");

/**
 * Amend an iterator to return DONE as the last value.
 */
function andDone(iterator) {
  for (let value in iterator) {
    yield value;
  }
  yield Repository.prototype.DONE;
}

/**
 * Consume an iterator into an Array.
 */
function arrayify(iterator) {
  return [value for (value in iterator)];
}


/**
 * A repository based on a simple map of GUID -> WBO.
 */
function WBORepository(wbos) {
  this.wbos = wbos || {};
  Repository.call(this);
}
WBORepository.prototype = {

  __proto__: Repository.prototype,

  guidsSince: function guidsSince(timestamp, guidsCallback) {
    this.fetchSince(timestamp, function callback(error, recs) {
      return guidsCallback(
        error, ((record == Repository.prototype.DONE ? record : record.id)
                for (record in recs)));
    });
  },

  fetchSince: function fetchSince(timestamp, fetchCallback) {
    let wbos = this.wbos;
    fetchCallback(null, andDone(wbo for ([guid, wbo] in Iterator(wbos))
                                    if (wbo.modified >= timestamp)));
  },

  fetch: function fetch(guids, fetchCallback) {
    fetchCallback(null, andDone(this.wbos[guid] for (guid in Iterator(guids))));
  },

  store: function store(recs, storeCallback) {
    for (let record in recs) {
      _("Adding " + record.id + ".");
      this.wbos[record.id] = record;
    }
    storeCallback(Repository.prototype.DONE);
  },

  get count() {
    return [guid for (guid in this.wbos)].length;
  }
};


function run_test() {
  run_next_test();
}

add_test(function test_DONE() {
  _("DONE is an iterable that contains just itself.");
  let values = arrayify(Repository.prototype.DONE);
  do_check_eq(values.length, 1);
  do_check_eq(values[0], Repository.prototype.DONE);
  run_next_test();
});


add_test(function test_guidsSince() {
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
  let expected = ["123456789012", "charliesheen", "trololololol"];
  let calledDone = false;
  repo.guidsSince(3000, function guidsCallback(error, guids) {
    if (calledDone) {
      do_throw("Did not expect any more items after DONE!");
    }

    do_check_eq(error, null);
    for (let guid in guids) {
      // Verify that the GUID is one of the ones we expect.
      if (expected.length) {
        let index = expected.indexOf(guid);
        do_check_neq(index, -1);
        expected.splice(index, 1);
        continue;
      }

      // We've reached the end of the list, hopefully.
      do_check_eq(guid, Repository.prototype.DONE);
      calledDone = true;
      run_next_test();
    }
  });
});


add_test(function test_fetchSince() {
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
  let expected = ["123456789012", "charliesheen", "trololololol"];
  let calledDone = false;
  repo.fetchSince(3000, function fetchCallback(error, recs) {
    if (calledDone) {
      do_throw("Did not expect any more items after DONE!");
    }

    do_check_eq(error, null);
    for (let record in recs) {
      // Verify that the GUID is one of the ones we expect.
      if (expected.length) {
        let index = expected.indexOf(record.id);
        do_check_neq(index, -1);
        expected.splice(index, 1);
        continue;
      }

      // We've reached the end of the list, hopefully.
      do_check_eq(record, Repository.prototype.DONE);
      calledDone = true;
      run_next_test();
    }
  });
});


add_test(function test_fetch() {
  run_next_test(); //TODO
});

add_test(function test_store_empty() {
  _("Test adding no items to WBORepository.");
  let repo = new WBORepository();
  repo.store(Iterator([]), function (val) {
    do_check_eq(val, Repository.prototype.DONE);
    do_check_eq(0, repo.count);
    run_next_test();
  });
});

add_test(function test_store() {
  _("Test adding items to WBORepository.");
  let items = function () {
    yield {id: "123412341234", foo: "Bar4"};
    yield {id: "123412341235", foo: "Bar5"};
  };
  let repo = new WBORepository();

  let calledDone = false;
  repo.store(items(), function storeCallback(errs) {
    if (calledDone) {
      do_throw("Did not expect any more items after DONE!");
    }

    for (let error in errs) {
      if (error == Repository.prototype.DONE) {
        calledDone = true;
        do_check_eq(2, repo.count);
        do_check_eq("Bar4", repo.wbos["123412341234"].foo);
        do_check_eq("Bar5", repo.wbos["123412341235"].foo);
        do_check_eq(undefined, repo.wbos["123412341230"]);
        run_next_test();
      } else {
        do_throw("Did not expect an error!");
      }
    }
  });
});
