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
  let server = new SyncServer();
  let john   = server.registerUser("john", "password");

  let marbles = john.createCollection("marbles");
  let i = 0;
  for each (let guid in guids) {
    marbles.insert(guid, {}, ++i * 1000);
  }
  server.start();
  let repo = new Server11Repository("http://localhost:8080", "john", "marbles");
  return [repo, server, marbles];
}

function run_test() {
  initTestLogging();
  Log4Moz.repository.getLogger("Sync.StorageRequest").level = Log4Moz.Trace;
  run_next_test();
}

function withSession(repo, f) {
  repo.createSession(null, function (err, session) {
    do_check_true(!err);
    session.begin(function (err) {
      do_check_true(!err);
      f(session);
    });
  });
}

function finish(session, server) {
  session.finish(function () {
    if (server) {
      server.stop(run_next_test);
    } else {
      run_next_test();
    }
  });
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
  withSession(repo, function (session) {
    session.guidsSince(2000, function guidsCallback(error, guids) {
      do_check_eq(error, null);
      do_check_eq(expected + "", guids.sort());
      finish(session, server);
    });
  });
});

add_test(function test_guidsSince_networkError() {
  let repo = new Server11Repository("http://localhost:8080", "john", "marbles");
  withSession(repo, function (session) {
    session.guidsSince(2000, function guidsCallback(error, guids) {
      do_check_eq(guids, null);
      do_check_neq(error, null);
      do_check_eq(error.result, Cr.NS_ERROR_CONNECTION_REFUSED);
      finish(session);
    });
  });
});

add_test(function test_guidsSince_httpError() {
  let server = httpd_setup({
    "/1.1/john/storage/marbles": httpd_handler(404, "Not Found", "Cannae\nfind\nit")
  });
  let repo = new Server11Repository("http://localhost:8080", "john", "marbles");
  withSession(repo, function (session) {
    session.guidsSince(2000, function guidsCallback(error, guids) {
      do_check_eq(guids, null);
      do_check_neq(error, null);
      do_check_eq(error.status, 404);
      do_check_eq(error.body, "Cannae\nfind\nit");
      finish(session, server);
    });
  });
});

add_test(function test_guidsSince_invalidJSON() {
  let server = httpd_setup({
    "/1.1/john/storage/marbles": httpd_handler(200, "OK", "this is invalid JSON")
  });
  let repo = new Server11Repository("http://localhost:8080", "john", "marbles");
  withSession(repo, function (session) {
    session.guidsSince(2000, function guidsCallback(error, guids) {
      do_check_eq(guids, null);
      do_check_neq(error, null);
      do_check_eq(error.name, "SyntaxError");
      do_check_eq(error.message, "JSON.parse: unexpected keyword");
      finish(session, server);
    });
  });
});

add_test(function test_fetchSince() {
  let [repo, server] = setup_fixtures();
  let expected = ["123456789012", "charliesheen", "trololololol"];
  let calledDone = false;
  withSession(repo, function (session) {
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
      finish(session, server);
    });
  });
});

add_test(function test_fetchSince_networkError() {
  let repo = new Server11Repository("http://localhost:8080", "john", "marbles");
  withSession(repo, function (session) {
    session.fetchSince(2000, function fetchCallback(error, record) {
      do_check_eq(record, DONE);
      do_check_neq(error, null);
      do_check_eq(error.result, Cr.NS_ERROR_CONNECTION_REFUSED);
      finish(session);
    });
  });
});

add_test(function test_fetchSince_httpError() {
  let server = httpd_setup({
    "/1.1/john/storage/marbles": httpd_handler(404, "Not Found", "Cannae\nfind\nit")
  });
  let repo = new Server11Repository("http://localhost:8080", "john", "marbles");
  let calledDone = false;
  withSession(repo, function (session) {
    session.fetchSince(2000, function fetchCallback(error, record) {
      if (calledDone) {
        do_throw("Did not expect any more items after DONE!");
      }

      do_check_eq(record, DONE);
      calledDone = true;
      do_check_neq(error, null);
      do_check_eq(error.status, 404);
      do_check_eq(error.body, "Cannae\nfind\nit");
      finish(session, server);
    });
  });
});

