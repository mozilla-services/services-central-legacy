Cu.import("resource://services-sync/global.js");

add_test(function test_global_record() {
  _("Testing global record accessors and fetching.");
  let samplePayload = {
    syncID: "aaaaaaam1Ozy",
    storageVersion: 5,
    engines: {
      clients: {version: 1, syncID: "aaaaaaab88su"},
      bookmarks: {version: 2, syncID: "aaaaaaaC3B71"},
      forms: {version: 1, syncID: "aaaaaaakuSNQ"},
      history: {version: 1, syncID: "aaaaaaa_kDiz"},
      passwords: {version: 1, syncID: "aaaaaaazhO0r"},
      prefs: {version: 2, syncID: "aaaaaaajSH-m"},
      tabs: {version: 1, syncID: "aaaaaaa0b5cr"}
    }
  };
  let wbo = JSON.stringify({id: "global",
                            modified: 1301092886.89,
                            payload: samplePayload});

  let server = httpd_setup({
    "/1.1/john/storage/meta/global": httpd_handler(200, "OK", wbo)
  });

  try {
    let r = new GlobalRecord("http://localhost:8080/1.1/john/storage/meta/global");
    _(r);
    do_check_eq(r.syncID, "aaaaaaam1Ozy");
    do_check_eq(r.storageVersion, 5);
    do_check_eq(Object.keys(r.collections).length, 7);
    do_check_eq(r.collectionNames.length, 7);
    r.collectionNames.every(function (name) {
      do_check_true(!!samplePayload.engines[name]);
    });
    do_check_eq(r.collection("prefs").version, 2);
  } finally {
    server.stop(run_next_test);
  }
});

function run_test() {
  run_next_test();
}
