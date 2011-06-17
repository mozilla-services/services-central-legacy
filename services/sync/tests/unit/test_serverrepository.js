/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

Cu.import("resource://services-sync/repository.js");
Cu.import("resource://services-sync/log4moz.js");

const DONE = Repository.prototype.DONE;

function run_test() {
  initTestLogging();
  Log4Moz.repository.getLogger("Net.Resource").level = Log4Moz.Trace;
  run_next_test();
}

add_test(function test_guidsSince() {
  let guids = ["0000deadbeef", "abcdefghijkl", "charliesheen",
               "trololololol", "123456789012"];
  let wbos = {};
  for (let i = 0; i < guids.length; i++) {
    let guid = guids[i];
    let wbo = wbos[guid] = new ServerWBO(guid, {});
    wbo.modified = (i + 1) * 1000;
  }
  let server_collection = new ServerCollection(wbos);
  let server = httpd_setup({
    "/collection": server_collection.handler()
  });

  let expected = ["123456789012", "charliesheen", "trololololol"];
  let repo = new ServerRepository("http://localhost:8080/collection");
  repo.guidsSince(2000, function guidsCallback(error, guids) {
    do_check_eq(error, null);
    do_check_eq(expected + "", guids.sort());
    server.stop(run_next_test);
  });
});

add_test(function test_fetchSince() {
  let guids = ["0000deadbeef", "abcdefghijkl", "charliesheen",
               "trololololol", "123456789012"];
  let wbos = {};
  for (let i = 0; i < guids.length; i++) {
    let guid = guids[i];
    let wbo = wbos[guid] = new ServerWBO(guid, {});
    wbo.modified = (i + 1) * 1000;
  }
  let server_collection = new ServerCollection(wbos);
  let server = httpd_setup({
    "/collection": server_collection.handler()
  });

  let expected = ["123456789012", "charliesheen", "trololololol"];
  let calledDone = false;
  let repo = new ServerRepository("http://localhost:8080/collection");
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
