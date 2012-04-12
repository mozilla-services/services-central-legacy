/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

Cu.import("resource://services-sync/client.js");
Cu.import("resource://services-sync/constants.js");
Cu.import("resource://services-sync/record.js");

const DEFAULT_USERNAME = "johndoe";
const DEFAULT_PASSWORD = "IAMJOHN";
const BASE_URI = "http://localhost:8080/2.0";

function run_test() {
  initTestLogging("Trace");

  run_next_test();
}

function getServer(user, password) {
  let user = user || DEFAULT_USERNAME;
  let password = password || DEFAULT_PASSWORD;

  let users = {};
  users[user] = password;

  return storageServerForUsers(users, {
    meta: {global: {syncID: "globalSyncID", storageVersion: 5, engines: {}}},
    clients: {},
    crypto: {},
  });
}

function getClient(user, password) {
  let user = user || DEFAULT_USERNAME;
  let password = password || DEFAULT_PASSWORD;

  let client = new SyncClient(BASE_URI + "/" + user);
  client.addListener({
    onDispatch: function onDispatch(client, request) {
      let up = user + ":" + password;
      request.request.setHeader("authorization", "Basic " + btoa(up));
    }
  });

  return client;
}

add_test(function test_user_agent() {
  _("Ensure the user agent of requests is proper.");

  let expectedAgent = Services.appinfo.name + "/" + Services.appinfo.version +
                      " FxSync/" + WEAVE_VERSION + "." +
                      Services.appinfo.appBuildID + "." +
                      Svc.Prefs.get("client.type", "desktop");

  let requestReceived = false;
  let server = getServer();
  server.callback.onRequest = function(request) {
    do_check_true(request.hasHeader("user-agent"));
    _("Received agent: " + request.getHeader("user-agent"));
    do_check_eq(request.getHeader("user-agent"), expectedAgent);

    requestReceived = true;
  };

  let client = getClient();
  let request = client.getCollectionInfo();
  request.onComplete = function() {
    do_check_eq(this.error, null);
    do_check_true(requestReceived);

    server.stop(run_next_test);
  };
  request.dispatch();
});

add_test(function test_metaglobal_success() {
  _("Ensure metaglobal fetching in the success case works as expected.");

  let server = getServer();
  let client = getClient();
  client.fetchMetaGlobal(function onResult(error, mg) {
    do_check_eq(null, error);
    do_check_true(mg instanceof MetaGlobalRecord);

    // Only a simple smoketest is needed.
    do_check_eq(mg.storageVersion, 5);

    server.stop(run_next_test);
  });
});

add_test(function test_metaglobal_network_error() {
  _("Ensure that network errors when fetching metaglobals are handled properly.");

  let client = new SyncClient("http://mozilla-sync-server.DOESNOTEXIST/");
  client.fetchMetaGlobal(function onResult(error, mg) {
    do_check_true(error instanceof MetaGlobalRequestError);
    do_check_eq(mg, null);

    do_check_eq(error.condition, MetaGlobalRequestError.NETWORK);

    run_next_test();
  });
});

add_test(function test_metaglobal_404() {
  _("Ensure that a 404 on the metaglobal response is handled correctly.");

  let server = getServer();
  let client = getClient();

  let coll = server.user(DEFAULT_USERNAME).collection("meta");
  coll.remove("global");

  client.fetchMetaGlobal(function onResult(error, mg) {
    do_check_true(error instanceof MetaGlobalRequestError);
    do_check_eq(mg, null);

    do_check_eq(error.condition, MetaGlobalRequestError.NOT_FOUND);

    server.stop(run_next_test);
  });
});
