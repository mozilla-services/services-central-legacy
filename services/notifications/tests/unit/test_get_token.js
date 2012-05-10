function run_test() {
  run_next_test();
}

Cu.import("resource://services-common/async.js");
Cu.import("resource://services-notifications/service.js");

const TOKEN = "TEST";


add_test(function test_get_token_from_server() {
  _("Test getting the token from the server.");

  let server = httpd_setup({
    "/token/": function(request, response) {
      response.setStatusLine(request.httpVersion, 200, "OK");
      response.setHeader("Content-Type", "application/json");

      let body = JSON.stringify({token: TOKEN});
      response.bodyOutputStream.write(body, body.length);
    }
  });

  Service.prefs.set("serverURL", TEST_SERVER_URL);

  Service.getToken(function(error, token) {
    do_check_eq(error, null);
    do_check_eq(token, TOKEN);
    server.stop(run_next_test);
  });
});


add_test(function test_get_token_from_memory() {
  _("The token should be in Service.DB after the previous test.");
  do_check_true(Service.DB.token == TOKEN);

  Service.getToken(function(error, token) {
    do_check_eq(error, null);
    do_check_eq(token, TOKEN);
    run_next_test();
  });
});


add_test(function test_get_token_from_disk() {
  _("The token should have been saved to disk by the previous test.");

  /* Clear out local state, then load again from disk. */
  Service.DB = {};
  let spinner = Async.makeSpinningCallback();
  Service.loadState(spinner);
  let r = spinner.wait();

  do_check_eq(Service.DB.token, TOKEN);

  Service.getToken(function(error, token) {
    do_check_eq(error, null);
    do_check_eq(token, TOKEN);
    run_next_test();
  });
});


add_test(function test_get_token_network_error() {
  _("No token for a network error.");
  Service.DB = {};
  Service.getToken(function(error, token) {
    do_check_eq(error, "NS_ERROR_CONNECTION_REFUSED");
    do_check_eq(token, undefined);
    run_next_test();
  });
});


add_test(function test_get_token_server_error() {
  _("No token for a service error.");
  let server = httpd_setup();

  Service.prefs.set("serverURL", TEST_SERVER_URL);
  Service.getToken(function(error, token) {
    do_check_eq(error, "Service error: 404");
    do_check_eq(token, undefined);
    server.stop(run_next_test);
  });
});


add_test(function test_get_token_from_server() {
  _("Test getting the token from the server.");

  let server = httpd_setup({
    "/token/": function(request, response) {
      response.setStatusLine(request.httpVersion, 200, "OK");
      response.setHeader("Content-Type", "application/json");

      let body = "oops";
      response.bodyOutputStream.write(body, body.length);
    }
  });

  Service.prefs.set("serverURL", TEST_SERVER_URL);

  Service.getToken(function(error, token) {
    do_check_eq(error, "bad json");
    do_check_eq(token, undefined);
    server.stop(run_next_test);
  });
});
