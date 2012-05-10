// Loads everything from Components.
do_load_httpd_js();

const TEST_SERVER_URL = "http://localhost:8080/";

let _ = function() print(Array.slice(arguments).join(" "));


function httpd_setup (handlers, port) {
  let port   = port || 8080;
  let server = new nsHttpServer();
  for (let path in handlers) {
    server.registerPathHandler(path, handlers[path]);
  }
  try {
    server.start(port);
  } catch (ex) {
    _("==========================================");
    _("Got exception starting HTTP server on port " + port);
    _("Error: " + Utils.exceptionStr(ex));
    _("Is there a process already listening on port " + port + "?");
    _("==========================================");
    do_throw(ex);
  }
  return server;
}

function httpd_handler(statusCode, status, body) {
  return function handler(request, response) {
    _("Processing request");
    // Allow test functions to inspect the request.
    request.body = readBytesFromInputStream(request.bodyInputStream);
    handler.request = request;

    response.setStatusLine(request.httpVersion, statusCode, status);
    if (body) {
      response.bodyOutputStream.write(body, body.length);
    }
  };
}

let PROFILE_DIR = do_get_profile();
