Cu.import("resource://services-sync/resource.js");
Cu.import("resource://services-sync/record.js");

let sample_data = {foo: 5};

function server_json(metadata, response) {
  let body = JSON.stringify(sample_data);
  response.setStatusLine(metadata.httpVersion, 200, "OK");
  response.bodyOutputStream.write(body, body.length);
}

function server_line_by_line(metadata, response) {
  let items = [
    [123, 456, 789, 123, 456, 789, 123, 456, 789],
    [123, 456, 789, 123, 456, 789, 123, 456, 789],
    [123, 456, 789, 123, 456, 789, 123, 456, 789],
    [123, 456, 789, 123, 456, 789, 123, 456, 789],
    [123, 456, 789, 123, 456, 789, 123, 456, 789],
    [123, 456, 789, 123, 456, 789, 123, 456, 789],
    [123, 456, 789, 123, 456, 789, 123, 456, 789],
    [123, 456, 789, 123, 456, 789, 123, 456, 789],
    [123, 456, 789, 123, 456, 789, 123, 456, 789],
    [123, 456, 789, 123, 456, 789, 123, 456, 789],
    [123, 456, 789, 123, 456, 789, 123, 456, 789]
  ];
  let body = "";
  for each (let item in items) {
    body += JSON.stringify({"foo": item}) + "\n";
  }
  response.setStatusLine(metadata.httpVersion, 200, "OK");
  response.bodyOutputStream.write(body, body.length);
}

add_test(function test_concurrent_requests() {
  _("Testing concurrent AsyncResource fetches.");
  let server = httpd_setup({
    "/get": server_json
  });

  let counter = 20;

  function onward(error) {
    do_check_false(!!error);
    server.stop(run_next_test);
  }

  function individualCallback(error, response) {
    _("Individual callback hit.");
    if (--counter == 0) {
      onward();
    }
  }

  for (let i = 0; i < counter; ++i) {
    new AsyncResource("http://localhost:8080/get").get(individualCallback);
  }
});

add_test(function test_concurrent_collections() {
  _("Testing concurrent collections.");
  let server = httpd_setup({
    "/get": server_line_by_line
  });

  let counter = 20;

  function onward(error) {
    do_check_false(!!error);
    server.stop(run_next_test);
  }

  function individualCallback(error, response) {
    _("Individual callback hit.");
    if (--counter == 0) {
      onward();
    }
  }

  function recordHandler(x) {
    _("Record handler hit.");
  }

  let rs = [];
  for (let i = 0; i < counter; ++i) {
    let r = new AsyncCollection("http://localhost:8080/get", WBORecord);
    r.full = true;
    r.limit = 0;
    r.newer = 0;
    r.ids   = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    r.recordHandler = recordHandler;
    rs.push(r);
  }
  rs.map(function (r) {
    _("Go...");
    r.get(individualCallback);
  });
});

function run_test() {
  run_next_test();
}
