/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

Cu.import("resource://services-sync/repository.js");
Cu.import("resource://services-sync/log4moz.js");

const DONE = Repository.prototype.DONE;

/**
 * Create five fake records on the server with timestamps 1000, ..., 5000
 * in a collection that can be accessed at http://localhost:8080/collection.
 *
 * @return [nsHttpServer obj, ServerRepository obj, ServerCollection obj]
 */
function setup_fixtures() {
  let guids = ["0000deadbeef", "abcdefghijkl", "charliesheen",
               "trololololol", "123456789012"];
  let wbos = {};
  for (let i = 0; i < guids.length; i++) {
    let guid = guids[i];
    let wbo = wbos[guid] = new ServerWBO(guid, {id: guid});
    wbo.modified = (i + 1) * 1000;
  }
  let collection = new ServerCollection(wbos, true);
  let server = httpd_setup({
    "/collection": collection.handler()
  });
  let repo = new ServerRepository("http://localhost:8080/collection");
  return [repo, server, collection];
}

function run_test() {
  initTestLogging();
  Log4Moz.repository.getLogger("Net.Resource").level = Log4Moz.Trace;
  run_next_test();
}

add_test(function test_guidsSince() {
  let [repo, server] = setup_fixtures();
  let expected = ["123456789012", "charliesheen", "trololololol"];
  repo.guidsSince(2000, function guidsCallback(error, guids) {
    do_check_eq(error, null);
    do_check_eq(expected + "", guids.sort());
    server.stop(run_next_test);
  });
});

add_test(function test_fetchSince() {
  let [repo, server] = setup_fixtures();
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
    server.stop(run_next_test);
  });
});

add_test(function test_fetch() {
  let [repo, server] = setup_fixtures();
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
    server.stop(run_next_test);
  });
});

add_test(function test_store_empty() {
  _("Test adding no items to an empty repository.");
  let collection = new ServerCollection({}, true);
  let server = httpd_setup({
    "/collection": collection.handler()
  });
  let repo = new ServerRepository("http://localhost:8080/collection");
  repo.store([], function (error) {
    do_check_eq(error, DONE);
    do_check_eq(0, collection.count());
    server.stop(run_next_test);
  });
});

add_test(function test_store() {
  _("Test adding items to repository.");
  let collection = new ServerCollection({}, true);
  let server = httpd_setup({
    "/collection": collection.handler()
  });
  let repo = new ServerRepository("http://localhost:8080/collection");
  let items = [{id: "123412341234", payload: "Bar4"},
               {id: "123412341235", payload: "Bar5"}];

  let calledDone = false;
  repo.store(items, function storeCallback(error) {
    if (calledDone) {
      do_throw("Did not expect any more items after DONE!");
    }
    do_check_eq(error, DONE);
    calledDone = true;
    do_check_eq(2, collection.count());
    do_check_eq("Bar4", collection.wbos["123412341234"].payload);
    do_check_eq("Bar5", collection.wbos["123412341235"].payload);
    do_check_eq(undefined, collection.wbos["123412341230"]);
    server.stop(run_next_test);
  });
});
