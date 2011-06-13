Cu.import("resource://services-sync/ext/Observers.js");
Cu.import("resource://services-sync/identity.js");
Cu.import("resource://services-sync/log4moz.js");
Cu.import("resource://services-sync/resource.js");
Cu.import("resource://services-sync/util.js");

let logger;

function server_open(metadata, response) {
  let body;
  if (metadata.method == "GET") {
    body = "This path exists";
    response.setStatusLine(metadata.httpVersion, 200, "OK");
  } else {
    body = "Wrong request method";
    response.setStatusLine(metadata.httpVersion, 405, "Method Not Allowed");
  }
  response.bodyOutputStream.write(body, body.length);
}

function server_protected(metadata, response) {
  let body;

  if (basic_auth_matches(metadata, "guest", "guest")) {
    body = "This path exists and is protected";
    response.setStatusLine(metadata.httpVersion, 200, "OK, authorized");
    response.setHeader("WWW-Authenticate", 'Basic realm="secret"', false);
  } else {
    body = "This path exists and is protected - failed";
    response.setStatusLine(metadata.httpVersion, 401, "Unauthorized");
    response.setHeader("WWW-Authenticate", 'Basic realm="secret"', false);
  }

  response.bodyOutputStream.write(body, body.length);
}

function server_404(metadata, response) {
  let body = "File not found";
  response.setStatusLine(metadata.httpVersion, 404, "Not Found");
  response.bodyOutputStream.write(body, body.length);
}


let sample_data = {
  some: "sample_data",
  injson: "format",
  number: 42
};

function server_upload(metadata, response) {
  let body;

  let input = readBytesFromInputStream(metadata.bodyInputStream);
  if (input == JSON.stringify(sample_data)) {
    body = "Valid data upload via " + metadata.method;
    response.setStatusLine(metadata.httpVersion, 200, "OK");
  } else {
    body = "Invalid data upload via " + metadata.method + ': ' + input;
    response.setStatusLine(metadata.httpVersion, 500, "Internal Server Error");
  }

  response.bodyOutputStream.write(body, body.length);
}

function server_delete(metadata, response) {
  let body;
  if (metadata.method == "DELETE") {
    body = "This resource has been deleted";
    response.setStatusLine(metadata.httpVersion, 200, "OK");
  } else {
    body = "Wrong request method";
    response.setStatusLine(metadata.httpVersion, 405, "Method Not Allowed");
  }
  response.bodyOutputStream.write(body, body.length);
}

function server_json(metadata, response) {
  let body = JSON.stringify(sample_data);
  response.setStatusLine(metadata.httpVersion, 200, "OK");
  response.bodyOutputStream.write(body, body.length);
}

function server_line_by_line(metadata, response) {
  let body = "";
  for each (let item in [123, 456, 789]) {
    body += JSON.stringify({"foo": item}) + "\n";
  }
  response.setStatusLine(metadata.httpVersion, 200, "OK");
  response.bodyOutputStream.write(body, body.length);
}

const TIMESTAMP = 1274380461;

function server_timestamp(metadata, response) {
  let body = "Thank you for your request";
  response.setHeader("X-Weave-Timestamp", ''+TIMESTAMP, false);
  response.setStatusLine(metadata.httpVersion, 200, "OK");
  response.bodyOutputStream.write(body, body.length);
}

function server_backoff(metadata, response) {
  let body = "Hey, back off!";
  response.setHeader("X-Weave-Backoff", '600', false);
  response.setStatusLine(metadata.httpVersion, 200, "OK");
  response.bodyOutputStream.write(body, body.length);
}

function server_quota_notice(request, response) {
  let body = "You're approaching quota.";
  response.setHeader("X-Weave-Quota-Remaining", '1048576', false);
  response.setStatusLine(request.httpVersion, 200, "OK");
  response.bodyOutputStream.write(body, body.length);
}

function server_quota_error(request, response) {
  let body = "14";
  response.setHeader("X-Weave-Quota-Remaining", '-1024', false);
  response.setStatusLine(request.httpVersion, 400, "OK");
  response.bodyOutputStream.write(body, body.length);
}

