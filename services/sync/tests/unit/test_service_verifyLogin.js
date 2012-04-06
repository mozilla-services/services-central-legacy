Cu.import("resource://services-sync/constants.js");
Cu.import("resource://services-common/log4moz.js");
Cu.import("resource://services-sync/service.js");
Cu.import("resource://services-sync/status.js");
Cu.import("resource://services-sync/util.js");

function login_handling(handler) {
  return function (request, response) {
    if (basic_auth_matches(request, "johndoe", "ilovejane")) {
      handler(request, response);
    } else {
      let body = "Unauthorized";
      response.setStatusLine(request.httpVersion, 401, "Unauthorized");
      response.bodyOutputStream.write(body, body.length);
    }
  };
}

function service_unavailable(request, response) {
  let body = "Service Unavailable";
  response.setStatusLine(request.httpVersion, 503, "Service Unavailable");
  response.setHeader("Retry-After", "42");
  response.bodyOutputStream.write(body, body.length);
}

function run_test() {
  let logger = Log4Moz.repository.rootLogger;
  Log4Moz.repository.rootLogger.addAppender(new Log4Moz.DumpAppender());

  run_next_test();
}

add_test(function test_verifyLogin() {
  // This test expects a clean slate -- no saved passphrase.
  Services.logins.removeAllLogins();
  let johnHelper = track_collections_helper();
  let johnU      = johnHelper.with_updated_collection;
  let johnColls  = johnHelper.collections;

  // TODO 2.0 use new style HTTP server
  let server = httpd_setup({
    "/api/2.0/info/collections": login_handling(johnHelper.handler),

    "/api/2.0/storage/crypto/keys": johnU("crypto", new ServerWBO("keys").handler()),
    "/api/2.0/storage/meta/global": johnU("meta",   new ServerWBO("global").handler()),
    "/user/1.0/johndoe/node/weave": httpd_handler(200, "OK", TEST_SERVER_URL + "api/")
  });

  try {
    Service.serverURL = TEST_SERVER_URL;

    _("Force the initial state.");
    Status.service = STATUS_OK;
    do_check_eq(Status.service, STATUS_OK);

    _("Credentials won't check out because we're not configured yet.");
    Status.resetSync();
    do_check_false(Service.verifyLogin());
    do_check_eq(Status.service, CLIENT_NOT_CONFIGURED);
    do_check_eq(Status.login, LOGIN_FAILED_NO_USERNAME);

    _("Try again with username and password set.");
    Status.resetSync();
    setBasicCredentials("johndoe", "ilovejane", null);
    do_check_false(Service.verifyLogin());
    do_check_eq(Status.service, CLIENT_NOT_CONFIGURED);
    do_check_eq(Status.login, LOGIN_FAILED_NO_PASSPHRASE);

    _("verifyLogin() has found out the user's cluster URL, though.");
    do_check_eq(Service.clusterURL, TEST_SERVER_URL + "api/");

    _("Success if passphrase is set.");
    Status.resetSync();
    Identity.syncKey = "foo";
    do_check_true(Service.verifyLogin());
    do_check_eq(Status.service, STATUS_OK);
    do_check_eq(Status.login, LOGIN_SUCCEEDED);

  } finally {
    Svc.Prefs.resetBranch("");
    server.stop(run_next_test);
  }
});

add_test(function test_verifyLogin_server_failure() {
  let server = httpd_setup({
    "/api/2.0/info/collections": service_unavailable,
    "/user/1.0/janedoe/node/weave": httpd_handler(200, "OK", TEST_SERVER_URL + "api/")
  });

  try {
    Service.serverURL = TEST_SERVER_URL;

    _("If verifyLogin() encounters a server error, it flips on the backoff flag and notifies observers on a 503 with Retry-After.");
    Status.resetSync();
    Identity.account = "janedoe";
    Service._updateCachedURLs();
    do_check_false(Status.enforceBackoff);
    let backoffInterval;
    Svc.Obs.add("weave:service:backoff:interval", function observe(subject, data) {
      Svc.Obs.remove("weave:service:backoff:interval", observe);
      backoffInterval = subject;
    });
    do_check_false(Service.verifyLogin());
    do_check_true(Status.enforceBackoff);
    do_check_eq(backoffInterval, 42);
    do_check_eq(Status.service, LOGIN_FAILED);
    do_check_eq(Status.login, SERVER_MAINTENANCE);

    _("Ensure a network error when finding the cluster sets the right Status bits.");
    Status.resetSync();
    Service.serverURL = "http://localhost:12345/";
    do_check_false(Service.verifyLogin());
    do_check_eq(Status.service, LOGIN_FAILED);
    do_check_eq(Status.login, LOGIN_FAILED_NETWORK_ERROR);

    _("Ensure a network error when getting the collection info sets the right Status bits.");
    Status.resetSync();
    Service.clusterURL = "http://localhost:12345/";
    do_check_false(Service.verifyLogin());
    do_check_eq(Status.service, LOGIN_FAILED);
    do_check_eq(Status.login, LOGIN_FAILED_NETWORK_ERROR);

  } finally {
    Svc.Prefs.resetBranch("");
    server.stop(run_next_test);
  }
});