add_test(function test_fetchSince_invalidJSON() {
  let server = httpd_setup({
    "/1.1/john/storage/marbles": httpd_handler(200, "OK", "this is invalid JSON")
  });
  let repo = new Server11Repository("http://localhost:8080", "john", "marbles");
  let calledDone = false;
  withSession(repo, function (session) {
    session.fetchSince(2000, function fetchCallback(error, record) {
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
      finish(session, server);
    });
  });
});

add_test(function test_fetchSince_STOP() {
  run_next_test(); //TODO
});

add_test(function test_fetch() {
  let [repo, server] = setup_fixtures();
  let guids = ["123456789012", "non-existent", "charliesheen", "trololololol"];
  let expected = ["123456789012", "charliesheen", "trololololol"];
  let calledDone = false;
  withSession(repo, function (session) {
    session.fetch(guids, function fetchCallback(error, record) {
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
      finish(session, server);
    });
  });
});

add_test(function test_fetch_networkError() {
  let repo = new Server11Repository("http://localhost:8080", "john", "marbles");
  withSession(repo, function (session) {
    session.fetch(["trololololol"], function fetchCallback(error, record) {
      do_check_eq(record, DONE);
      do_check_neq(error, null);
      do_check_eq(error.result, Cr.NS_ERROR_CONNECTION_REFUSED);
      finish(session);
    });
  });
});

add_test(function test_fetch_httpError() {
  let server = httpd_setup({
    "/1.1/john/storage/marbles": httpd_handler(404, "Not Found", "Cannae\nfind\nit")
  });
  let repo = new Server11Repository("http://localhost:8080", "john", "marbles");
  let calledDone = false;
  withSession(repo, function (session) {
    session.fetch(["trololololol"], function fetchCallback(error, record) {
      if (calledDone) {
        do_throw("Did not expect any more items after DONE!");
      }

      do_check_eq(record, DONE);
      calledDone = true;
      do_check_neq(error, null);
      do_check_eq(error.status, 404);
      do_check_eq(error.body, "Cannae\nfind\nit");
      finish(session, server);
    });
  });
});

add_test(function test_fetch_invalidJSON() {
  let server = httpd_setup({
    "/1.1/john/storage/marbles": httpd_handler(200, "OK", "this is invalid JSON")
  });
  let repo = new Server11Repository("http://localhost:8080", "john", "marbles");
  let calledDone = false;
  withSession(repo, function (session) {
    session.fetch(["trololololol"], function fetchCallback(error, record) {
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
      finish(session, server);
    });
  });
});

add_test(function test_fetch_STOP() {
  run_next_test(); //TODO
});

add_test(function test_store_empty() {
  _("Test adding no items to an empty repository.");
  let collection = new ServerCollection({}, true);
  let server = httpd_setup({
    "/1.1/john/storage/marbles": collection.handler()
  });
  let repo = new Server11Repository("http://localhost:8080", "john", "marbles");
  let calledDone = false;
  let session;
  function storeCallback(error) {
    if (calledDone) {
      do_throw("Did not expect any more items after DONE!");
    }
    do_check_eq(error, DONE);
    calledDone = true;
    do_check_eq(0, collection.count());
    finish(session, server);
  }
  function sessionCallback(err, sess) {
    do_check_true(!err);
    session = sess;
    session.begin(function (err) {
      do_check_true(!err);
      session.store(DONE);
    });
  }
  repo.createSession(storeCallback, sessionCallback);
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
  let session;
  function storeCallback(error) {
    if (calledDone) {
      do_throw("Did not expect any more items after DONE!");
    }
    do_check_eq(error, DONE);
    calledDone = true;
    do_check_eq(2, collection.count());
    do_check_eq("Bar4", collection.wbos["123412341234"].payload);
    do_check_eq("Bar5", collection.wbos["123412341235"].payload);
    do_check_eq(undefined, collection.wbos["123412341230"]);
    finish(session, server);
  }
  function sessionCallback(err, sess) {
    do_check_false(!!err);
    session = sess;
    session.begin(function (err) {
      do_check_true(!err);
      for each (record in items) {
        session.store(record);
      }
      session.store(DONE);
    });
  }
  repo.createSession(storeCallback, sessionCallback);
});