function server_headers(metadata, response) {
  let ignore_headers = ["host", "user-agent", "accept", "accept-language",
                        "accept-encoding", "accept-charset", "keep-alive",
                        "connection", "pragma", "cache-control",
                        "content-length"];
  let headers = metadata.headers;
  let header_names = [];
  while (headers.hasMoreElements()) {
    let header = headers.getNext().toString();
    if (ignore_headers.indexOf(header) == -1) {
      header_names.push(header);
    }
  }
  header_names = header_names.sort();

  headers = {};
  for each (let header in header_names) {
    headers[header] = metadata.getHeader(header);
  }
  let body = JSON.stringify(headers);
  response.setStatusLine(metadata.httpVersion, 200, "OK");
  response.bodyOutputStream.write(body, body.length);
}

let did401 = false;
Observers.add("weave:resource:status:401", function() { did401 = true; });

let quotaValue;
Observers.add("weave:service:quota:remaining",
              function (subject) { quotaValue = subject; });

let server;

function run_test() {
  logger = Log4Moz.repository.getLogger('Test');
  Log4Moz.repository.rootLogger.addAppender(new Log4Moz.DumpAppender());

  server = httpd_setup({
    "/open": server_open,
    "/protected": server_protected,
    "/404": server_404,
    "/upload": server_upload,
    "/delete": server_delete,
    "/json": server_json,
    "/line-by-line": server_line_by_line,
    "/timestamp": server_timestamp,
    "/headers": server_headers,
    "/backoff": server_backoff,
    "/quota-notice": server_quota_notice,
    "/quota-error": server_quota_error
  });

  Svc.Prefs.set("network.numRetries", 1); // speed up test
  run_next_test();
}


add_test(function test_members() {
  _("Resource object memebers");
  let res = new AsyncResource("http://localhost:8080/open");
  do_check_true(res.uri instanceof Ci.nsIURI);
  do_check_eq(res.uri.spec, "http://localhost:8080/open");
  do_check_eq(res.spec, "http://localhost:8080/open");
  do_check_eq(typeof res.headers, "object");
  do_check_eq(typeof res.authenticator, "object");
  // Initially res.data is null since we haven't performed a GET or
  // PUT/POST request yet.
  do_check_eq(res.data, null);

  run_next_test();
});

add_test(function test_get() {
  _("GET a non-password-protected resource");
  let res = new AsyncResource("http://localhost:8080/open");
  res.get(function (error, content) {
    do_check_eq(error, null);
    do_check_eq(content, "This path exists");
    do_check_eq(content.status, 200);
    do_check_true(content.success);
    // res.data has been updated with the result from the request
    do_check_eq(res.data, content);

    // Since we didn't receive proper JSON data, accessing content.obj
    // will result in a SyntaxError from JSON.parse
    let didThrow = false;
    try {
      content.obj;
    } catch (ex) {
      didThrow = true;
    }
    do_check_true(didThrow);

    run_next_test();
  });
});

add_test(function test_basicauth() {
  _("Test that the BasicAuthenticator doesn't screw up header case.");
  let res1 = new AsyncResource("http://localhost:8080/foo");
  res1.setHeader("Authorization", "Basic foobar");
  res1.authenticator = new NoOpAuthenticator();
  do_check_eq(res1._headers["authorization"], "Basic foobar");
  do_check_eq(res1.headers["authorization"], "Basic foobar");
  let id = new Identity("secret", "guest", "guest");
  res1.authenticator = new BasicAuthenticator(id);

  // In other words... it correctly overwrites our downcased version
  // when accessed through .headers.
  do_check_eq(res1._headers["authorization"], "Basic foobar");
  do_check_eq(res1.headers["authorization"], "Basic Z3Vlc3Q6Z3Vlc3Q=");
  do_check_eq(res1._headers["authorization"], "Basic Z3Vlc3Q6Z3Vlc3Q=");
  do_check_true(!res1._headers["Authorization"]);
  do_check_true(!res1.headers["Authorization"]);

  run_next_test();
});

