/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

Cu.import("resource://services-sync/repository.js");
Cu.import("resource://services-sync/record.js");

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

  newStoreSession: function newStoreSession(storeCallback) {
    let repo = this;
    return {
      store: function store(record) {
        if (record == DONE) {
          storeCallback(DONE);
          return;
        }
        repo.wbos[record.id] = record;
      }
    };
  },

  /**
   * Helpers
   */

  get count() {
    return Object.keys(this.wbos).length;
  }
};


function run_test() {
  // Monkey-patch fake crypto in place.
  let fakeCrypto = new FakeCryptoService(); // Installs itself as Svc.Crypto.
  Crypto5Middleware.prototype.ciphertextHMAC = fakeCrypto.sha256HMAC;

  run_next_test();
}

let payloads = {
  "0000deadbeef": {id: "0000deadbeef",
                   title: "Dead Beef!"},
  "abcdefghijkl": {id: "abcdefghijkl",
                   title: "Now I know my ABCs!"},
  "charliesheen": {id: "charliesheen",
                   title: "Winning!"},
  "trololololol": {id: "trololololol",
                   title: "Trol ol ol ol!"},
  "123456789012": {id: "123456789012",
                   title: "One two three many!"}
};
function getPayload(id) {
  return JSON.stringify(encryptPayload(payloads[id]));
}

function setup_fixtures() {
  let repo = new WBORepository();
  repo.wbos = {
    "0000deadbeef": {id: "0000deadbeef",
                     modified: 1000,
                     sortindex: 1,
                     ttl: 10,
                     payload: getPayload("0000deadbeef")},
    "abcdefghijkl": {id: "abcdefghijkl",
                     modified: 2000,
                     sortindex: 2,
                     ttl: 20,
                     payload: getPayload("abcdefghijkl")},
    "charliesheen": {id: "charliesheen",
                     modified: 3000,
                     sortindex: 3,
                     ttl: 30,
                     payload: getPayload("charliesheen")},
    "trololololol": {id: "trololololol",
                     modified: 4000,
                     sortindex: 4,
                     ttl: 40,
                     payload: getPayload("trololololol")},
    "123456789012": {id: "123456789012",
                     modified: 5000,
                     sortindex: 5,
                     ttl: 50,
                     payload: getPayload("123456789012")}
  };
  let keyBundle = new BulkKeyBundle(null, "testing");
  keyBundle.generateRandom();
  let crypto5 = new Crypto5Middleware(repo, keyBundle);
  return crypto5;
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

      // Verify that it has the data we expect.
      let wbo = repo.repository.wbos[record.id];
      do_check_eq(record.modified, wbo.modified);
      do_check_eq(record.sortindex, wbo.sortindex);
      do_check_eq(record.ttl, wbo.ttl);
      let payload = payloads[record.id];
      do_check_eq(record.title, payload.title);
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

      // Verify that it has the data we expect.
      let wbo = repo.repository.wbos[record.id];
      do_check_eq(record.modified, wbo.modified);
      do_check_eq(record.sortindex, wbo.sortindex);
      do_check_eq(record.ttl, wbo.ttl);
      let payload = payloads[record.id];
      do_check_eq(record.title, payload.title);
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
  let keyBundle = new BulkKeyBundle(null, "testing");
  keyBundle.generateRandom();
  let crypto5 = new Crypto5Middleware(repo, keyBundle);

  let calledDone = false;
  let session = crypto5.newStoreSession(function storeCallback(error) {
    if (calledDone) {
      do_throw("Did not expect any more items after DONE!");
    }
    do_check_eq(error, DONE);
    calledDone = true;
    do_check_eq(0, repo.count);
    run_next_test();
  });
  session.store(DONE);
});

add_test(function test_store() {
  _("Test adding items to WBORepository.");
  let repo = new WBORepository();
  let keyBundle = new BulkKeyBundle(null, "testing");
  keyBundle.generateRandom();
  let crypto5 = new Crypto5Middleware(repo, keyBundle);

  let records = {
    "0000deadbeef": {id: "0000deadbeef",
                     title: "Dead Beef!",
                     ttl: 10,
                     sortindex: 1},
    "abcdefghijkl": {id: "abcdefghijkl",
                     title: "Now I know my ABCs!",
                     ttl: 20,
                     sortindex: 2},
    "charliesheen": {id: "charliesheen",
                     title: "Winning!",
                     ttl: 30,
                     sortindex: 3}
  };
  let ids = Object.keys(records);
  let records_backup = Utils.deepCopy(records);

  let calledDone = false;
  let session = crypto5.newStoreSession(function storeCallback(error) {
    if (calledDone) {
      do_throw("Did not expect any more items after DONE!");
    }
    do_check_eq(error, DONE);
    calledDone = true;

    // Verify that the data has been written to the repository.
    do_check_eq(repo.count, ids.length);
    for each (id in ids) {
      let record = records[id];
      let wbo = repo.wbos[id];
      do_check_neq(wbo, undefined);
      do_check_eq(wbo.id, record.id);

      // 'ttl' and 'sortindex' were removed from the record object,
      // since they're attributes on the WBO.
      do_check_eq(record.ttl, undefined);
      do_check_eq(record.sortindex, undefined);
      do_check_eq(wbo.ttl, records_backup[id].ttl);
      do_check_eq(wbo.sortindex, records_backup[id].sortindex);

      // We can easily compare payloads since we'e using fake crypto.
      let wbo_payload = JSON.parse(wbo.payload);
      let expected_payload = encryptPayload(records[record.id]);
      do_check_eq(wbo_payload.ciphertext, expected_payload.ciphertext);
      do_check_eq(wbo_payload.hmac, expected_payload.hmac);
    }

    run_next_test();
  });

  for each (id in ids) {
    session.store(records[id]);
  }
  session.store(DONE);
});
