/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

Cu.import("resource://services-sync/identity.js");
Cu.import("resource://services-sync/storageservice.js");

const BASE_URI = "http://localhost:8080/2.0";

function run_test() {
  initTestLogging("Trace");

  run_next_test();
}

function getEmptyServer(user, password) {
  let user = user || "foo";
  let password = password || "password";

  let users = {};
  users[user] = password;

  return serverForUsers(users, {
    meta: {global: {engines: {}}},
    clients: {},
    crypto: {},
  });
}

function getClient(user, password) {
  let user = user || "foo";
  let password = password || "password";

  let client = new StorageServiceClient(BASE_URI);
  client.addListener({
    onDispatch: function onDispatch(client, request) {
      let up = user + ":" + password;
      request.request.setHeader("authorization", "Basic " + btoa(up));
    }
  });

  return client;
}

add_test(function test_auth_failure_listener() {
  _("Ensure the onAuthFailure listener is invoked.");

  let server = getEmptyServer();
  let client = getClient("DOESNOTEXIST", "INVALID");
  client.addListener({
    onAuthFailure: function onAuthFailure(client, request) {
      server.stop(run_next_test);
    }
  });

  let req = client.getCollectionInfo();
  req.dispatch();
});

add_test(function test_info_collections() {
  _("Ensure requests to /info/collections work as expected.");

  let server = getEmptyServer();
  let client = getClient();

  let request = client.getCollectionInfo();
  request.dispatch(function(error, req) {
    do_check_eq(null, error);
    do_check_eq("object", typeof req.resultObj);
    do_check_attribute_count(req.resultObj, 3);
    do_check_true("meta" in req.resultObj);

    server.stop(run_next_test);
  });
});

add_test(function test_get_bso() {
  _("Ensure that simple BSO fetches work.");

  let server = getEmptyServer();

  server.createCollection("foo", "testcoll", {
    abc123: new ServerWBO("abc123", "payload", Date.now())
  });

  let client = getClient();
  let request = client.getBSO("testcoll", "abc123");
  request.dispatch(function(error, req) {
    do_check_true(req.success);
    do_check_eq(null, error);
    do_check_true(req.resultObj instanceof BasicStorageObject);

    let bso = req.resultObj;
    do_check_eq(bso.id, "abc123");
    do_check_eq(bso.payload, "payload");

    server.stop(run_next_test);
  });
});

add_test(function test_set_bso() {
  _("Ensure simple BSO PUT works.");

  let server = getEmptyServer();
  let client = getClient();
  let id = Utils.makeGUID();

  let bso = new BasicStorageObject(id, "testcoll");
  bso.payload = "my test payload";

  let request = client.setBSO("testcoll", id, bso);
  request.dispatch(function(error, req) {
    do_check_true(req.success);
    do_check_eq(error, null);
    do_check_eq(req.resultObj, null);

    server.stop(run_next_test);
  });
});

add_test(function test_set_bso_argument_errors() {
  _("Ensure BSO set detects invalid arguments.");

  let bso = new BasicStorageObject("foobar", "testcoll");
  let client = getClient();

  try {
    client.setBSO("testcoll", "ID", bso);
    do_check_true(false);
  } catch (ex) {
    do_check_eq(ex.name, "Error");
    do_check_eq(ex.message.indexOf("id in passed BSO"), 0);
  }

  run_next_test();
});

add_test(function test_network_error_captured() {
  _("Ensure network errors are captured.");

  // Network errors should result in .networkError being set on request.
  let client = new StorageServiceClient("http://rnewman-is-splendid.badtld/");

  let request = client.getCollectionInfo();
  request.dispatch(function(error, req) {
    //do_check_false(request.success);
    do_check_neq(error, null);
    do_check_neq(error.network, null);

    run_next_test();
  });
});

add_test(function test_network_error_listener() {
  _("Ensure the onNetworkError listener is invoked on network errors.");

  let listenerCalled = false;

  let client = new StorageServiceClient("http://philikon-is-too.badtld/");
  client.addListener({
    onNetworkError: function(client, request) {
      listenerCalled = true;
    }
  });
  let request = client.getCollectionInfo();
  request.dispatch(function() {
    do_check_true(listenerCalled);
    run_next_test();
  });
});
