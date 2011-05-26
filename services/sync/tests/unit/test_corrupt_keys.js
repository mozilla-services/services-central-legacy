Cu.import("resource://services-sync/main.js");
Cu.import("resource://services-sync/service.js");
Cu.import("resource://services-sync/engines.js");
Cu.import("resource://services-sync/util.js");
Cu.import("resource://services-sync/status.js");
Cu.import("resource://services-sync/constants.js");
Cu.import("resource://services-sync/record.js");
Cu.import("resource://services-sync/engines/tabs.js");
Cu.import("resource://services-sync/engines/history.js");
Cu.import("resource://services-sync/log4moz.js");
  
add_test(function test_locally_changed_keys() {
  let passphrase = "abcdeabcdeabcdeabcdeabcdea";

  // Tracking info/collections.
  let collectionsHelper = track_collections_helper();
  let upd = collectionsHelper.with_updated_collection;
  let collections = collectionsHelper.collections;

  let keysWBO = new ServerWBO("keys");
  let clients = new ServerCollection();
  let meta_global = new ServerWBO("global");
  
  let history = new ServerCollection();
  
  let hmacErrorCount = 0;
  function counting(f) {
    return function() {
      hmacErrorCount++;
      return f.call(this);
    };
  }
  
  Weave.Service.handleHMACEvent = counting(Weave.Service.handleHMACEvent);
  
  let server = httpd_setup({
    // Special.
    "/1.1/johndoe/storage/meta/global": upd("meta", meta_global.handler()),
    "/1.1/johndoe/info/collections": collectionsHelper.handler,
    "/1.1/johndoe/storage/crypto/keys": upd("crypto", keysWBO.handler()),
      
    // Track modified times.
    "/1.1/johndoe/storage/clients": upd("clients", clients.handler()),
    "/1.1/johndoe/storage/clients/foobar": upd("clients", new ServerWBO("clients").handler()),
    "/1.1/johndoe/storage/tabs": upd("tabs", new ServerCollection().handler()),
    
    // Just so we don't get 404s in the logs.
    "/1.1/johndoe/storage/bookmarks": new ServerCollection().handler(),
    "/1.1/johndoe/storage/forms": new ServerCollection().handler(),
    "/1.1/johndoe/storage/passwords": new ServerCollection().handler(),
    "/1.1/johndoe/storage/prefs": new ServerCollection().handler(),
    
    "/1.1/johndoe/storage/history": upd("history", history.handler()),
  });

  try {
    
    Svc.Prefs.set("registerEngines", "Tab");
    _("Set up some tabs.");
    let myTabs = 
      {windows: [{tabs: [{index: 1,
                          entries: [{
                            url: "http://foo.com/",
                            title: "Title"
                          }],
                          attributes: {
                            image: "image"
                          },
                          extData: {
                            weaveLastUsed: 1
                          }}]}]};
    delete Svc.Session;
    Svc.Session = {
      getBrowserState: function () JSON.stringify(myTabs)
    };
    
    Weave.Service.username = "johndoe";
    Weave.Service.password = "ilovejane";
    Weave.Service.passphrase = passphrase;
    
    Weave.Service.serverURL = "http://localhost:8080/";
    Weave.Service.clusterURL = "http://localhost:8080/";
    
    Engines.register(HistoryEngine);
    Weave.Service._registerEngines();
    
    function corrupt_local_keys() {
      CollectionKeys._default.keyPair = [Svc.Crypto.generateRandomKey(),
                                         Svc.Crypto.generateRandomKey()];
    }
    
    _("Setting meta.");
    
    // Bump version on the server.
    let m = new WBORecord("meta", "global");
    m.payload = {"syncID": "foooooooooooooooooooooooooo",
                 "storageVersion": STORAGE_VERSION};
    m.upload(Weave.Service.metaURL);
    
    _("New meta/global: " + JSON.stringify(meta_global));
    
    // Upload keys.
    generateNewKeys();
    let serverKeys = CollectionKeys.asWBO("crypto", "keys");
    serverKeys.encrypt(Weave.Service.syncKeyBundle);
    do_check_true(serverKeys.upload(Weave.Service.cryptoKeysURL).success);
    
    // Check that login works.
    do_check_true(Weave.Service.login("johndoe", "ilovejane", passphrase));
    do_check_true(Weave.Service.isLoggedIn);
    
    // Sync should upload records.
    Weave.Service.sync();
    
    // Tabs exist.
    _("Tabs modified: " + collections.tabs);
    do_check_true(!!collections.tabs);
    do_check_true(collections.tabs > 0);
    
    let coll_modified = CollectionKeys.lastModified;
    
    // Let's create some server side history records.
    let liveKeys = CollectionKeys.keyForCollection("history");
    _("Keys now: " + liveKeys.keyPair);
    let visitType = Ci.nsINavHistoryService.TRANSITION_LINK;
    for (var i = 0; i < 5; i++) {
      let id = 'record-no--' + i;
      let modified = Date.now()/1000 - 60*(i+10);
      
      let w = new CryptoWrapper("history", "id");
      w.cleartext = {
        id: id,
        histUri: "http://foo/bar?" + id,
        title: id,
        sortindex: i,
        visits: [{date: (modified - 5) * 1000000, type: visitType}],
        deleted: false};
      w.encrypt();
      
      let wbo = new ServerWBO(id, {ciphertext: w.ciphertext,
                                   IV: w.IV,
                                   hmac: w.hmac});
      wbo.modified = modified;
      history.wbos[id] = wbo;
      server.registerPathHandler(
        "/1.1/johndoe/storage/history/record-no--" + i,
        upd("history", wbo.handler()));
    }
    
    collections.history = Date.now()/1000;
    let old_key_time = collections.crypto;
    _("Old key time: " + old_key_time);
    
    // Check that we can decrypt one.
    let rec = new CryptoWrapper("history", "record-no--0");
    rec.fetch(Weave.Service.storageURL + "history/record-no--0");
    _(JSON.stringify(rec));
    do_check_true(!!rec.decrypt());
    
    do_check_eq(hmacErrorCount, 0);
    
    // Fill local key cache with bad data.
    corrupt_local_keys();
    _("Keys now: " + CollectionKeys.keyForCollection("history").keyPair);
    
    do_check_eq(hmacErrorCount, 0);
    
    _("HMAC error count: " + hmacErrorCount);
    // Now syncing should succeed, after one HMAC error.
    Weave.Service.sync();
    do_check_eq(hmacErrorCount, 1);
    _("Keys now: " + CollectionKeys.keyForCollection("history").keyPair);
    
    // And look! We downloaded history!
    let store = Engines.get("history")._store;
    do_check_true(store.urlExists("http://foo/bar?record-no--0"));
    do_check_true(store.urlExists("http://foo/bar?record-no--1"));
    do_check_true(store.urlExists("http://foo/bar?record-no--2"));
    do_check_true(store.urlExists("http://foo/bar?record-no--3"));
    do_check_true(store.urlExists("http://foo/bar?record-no--4"));
    do_check_eq(hmacErrorCount, 1);
    
    _("Busting some new server values.");
    // Now what happens if we corrupt the HMAC on the server?
    for (var i = 5; i < 10; i++) {
      let id = 'record-no--' + i;
      let modified = 1 + (Date.now()/1000);
      
      let w = new CryptoWrapper("history", "id");
      w.cleartext = {
        id: id,
        histUri: "http://foo/bar?" + id,
        title: id,
        sortindex: i,
        visits: [{date: (modified - 5 ) * 1000000, type: visitType}],
        deleted: false};
      w.encrypt();
      w.hmac = w.hmac.toUpperCase();
      
      let wbo = new ServerWBO(id, {ciphertext: w.ciphertext,
                                   IV: w.IV,
                                   hmac: w.hmac});
      wbo.modified = modified;
      history.wbos[id] = wbo;
      server.registerPathHandler(
        "/1.1/johndoe/storage/history/record-no--" + i,
        upd("history", wbo.handler()));
    }
    collections.history = Date.now()/1000;
    
    _("Server key time hasn't changed.");
    do_check_eq(collections.crypto, old_key_time);
    
    _("Resetting HMAC error timer.");
    Weave.Service.lastHMACEvent = 0;
    
    _("Syncing...");
    Weave.Service.sync();
    _("Keys now: " + CollectionKeys.keyForCollection("history").keyPair);
    _("Server keys have been updated, and we skipped over 5 more HMAC errors without adjusting history.");
    do_check_true(collections.crypto > old_key_time);
    do_check_eq(hmacErrorCount, 6);
    do_check_false(store.urlExists("http://foo/bar?record-no--5"));
    do_check_false(store.urlExists("http://foo/bar?record-no--6"));
    do_check_false(store.urlExists("http://foo/bar?record-no--7"));
    do_check_false(store.urlExists("http://foo/bar?record-no--8"));
    do_check_false(store.urlExists("http://foo/bar?record-no--9"));
    
    // Clean up.
    Weave.Service.startOver();
    
  } finally {
    Weave.Svc.Prefs.resetBranch("");
    server.stop(run_next_test);
  }
});

function run_test() {
  let logger = Log4Moz.repository.rootLogger;
  Log4Moz.repository.rootLogger.addAppender(new Log4Moz.DumpAppender());
  
  run_next_test();
}