add_test(function test_get_protected_fail() {
  _("GET a password protected resource (test that it'll fail w/o pass, no throw)");
  let res2 = new AsyncResource("http://localhost:8080/protected");
  res2.get(function (error, content) {
    do_check_eq(error, null);
    do_check_true(did401);
    do_check_eq(content, "This path exists and is protected - failed");
    do_check_eq(content.status, 401);
    do_check_false(content.success);
    run_next_test();
  });
});

add_test(function test_get_protected_success() {
  _("GET a password protected resource");
  let auth = new BasicAuthenticator(new Identity("secret", "guest", "guest"));
  let res3 = new AsyncResource("http://localhost:8080/protected");
  res3.authenticator = auth;
  do_check_eq(res3.authenticator, auth);
  res3.get(function (error, content) {
    do_check_eq(error, null);
    do_check_eq(content, "This path exists and is protected");
    do_check_eq(content.status, 200);
    do_check_true(content.success);
    run_next_test();
  });
});

add_test(function test_get_404() {
  _("GET a non-existent resource (test that it'll fail, but not throw)");
  let res4 = new AsyncResource("http://localhost:8080/404");
  res4.get(function (error, content) {
    do_check_eq(error, null);
    do_check_eq(content, "File not found");
    do_check_eq(content.status, 404);
    do_check_false(content.success);

    // Check some headers of the 404 response
    do_check_eq(content.headers.connection, "close");
    do_check_eq(content.headers.server, "httpd.js");
    do_check_eq(content.headers["content-length"], 14);

    run_next_test();
  });
});

add_test(function test_put_string() {
  _("PUT to a resource (string)");
  let res_upload = new AsyncResource("http://localhost:8080/upload");
  res_upload.put(JSON.stringify(sample_data), function(error, content) {
    do_check_eq(error, null);
    do_check_eq(content, "Valid data upload via PUT");
    do_check_eq(content.status, 200);
    do_check_eq(res_upload.data, content);
    run_next_test();
  });
});

add_test(function test_put_object() {
  _("PUT to a resource (object)");
  let res_upload = new AsyncResource("http://localhost:8080/upload");
  res_upload.put(sample_data, function (error, content) {
    do_check_eq(error, null);
    do_check_eq(content, "Valid data upload via PUT");
    do_check_eq(content.status, 200);
    do_check_eq(res_upload.data, content);
    run_next_test();
  });
});

add_test(function test_put_data_string() {
  _("PUT without data arg (uses resource.data) (string)");
  let res_upload = new AsyncResource("http://localhost:8080/upload");
  res_upload.data = JSON.stringify(sample_data);
  res_upload.put(function (error, content) {
    do_check_eq(error, null);
    do_check_eq(content, "Valid data upload via PUT");
    do_check_eq(content.status, 200);
    do_check_eq(res_upload.data, content);
    run_next_test();
  });
});

add_test(function test_line_by_line() {
  _("Test line-by-line handling.");
  let received = [];
  let res20 = new IncrementalResource("http://localhost:8080/line-by-line",
                                      function(json) {
                                        received.push(JSON.parse(json));
                                      });
  res20.get(function (error, content) {
    do_check_false(!!error);
    do_check_eq(received.length, 3);
    do_check_true(received.every(function (x) [123, 456, 789].indexOf(x.foo) != -1 ));
    run_next_test();
  });
});

add_test(function test_put_data_object() {
  _("PUT without data arg (uses resource.data) (object)");
  let res_upload = new AsyncResource("http://localhost:8080/upload");
  res_upload.data = sample_data;
  res_upload.put(function (error, content) {
    do_check_eq(error, null);
    do_check_eq(content, "Valid data upload via PUT");
    do_check_eq(content.status, 200);
    do_check_eq(res_upload.data, content);
    run_next_test();
  });
});