add_test(function test_store_finish_once_only() {
  _("Test that calling store after a DONE will raise an error.");

  let repo = new Server11Repository("http://localhost:8080", "john", "marbles");
  let session;
  function storeCallback(error) {
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
    finish(session);
  }
  function sessionCallback(err, sess) {
    do_check_true(!err);
    session = sess;
    session.begin(function (err) {
      do_check_true(!err);
      session.store(DONE);
    });
  }
  repo.createSession(storeCallback, sessionCallback);
});

add_test(function test_store_batching_completeLastBatch() {
  _("Test batching within a store session.");

  let invoked = 0;
  let repo = new Server11Repository("http://localhost:8080", "john", "marbles");
  let session;
  function storeCallback(error) {
    do_check_eq(invoked, 3);
    do_check_eq(session.flushQueue.length, 2);
    do_check_true(session.done);
    finish(session);
  }
  function sessionCallback(err, sess) {
    session = sess;
    do_check_false(!!err);
    do_check_eq(session.flushQueue.length, 0);

    session.flush = function () {
      invoked++;
      let batchCount = session.flushQueue.length;
      let lastBatchSize = session.flushQueue[batchCount - 1].length;

      if (session.done) {
        session.storeCallback();
        return;
      }
      do_check_eq(batchCount, invoked);
      do_check_eq(lastBatchSize, session.batchSize);
    };

    session.batchSize = 2;
    do_check_false(session.done);
    session.store({id: "123412341234", payload: "Bar4"});
    do_check_eq(invoked, 0);
    session.store({id: "123412341235", payload: "Bar5"});
    do_check_eq(invoked, 1);
    session.store({id: "123412341236", payload: "Bar6"});
    do_check_eq(invoked, 1);
    session.store({id: "123412341237", payload: "Bar7"});
    do_check_eq(invoked, 2);
    session.store(DONE);
  }
  repo.createSession(storeCallback, sessionCallback);
});

add_test(function test_store_batching_incompleteLastBatch() {
  _("Test batching within a store session, where the last batch is incomplete.");

  let invoked = 0;
  let repo = new Server11Repository("http://localhost:8080", "john", "marbles");
  let session;
  function storeCallback(error) {
    do_check_eq(invoked, 2);
    do_check_eq(session.flushQueue.length, 2);
    do_check_eq(session.flushQueue[0].length, 2);
    do_check_eq(session.flushQueue[1].length, 1);
    do_check_true(session.done);
    finish(session);
  }
  function sessionCallback(err, sess) {
    session = sess;
    do_check_false(!!err);
    do_check_eq(session.flushQueue.length, 0);

    session.flush = function () {
      invoked++;
      let batchCount = session.flushQueue.length;
      let lastBatchSize = session.flushQueue[batchCount - 1].length;

      if (session.done) {
        session.storeCallback();
        return;
      }
      do_check_eq(batchCount, invoked);
      do_check_eq(lastBatchSize, session.batchSize);
    };

    session.batchSize = 2;
    do_check_false(session.done);
    session.store({id: "123412341234", payload: "Bar4"});
    do_check_eq(invoked, 0);
    session.store({id: "123412341235", payload: "Bar5"});
    do_check_eq(invoked, 1);
    session.store({id: "123412341236", payload: "Bar6"});
    do_check_eq(invoked, 1);
    session.store(DONE);
  }
  repo.createSession(storeCallback, sessionCallback);
});

add_test(function test_store_networkError() {
  let repo = new Server11Repository("http://localhost:8080/collection");
  let items = [{id: "123412341234", payload: "Bar4"},
               {id: "123412341235", payload: "Bar5"}];

  let calledDone = false;
  let session;
  function storeCallback(error) {
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
    finish(session);
  }
  function sessionCallback(err, sess) {
    do_check_false(!!err);
    session = sess;
    for each (record in items) {
      session.store(record);
    }
    session.store(DONE);
  }
  repo.createSession(storeCallback, sessionCallback);
});

