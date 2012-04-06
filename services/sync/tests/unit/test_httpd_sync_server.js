Cu.import("resource://services-common/utils.js");

function run_test() {
  Log4Moz.repository.getLogger("Sync.Test.Server").level = Log4Moz.Level.Trace;
  initTestLogging();
  run_next_test();
}

add_test(function test_creation() {
  // Explicit callback for this one.
  let server = new SyncServer({
    __proto__: SyncServerCallback,
  });
  do_check_true(!!server);       // Just so we have a check.
  server.start(null, function () {
    _("Started on " + server.port);
    server.stop(run_next_test);
  });
});

add_test(function test_url_parsing() {
  let server = new SyncServer();

  // Check that we can parse a WBO URI.
  let parts = server.pathRE.exec("/2.0/storage/crypto/keys");
  let [all, version, first, rest] = parts;
  do_check_eq(all, "/2.0/storage/crypto/keys");
  do_check_eq(version, "2.0");
  do_check_eq(first, "storage");
  do_check_eq(rest, "crypto/keys");
  do_check_eq(null, server.pathRE.exec("/nothing/else"));

  // Check that we can parse a collection URI.
  parts = server.pathRE.exec("/2.0/storage/crypto");
  let [all, version, first, rest] = parts;
  do_check_eq(all, "/2.0/storage/crypto");
  do_check_eq(version, "2.0");
  do_check_eq(first, "storage");
  do_check_eq(rest, "crypto");

  // We don't allow trailing slash on storage URI.
  parts = server.pathRE.exec("/2.0/storage/");
  do_check_eq(parts, undefined);

  // storage alone is a valid request.
  parts = server.pathRE.exec("/2.0/storage");
  let [all, version, first, rest] = parts;
  do_check_eq(all, "/2.0/storage");
  do_check_eq(version, "2.0");
  do_check_eq(first, "storage");
  do_check_eq(rest, undefined);

  parts = server.storageRE.exec("storage");
  let [all, storage, collection, id] = parts;
  do_check_eq(all, "storage");
  do_check_eq(collection, undefined);

  run_next_test();
});

Cu.import("resource://services-common/rest.js");
function localRequest(path, user, password) {
  _("localRequest: " + path);
  let url = "http://127.0.0.1:8080" + path;
  _("url: " + url);
  let req = new RESTRequest(url);

  let header = basic_auth_header(user || "john", password || "password");
  req.setHeader("Authorization", header);

  return req;
}

add_test(function test_basic_http() {
  let server = new SyncServer();
  server.registerUser("john", "password");
  do_check_true(server.userExists("john"));
  server.start(8080, function () {
    _("Started on " + server.port);
    do_check_eq(server.port, 8080);
    Utils.nextTick(function () {
      let req = localRequest("/2.0/storage/crypto/keys");
      _("req is " + req);
      req.get(function (err) {
        do_check_eq(null, err);
        Utils.nextTick(function () {
          server.stop(run_next_test);
        });
      });
    });
  });
});

add_test(function test_info_collections() {
  let server = new SyncServer({
    __proto__: SyncServerCallback
  });
  function responseHasCorrectHeaders(r) {
    if (r.status == 200) {
      do_check_eq(r.headers["content-type"], "application/json");
    } else if (r.status == 204) {
      do_check_true(!("content-type" in r.headers));
    } else {
      _("Invalid response code seen: " + r.status);
      do_check_true(false);
    }

    do_check_true("x-timestamp" in r.headers);
  }

  server.registerUser("john", "password");
  server.start(8080, function () {
    do_check_eq(server.port, 8080);
    CommonUtils.waitForNextTick();
    let req = localRequest("/2.0/info/collections");
    req.get(function (err) {
      // Initial info/collections fetch is empty.
      do_check_eq(null, err);
      responseHasCorrectHeaders(this.response);

      do_check_eq(this.response.body, "{}");
      CommonUtils.waitForNextTick();
      // When we PUT something to crypto/keys, "crypto" appears in the response.
      function cb(err) {
        do_check_eq(null, err);
        responseHasCorrectHeaders(this.response);
        let putResponseBody = this.response.body;
        _("PUT response body: " + JSON.stringify(putResponseBody));

        req = localRequest("/2.0/info/collections");
        req.get(function (err) {
          do_check_eq(null, err);
          responseHasCorrectHeaders(this.response);
          let expectedColl = server.getCollection("john", "crypto");
          do_check_true(!!expectedColl);
          let modified = expectedColl.timestamp;
          do_check_true(modified > 0);
          CommonUtils.waitForNextTick();
          server.stop(run_next_test);
        });
      }
      let payload = JSON.stringify({foo: "bar"});
      localRequest("/2.0/storage/crypto/keys").put(payload, cb);
    });
  });
});