add_test(function test_post_string() {
  _("POST to a resource (string)");
  let res_upload = new AsyncResource("http://localhost:8080/upload");
  res_upload.post(JSON.stringify(sample_data), function (error, content) {
    do_check_eq(error, null);
    do_check_eq(content, "Valid data upload via POST");
    do_check_eq(content.status, 200);
    do_check_eq(res_upload.data, content);
    run_next_test();
  });
});

add_test(function test_post_object() {
  _("POST to a resource (object)");
  let res_upload = new AsyncResource("http://localhost:8080/upload");
  res_upload.post(sample_data, function (error, content) {
    do_check_eq(error, null);
    do_check_eq(content, "Valid data upload via POST");
    do_check_eq(content.status, 200);
    do_check_eq(res_upload.data, content);
    run_next_test();
  });
});

add_test(function test_post_data_string() {
  _("POST without data arg (uses resource.data) (string)");
  let res_upload = new AsyncResource("http://localhost:8080/upload");
  res_upload.data = JSON.stringify(sample_data);
  res_upload.post(function (error, content) {
    do_check_eq(error, null);
    do_check_eq(content, "Valid data upload via POST");
    do_check_eq(content.status, 200);
    do_check_eq(res_upload.data, content);
    run_next_test();
  });
});

add_test(function test_post_data_object() {
  _("POST without data arg (uses resource.data) (object)");
  let res_upload = new AsyncResource("http://localhost:8080/upload");
  res_upload.data = sample_data;
  res_upload.post(function (error, content) {
    do_check_eq(error, null);
    do_check_eq(content, "Valid data upload via POST");
    do_check_eq(content.status, 200);
    do_check_eq(res_upload.data, content);
    run_next_test();
  });
});

add_test(function test_delete() {
  _("DELETE a resource");
  let res6 = new AsyncResource("http://localhost:8080/delete");
  res6.delete(function (error, content) {
    do_check_eq(error, null);
    do_check_eq(content, "This resource has been deleted");
    do_check_eq(content.status, 200);
    run_next_test();
  });
});

add_test(function test_json_body() {
  _("JSON conversion of response body");
  let res7 = new AsyncResource("http://localhost:8080/json");
  res7.get(function (error, content) {
    do_check_eq(error, null);
    do_check_eq(content, JSON.stringify(sample_data));
    do_check_eq(content.status, 200);
    do_check_eq(JSON.stringify(content.obj), JSON.stringify(sample_data));
    run_next_test();
  });
});

add_test(function test_weave_timestamp() {
  _("X-Weave-Timestamp header updates AsyncResource.serverTime");
  // Before having received any response containing the
  // X-Weave-Timestamp header, AsyncResource.serverTime is null.
  do_check_eq(AsyncResource.serverTime, null);
  let res8 = new AsyncResource("http://localhost:8080/timestamp");
  res8.get(function (error, content) {
    do_check_eq(error, null);
    do_check_eq(AsyncResource.serverTime, TIMESTAMP);
    run_next_test();
  });
});

add_test(function test_get_no_headers() {
  _("GET: no special request headers");
  let res_headers = new AsyncResource("http://localhost:8080/headers");
  res_headers.get(function (error, content) {
    do_check_eq(error, null);
    do_check_eq(content, '{}');
    run_next_test();
  });
});

add_test(function test_put_default_content_type() {
  _("PUT: Content-Type defaults to text/plain");
  let res_headers = new AsyncResource("http://localhost:8080/headers");
  res_headers.put('data', function (error, content) {
    do_check_eq(error, null);
    do_check_eq(content, JSON.stringify({"content-type": "text/plain"}));
    run_next_test();
  });
});

add_test(function test_post_default_content_type() {
  _("POST: Content-Type defaults to text/plain");
  let res_headers = new AsyncResource("http://localhost:8080/headers");
  res_headers.post('data', function (error, content) {
    do_check_eq(error, null);
    do_check_eq(content, JSON.stringify({"content-type": "text/plain"}));
    run_next_test();
  });
});