add_test(function test_store_httpError() {
  let server = httpd_setup({
    "/1.1/john/storage/marbles": httpd_handler(404, "Not Found", "Cannae\nfind\nit")
  });
  let repo = new Server11Repository("http://localhost:8080", "john", "marbles");

  let items = [{id: "123412341234", payload: "Bar4"},
               {id: "123412341235", payload: "Bar5"}];
  let calledDone = false;
  let session;
  function storeCallback(error) {
    if (calledDone) {
      do_throw("Did not expect any more items after DONE!");
    }

    if (error != DONE) {
      do_check_eq(error.info.body, "Cannae\nfind\nit");
      do_check_eq(error.info.status, 404);
      do_check_eq(error.guids, "123412341234,123412341235");
      return;
    }

    calledDone = true;
    do_check_eq(error, DONE);
    finish(session, server);
  }
  function sessionCallback(err, sess) {
    do_check_false(!!err);
    session = sess;
    for each (record in items) {
      session.store(record);
    }
    session.store(DONE);
  }
  repo.createSession(storeCallback, sessionCallback);
});

add_test(function test_store_invalidResponse() {
  let server = httpd_setup({
    "/1.1/john/storage/marbles": httpd_handler(200, "OK", "this is invalid JSON")
  });
  let repo = new Server11Repository("http://localhost:8080", "john", "marbles");

  let items = [{id: "123412341234", payload: "Bar4"},
               {id: "123412341235", payload: "Bar5"}];
  let calledDone = false;
  let session;
  function storeCallback(error) {
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
    finish(session, server);
  }
  function sessionCallback(err, sess) {
    do_check_false(!!err);
    session = sess;
    for each (record in items) {
      session.store(record);
    }
    session.store(DONE);
  }
  repo.createSession(storeCallback, sessionCallback);
});

add_test(function test_wipe() {
  _("Test wiping a server repository.");
  let items = [{id: "123412341234", payload: "Bar4"},
               {id: "123412341235", payload: "Bar5"}];
  let collection = new ServerCollection({}, true);
  collection.post(JSON.stringify(items));
  let server = httpd_setup({
    "/1.1/john/storage/marbles": collection.handler()
  });
  let repo = new Server11Repository("http://localhost:8080", "john", "marbles");

  withSession(repo, function (session) {
    session.guidsSince(0, function (error, guids) {
      _("Check preconditions: 2 GUIDs.");
      do_check_false(!!error);
      do_check_eq(2, guids.length);

      _("Wiping removes items.");
      session.wipe(function (error) {
        do_check_false(!!error);
        session.guidsSince(0, function (error, guids) {
          _("Check postconditions: 0 GUIDs.");
          do_check_false(!!error);
          do_check_eq(0, guids.length);
          finish(session, server);
        });
      });
    });
  });
});

add_test(function test_wipe_empty() {
  _("Test wiping an empty server repository.");
  let collection = new ServerCollection({}, true);
  let server = httpd_setup({
    "/1.1/john/storage/marbles": collection.handler()
  });
  let repo = new Server11Repository("http://localhost:8080", "john", "marbles");

  withSession(repo, function (session) {
    session.guidsSince(0, function (error, guids) {
      _("Check preconditions: 0 GUIDs.");
      do_check_false(!!error);
      do_check_eq(0, guids.length);

      session.wipe(function (error) {
        do_check_false(!!error);
        session.guidsSince(0, function (error, guids) {
          _("Check postconditions: 0 GUIDs.");
          do_check_false(!!error);
          do_check_eq(0, guids.length);
          finish(session, server);
        });
      });
    });
  });
});

add_test(function test_wipe_httpError() {
  run_next_test(); //TODO
});

add_test(function test_wipe_networkError() {
  run_next_test(); //TODO
});