add_test(function test_storage_request() {
  let keysURL = "/2.0/storage/crypto/keys?foo=bar";
  let foosURL = "/2.0/storage/crypto/foos";
  let storageURL = "/2.0/storage";

  let server = new SyncServer();
  let creation = server.timestamp();
  server.registerUser("john", "password");

  server.createContents("john", {
    crypto: {foos: {foo: "bar"}}
  });
  let coll = server.user("john").collection("crypto");
  do_check_true(!!coll);

  _("We're tracking timestamps.");
  do_check_true(coll.timestamp >= creation);

  function retrieveWBONotExists(next) {
    let req = localRequest(keysURL);
    req.get(function (err) {
      _("Body is " + this.response.body);
      _("Modified is " + this.response.newModified);
      do_check_eq(null, err);
      do_check_eq(this.response.status, 404);
      do_check_eq(this.response.body, "Not found");
      Utils.nextTick(next);
    });
  }
  function retrieveWBOExists(next) {
    let req = localRequest(foosURL);
    req.get(function (err) {
      _("Body is " + this.response.body);
      _("Modified is " + this.response.newModified);
      let parsedBody = JSON.parse(this.response.body);
      do_check_eq(parsedBody.id, "foos");
      do_check_eq(parsedBody.modified, coll.wbo("foos").modified);
      do_check_eq(JSON.parse(parsedBody.payload).foo, "bar");
      Utils.nextTick(next);
    });
  }
  function deleteWBONotExists(next) {
    let req = localRequest(keysURL);
    server.callback.onItemDeleted = function (username, collection, wboID) {
      do_throw("onItemDeleted should not have been called.");
    };
      
    req.delete(function (err) {
      _("Body is " + this.response.body);
      _("Modified is " + this.response.newModified);
      do_check_eq(this.response.status, 200);
      delete server.callback.onItemDeleted;
      Utils.nextTick(next);
    });
  }
  function deleteWBOExists(next) {
    let req = localRequest(foosURL);
    server.callback.onItemDeleted = function (username, collection, wboID) {
      _("onItemDeleted called for " + collection + "/" + wboID);
      delete server.callback.onItemDeleted;
      do_check_eq(username, "john");
      do_check_eq(collection, "crypto");
      do_check_eq(wboID, "foos");
      Utils.nextTick(next);
    };
      
    req.delete(function (err) {
      _("Body is " + this.response.body);
      _("Modified is " + this.response.newModified);
      do_check_eq(this.response.status, 200);
    });
  }
  function deleteStorage(next) {
    _("Testing DELETE on /storage.");
    let now = server.timestamp();
    _("Timestamp: " + now);
    let req = localRequest(storageURL);
    req.delete(function (err) {
      _("Body is " + this.response.body);
      _("Modified is " + this.response.newModified);
      let parsedBody = JSON.parse(this.response.body);
      do_check_true(parsedBody >= now);
      do_check_empty(server.users["john"].collections);
      Utils.nextTick(next);
    });
  }
  function getStorageFails(next) {
    _("Testing that GET on /storage fails.");
    let req = localRequest(storageURL);
    req.get(function (err) {
      do_check_eq(this.response.status, 405);
      do_check_eq(this.response.headers["allow"], "DELETE");
      Utils.nextTick(next);
    });
  }
  function getMissingCollectionWBO(next) {
    _("Testing that fetching a WBO from an on-existent collection 404s.");
    let req = localRequest(storageURL + "/foobar/baz");
    req.get(function (err) {
      do_check_eq(this.response.status, 404);
      Utils.nextTick(next);
    });
  }

  server.start(8080,
    Async.chain(
      retrieveWBONotExists,
      retrieveWBOExists,
      deleteWBOExists,
      deleteWBONotExists,
      getStorageFails,
      getMissingCollectionWBO,
      deleteStorage,
      server.stop.bind(server),
      run_next_test
    ));
});

add_test(function test_x_weave_records() {
  let server = new SyncServer();
  server.registerUser("john", "password");

  server.createContents("john", {
    crypto: {foos: {foo: "bar"},
             bars: {foo: "baz"}}
  });
  server.start(8080, function () {
    let wbo = localRequest("/2.0/storage/crypto/foos");
    wbo.get(function (err) {
      // WBO fetches don't have one.
      do_check_false("x-num-records" in this.response.headers);
      let col = localRequest("/2.0/storage/crypto");
      col.get(function (err) {
        // Collection fetches do.
        do_check_eq(this.response.headers["x-num-records"], "2");
        server.stop(run_next_test);
      });
    });
  });
});
