/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

Cu.import("resource://services-sync/repository.js");
Cu.import("resource://services-sync/log4moz.js");

const DONE = Repository.prototype.DONE;

/**
 * Create five fake records on the server with timestamps 1000, ..., 5000
 * in a collection that can be accessed at http://localhost:8080/collection.
 *
 * @return [nsHttpServer obj, Server11Repository obj, ServerCollection obj]
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
    "/1.1/john/storage/marbles": collection.handler()
  });
  let repo = new Server11Repository("http://localhost:8080", "john", "marbles");
  return [repo, server, collection];
}

function run_test() {
  initTestLogging();
  Log4Moz.repository.getLogger("Net.Resource").level = Log4Moz.Trace;
  run_next_test();
}

add_test(function test_uri() {
  let repo = new Server11Repository("http://localhost:8080", "john", "marbles");
  do_check_eq(repo.uri, "http://localhost:8080/1.1/john/storage/marbles");

  // Trailing slash in the server URL is OK.
  repo = new Server11Repository("http://localhost:8080/", "john", "marbles");
  do_check_eq(repo.uri, "http://localhost:8080/1.1/john/storage/marbles");

  run_next_test();
});

add_test(function test_guidsSince() {
  let [repo, server] = setup_fixtures();
  let expected = ["123456789012", "charliesheen", "trololololol"];
  repo.guidsSince(2000, function guidsCallback(error, guids) {
    do_check_eq(error, null);
    do_check_eq(expected + "", guids.sort());
    server.stop(run_next_test);
  });
});

add_test(function test_guidsSince_networkError() {
  let repo = new Server11Repository("http://localhost:8080", "john", "marbles");
  repo.guidsSince(2000, function guidsCallback(error, guids) {
    do_check_eq(guids, null);
    do_check_neq(error, null);
    do_check_eq(error.result, Cr.NS_ERROR_CONNECTION_REFUSED);
    run_next_test();
  });
});

add_test(function test_guidsSince_httpError() {
  let server = httpd_setup({
    "/1.1/john/storage/marbles": httpd_handler(404, "Not Found", "Cannae\nfind\nit")
  });
  let repo = new Server11Repository("http://localhost:8080", "john", "marbles");
  repo.guidsSince(2000, function guidsCallback(error, guids) {
    do_check_eq(guids, null);
    do_check_neq(error, null);
    do_check_eq(error.status, 404);
    do_check_eq(error, "Cannae\nfind\nit");
    server.stop(run_next_test);
  });
});

add_test(function test_guidsSince_invalidJSON() {
  let server = httpd_setup({
    "/1.1/john/storage/marbles": httpd_handler(200, "OK", "this is invalid JSON")
  });
  let repo = new Server11Repository("http://localhost:8080", "john", "marbles");
  repo.guidsSince(2000, function guidsCallback(error, guids) {
    do_check_eq(guids, null);
    do_check_neq(error, null);
    do_check_eq(error.name, "SyntaxError");
    do_check_eq(error.message, "JSON.parse: unexpected keyword");
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

add_test(function test_fetchSince_networkError() {
  let repo = new Server11Repository("http://localhost:8080", "john", "marbles");
  repo.fetchSince(2000, function fetchCallback(error, record) {
    do_check_eq(record, DONE);
    do_check_neq(error, null);
    do_check_eq(error.result, Cr.NS_ERROR_CONNECTION_REFUSED);
    run_next_test();
  });
});

// TODO test is disabled because we can't implement the desired behaviour
// yet in Server11Repository.
function DISABLED_add_test() {}
DISABLED_add_test(function test_fetchSince_httpError() {
  let server = httpd_setup({
    "/1.1/john/storage/marbles": httpd_handler(404, "Not Found", "Cannae\nfind\nit")
  });
  let repo = new Server11Repository("http://localhost:8080", "john", "marbles");
  let calledDone = false;
  repo.fetchSince(2000, function fetchCallback(error, record) {
    if (calledDone) {
      do_throw("Did not expect any more items after DONE!");
    }

    do_check_eq(record, DONE);
    calledDone = true;
    do_check_neq(error, null);
    do_check_eq(error.status, 404);
    do_check_eq(error, "Cannae\nfind\nit");
    server.stop(run_next_test);
  });
});

add_test(function test_fetchSince_invalidJSON() {
  let server = httpd_setup({
    "/1.1/john/storage/marbles": httpd_handler(200, "OK", "this is invalid JSON")
  });
  let repo = new Server11Repository("http://localhost:8080", "john", "marbles");
  let calledDone = false;
  repo.fetchSince(2000, function fetchCallback(error, record) {
    if (calledDone) {
      do_throw("Did not expect any more items after DONE!");
    }

    // We're going to first be called for the invalid JSON error.
    if (record != DONE) {
      do_check_eq(record, null);
      do_check_neq(error, null);
      do_check_eq(error.name, "SyntaxError");
      do_check_eq(error.message, "JSON.parse: unexpected keyword");
      return;
    }

    // Finally we're called with DONE.
    calledDone = true;
    do_check_eq(record, DONE);
    do_check_eq(error, null);
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

add_test(function test_fetch_networkError() {
  let repo = new Server11Repository("http://localhost:8080", "john", "marbles");
  repo.fetch(["trololololol"], function fetchCallback(error, record) {
    do_check_eq(record, DONE);
    do_check_neq(error, null);
    do_check_eq(error.result, Cr.NS_ERROR_CONNECTION_REFUSED);
    run_next_test();
  });
});

// TODO test is disabled because we can't implement the desired behaviour
// yet in Server11Repository.
DISABLED_add_test(function test_fetch_httpError() {
  let server = httpd_setup({
    "/1.1/john/storage/marbles": httpd_handler(404, "Not Found", "Cannae\nfind\nit")
  });
  let repo = new Server11Repository("http://localhost:8080", "john", "marbles");
  let calledDone = false;
  repo.fetch(["trololololol"], function fetchCallback(error, record) {
    if (calledDone) {
      do_throw("Did not expect any more items after DONE!");
    }

    do_check_eq(record, DONE);
    calledDone = true;
    do_check_neq(error, null);
    do_check_eq(error.status, 404);
    do_check_eq(error, "Cannae\nfind\nit");
    server.stop(run_next_test);
  });
});

add_test(function test_fetch_invalidJSON() {
  let server = httpd_setup({
    "/1.1/john/storage/marbles": httpd_handler(200, "OK", "this is invalid JSON")
  });
  let repo = new Server11Repository("http://localhost:8080", "john", "marbles");
  let calledDone = false;
  repo.fetch(["trololololol"], function fetchCallback(error, record) {
    if (calledDone) {
      do_throw("Did not expect any more items after DONE!");
    }

    // We're going to first be called for the invalid JSON error.
    if (record != DONE) {
      do_check_eq(record, null);
      do_check_neq(error, null);
      do_check_eq(error.name, "SyntaxError");
      do_check_eq(error.message, "JSON.parse: unexpected keyword");
      return;
    }

    // Finally we're called with DONE.
    calledDone = true;
    do_check_eq(record, DONE);
    do_check_eq(error, null);
    server.stop(run_next_test);
  });
});

add_test(function test_store_empty() {
  _("Test adding no items to an empty repository.");
  let collection = new ServerCollection({}, true);
  let server = httpd_setup({
    "/1.1/john/storage/marbles": collection.handler()
  });
  let repo = new Server11Repository("http://localhost:8080", "john", "marbles");
  let calledDone = false;
  let session = repo.newStoreSession(function storeCallback(error) {
    if (calledDone) {
      do_throw("Did not expect any more items after DONE!");
    }
    do_check_eq(error, DONE);
    calledDone = true;
    do_check_eq(0, collection.count());
    server.stop(run_next_test);
  });
  session.store(DONE);
});

add_test(function test_store() {
  _("Test adding items to repository.");
  let collection = new ServerCollection({}, true);
  let server = httpd_setup({
    "/1.1/john/storage/marbles": collection.handler()
  });
  let repo = new Server11Repository("http://localhost:8080", "john", "marbles");
  let items = [{id: "123412341234", payload: "Bar4"},
               {id: "123412341235", payload: "Bar5"}];

  let calledDone = false;
  let session = repo.newStoreSession(function storeCallback(error) {
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

  for each (record in items) {
    session.store(record);
  }
  session.store(DONE);
});

add_test(function test_store_finish_once_only() {
  let repo = new Server11Repository("http://localhost:8080", "john", "marbles");
  let session;

  session = repo.newStoreSession(function storeCallback(error) {
    let threw;
    try {
      session.store(DONE);
    } catch (ex) {
      threw = ex;
    }
    do_check_eq("Store session already marked as DONE.", threw);
    threw = undefined;
    try {
      session.store({id: "1234567890ab"});
    } catch (ex) {
      threw = ex;
    }
    do_check_eq("Store session already marked as DONE.", threw);

    run_next_test();
  });
  session.store(DONE);
});

add_test(function test_store_batching_incompleteLastBatch() {
  run_next_test(); //TODO
});

add_test(function test_store_batching_completeLastBatch() {
  run_next_test(); //TODO
});

add_test(function test_store_networkError() {
  let repo = new Server11Repository("http://localhost:8080/collection");
  let items = [{id: "123412341234", payload: "Bar4"},
               {id: "123412341235", payload: "Bar5"}];

  let calledDone = false;
  let session = repo.newStoreSession(function storeCallback(error) {
    if (calledDone) {
      do_throw("Did not expect any more items after DONE!");
    }

    if (error != DONE) {
      do_check_eq(error.info.result, Cr.NS_ERROR_CONNECTION_REFUSED);
      do_check_eq(error.guids, "123412341234,123412341235");
      return;
    }

    calledDone = true;
    do_check_eq(error, DONE);
    run_next_test();
  });

  for each (record in items) {
    session.store(record);
  }
  session.store(DONE);
});

add_test(function test_store_httpError() {
  let server = httpd_setup({
    "/1.1/john/storage/marbles": httpd_handler(404, "Not Found", "Cannae\nfind\nit")
  });
  let repo = new Server11Repository("http://localhost:8080", "john", "marbles");

  let items = [{id: "123412341234", payload: "Bar4"},
               {id: "123412341235", payload: "Bar5"}];
  let calledDone = false;
  let session = repo.newStoreSession(function storeCallback(error) {
    if (calledDone) {
      do_throw("Did not expect any more items after DONE!");
    }

    if (error != DONE) {
      do_check_eq(error.info, "Cannae\nfind\nit");
      do_check_eq(error.info.status, 404);
      do_check_eq(error.guids, "123412341234,123412341235");
      return;
    }

    calledDone = true;
    do_check_eq(error, DONE);
    server.stop(run_next_test);
  });

  for each (record in items) {
    session.store(record);
  }
  session.store(DONE);
});

add_test(function test_store_invalidResponse() {
  let server = httpd_setup({
    "/1.1/john/storage/marbles": httpd_handler(200, "OK", "this is invalid JSON")
  });
  let repo = new Server11Repository("http://localhost:8080", "john", "marbles");

  let items = [{id: "123412341234", payload: "Bar4"},
               {id: "123412341235", payload: "Bar5"}];
  let calledDone = false;
  let session = repo.newStoreSession(function storeCallback(error) {
    if (calledDone) {
      do_throw("Did not expect any more items after DONE!");
    }

    if (error != DONE) {
      do_check_eq(error.info.name, "SyntaxError");
      do_check_eq(error.info.message, "JSON.parse: unexpected keyword");
      do_check_eq(error.guids, "123412341234,123412341235");
      return;
    }

    calledDone = true;
    do_check_eq(error, DONE);
    server.stop(run_next_test);
  });

  for each (record in items) {
    session.store(record);
  }
  session.store(DONE);
});