add_test(function test_setHeader() {
  _("setHeader(): setting simple header");
  let res_headers = new AsyncResource("http://localhost:8080/headers");
  res_headers.setHeader('X-What-Is-Weave', 'awesome');
  do_check_eq(res_headers.headers['x-what-is-weave'], 'awesome');
  res_headers.get(function (error, content) {
    do_check_eq(error, null);
    do_check_eq(content, JSON.stringify({"x-what-is-weave": "awesome"}));
    run_next_test();
  });
});

add_test(function test_setHeader_overwrite() {
  _("setHeader(): setting multiple headers, overwriting existing header");
  let res_headers = new AsyncResource("http://localhost:8080/headers");
  res_headers.setHeader('X-WHAT-is-Weave', 'more awesomer');
  res_headers.setHeader('X-Another-Header', 'hello world');
  do_check_eq(res_headers.headers['x-what-is-weave'], 'more awesomer');
  do_check_eq(res_headers.headers['x-another-header'], 'hello world');
  res_headers.get(function (error, content) {
    do_check_eq(error, null);
    do_check_eq(content, JSON.stringify({"x-another-header": "hello world",
                                         "x-what-is-weave": "more awesomer"}));

    run_next_test();
  });
});

add_test(function test_headers_object() {
  _("Setting headers object");
  let res_headers = new AsyncResource("http://localhost:8080/headers");
  res_headers.headers = {};
  res_headers.get(function (error, content) {
    do_check_eq(error, null);
    do_check_eq(content, "{}");
    run_next_test();
  });
});

add_test(function test_put_override_content_type() {
  _("PUT: override default Content-Type");
  let res_headers = new AsyncResource("http://localhost:8080/headers");
  res_headers.setHeader('Content-Type', 'application/foobar');
  do_check_eq(res_headers.headers['content-type'], 'application/foobar');
  res_headers.put('data', function (error, content) {
    do_check_eq(error, null);
    do_check_eq(content, JSON.stringify({"content-type": "application/foobar"}));
    run_next_test();
  });
});

add_test(function test_post_override_content_type() {
  _("POST: override default Content-Type");
  let res_headers = new AsyncResource("http://localhost:8080/headers");
  res_headers.setHeader('Content-Type', 'application/foobar');
  res_headers.post('data', function (error, content) {
    do_check_eq(error, null);
    do_check_eq(content, JSON.stringify({"content-type": "application/foobar"}));
    run_next_test();
  });
});

add_test(function test_weave_backoff() {
  _("X-Weave-Backoff header notifies observer");
  let backoffInterval;
  function onBackoff(subject, data) {
    backoffInterval = subject;
  }
  Observers.add("weave:service:backoff:interval", onBackoff);

  let res10 = new AsyncResource("http://localhost:8080/backoff");
  res10.get(function (error, content) {
    do_check_eq(error, null);
    do_check_eq(backoffInterval, 600);
    run_next_test();
  });
});

add_test(function test_quota_error() {
  _("X-Weave-Quota-Remaining header notifies observer on successful requests.");
  let res10 = new AsyncResource("http://localhost:8080/quota-error");
  res10.get(function (error, content) {
    do_check_eq(error, null);
    do_check_eq(content.status, 400);
    do_check_eq(quotaValue, undefined); // HTTP 400, so no observer notification.
    run_next_test();
  });
});

add_test(function test_quota_notice() {
  let res10 = new AsyncResource("http://localhost:8080/quota-notice");
  res10.get(function (error, content) {
    do_check_eq(error, null);
    do_check_eq(content.status, 200);
    do_check_eq(quotaValue, 1048576);
    run_next_test();
  });
});

add_test(function test_preserve_exceptions() {
  _("Error handling in ChannelListener etc. preserves exception information");
  let res11 = new AsyncResource("http://localhost:12345/does/not/exist");
  res11.get(function (error, content) {
    do_check_neq(error, null);
    do_check_eq(error.result, Cr.NS_ERROR_CONNECTION_REFUSED);
    do_check_eq(error.message, "NS_ERROR_CONNECTION_REFUSED");
    run_next_test();
  });
});

add_test(function test_401_redirect() {
  let redirRequest;
  let redirToOpen = function(subject) {
    subject.newUri = "http://localhost:8080/open";
    redirRequest = subject;
  };
  Observers.add("weave:resource:status:401", redirToOpen);

  _("Notification of 401 can redirect to another uri");
  did401 = false;
  let res12 = new AsyncResource("http://localhost:8080/protected");
  res12.get(function (error, content) {
    do_check_eq(error, null);
    do_check_eq(res12.spec, "http://localhost:8080/open");
    do_check_eq(content, "This path exists");
    do_check_eq(content.status, 200);
    do_check_true(content.success);
    do_check_eq(res12.data, content);
    do_check_true(did401);
    do_check_eq(redirRequest.response, "This path exists and is protected - failed");
    do_check_eq(redirRequest.response.status, 401);
    do_check_false(redirRequest.response.success);

    Observers.remove("weave:resource:status:401", redirToOpen);
    run_next_test();
  });
});

add_test(function test_401_no_redirect() {
  _("Removing the observer should result in the original 401");
  did401 = false;
  let res13 = new AsyncResource("http://localhost:8080/protected");
  res13.get(function (error, content) {
    do_check_eq(error, null);
    do_check_true(did401);
    do_check_eq(content, "This path exists and is protected - failed");
    do_check_eq(content.status, 401);
    do_check_false(content.success);
    run_next_test();
  });
});

add_test(function test_xpc_exception_handling() {
  _("Exception handling inside fetches.");
  let res14 = new AsyncResource("http://localhost:8080/json");
  res14._onProgress = function(rec) {
    // Provoke an XPC exception without a Javascript wrapper.
    Services.io.newURI("::::::::", null, null);
  };
  let warnings = [];
  res14._log.warn = function(msg) { warnings.push(msg); };

  res14.get(function (error, content) {
    do_check_eq(error.result, Cr.NS_ERROR_MALFORMED_URI);
    do_check_eq(error.message, "NS_ERROR_MALFORMED_URI");
    do_check_eq(content, null);
    do_check_eq(warnings.pop(),
                "Got exception calling onProgress handler during fetch of " +
                "http://localhost:8080/json");

    run_next_test();
  });
});

add_test(function test_js_exception_handling() {
  _("JS exception handling inside fetches.");
  let res15 = new AsyncResource("http://localhost:8080/json");
  res15._onProgress = function(rec) {
    throw "BOO!";
  };
  let warnings = [];
  res15._log.warn = function(msg) { warnings.push(msg); };

  res15.get(function (error, content) {
    do_check_eq(error.result, Cr.NS_ERROR_XPC_JS_THREW_STRING);
    do_check_eq(error.message, "NS_ERROR_XPC_JS_THREW_STRING");
    do_check_eq(content, null);
    do_check_eq(warnings.pop(),
                "Got exception calling onProgress handler during fetch of " +
                "http://localhost:8080/json");

    run_next_test();
  });
});

add_test(function test_timeout() {
  _("Ensure channel timeouts are thrown appropriately.");
  let res19 = new AsyncResource("http://localhost:8080/json");
  res19.ABORT_TIMEOUT = 0;
  res19.get(function (error, content) {
    do_check_eq(error.result, Cr.NS_ERROR_NET_TIMEOUT);
    run_next_test();
  });
});

add_test(function test_uri_construction() {
  _("Testing URI construction.");
  let args = [];
  args.push("newer=" + 1234);
  args.push("limit=" + 1234);
  args.push("sort=" + 1234);

  let query = "?" + args.join("&");

  let uri1 = Utils.makeURL("http://foo/" + query);
  let uri2 = Utils.makeURL("http://foo/");
  uri2.query = query;
  do_check_eq(uri1.query, uri2.query);

  run_next_test();
});

add_test(function tear_down() {
  server.stop(run_next_test);
});
