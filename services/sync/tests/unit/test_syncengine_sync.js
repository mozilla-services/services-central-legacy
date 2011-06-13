Cu.import("resource://services-sync/record.js");
Cu.import("resource://services-sync/constants.js");
Cu.import("resource://services-sync/engines.js");
Cu.import("resource://services-sync/identity.js");
Cu.import("resource://services-sync/resource.js");
Cu.import("resource://services-sync/util.js");

/*
 * A fake engine implementation.
 * 
 * Complete with record, store, and tracker implementations.
 */

function SteamRecord(collection, id) {
  CryptoWrapper.call(this, collection, id);
}
SteamRecord.prototype = {
  __proto__: CryptoWrapper.prototype
};
Utils.deferGetSet(SteamRecord, "cleartext", ["denomination"]);

function SteamStore() {
  Store.call(this, "Steam");
  this.items = {};
}
SteamStore.prototype = {
  __proto__: Store.prototype,

  create: function Store_create(record) {
    this.items[record.id] = record.denomination;
  },

  remove: function Store_remove(record) {
    delete this.items[record.id];
  },

  update: function Store_update(record) {
    this.items[record.id] = record.denomination;
  },

  itemExists: function Store_itemExists(id) {
    return (id in this.items);
  },

  createRecord: function(id, collection) {
    var record = new SteamRecord(collection, id);
    record.denomination = this.items[id] || "Data for new record: " + id;
    return record;
  },

  changeItemID: function(oldID, newID) {
    this.items[newID] = this.items[oldID];
    delete this.items[oldID];
  },

  getAllIDs: function() {
    let ids = {};
    for (var id in this.items) {
      ids[id] = true;
    }
    return ids;
  },

  wipe: function() {
    this.items = {};
  }
};

function SteamTracker() {
  Tracker.call(this, "Steam");
}
SteamTracker.prototype = {
  __proto__: Tracker.prototype
};


function SteamEngine() {
  SyncEngine.call(this, "Steam");
  this.toFetch = [];
  this.previousFailed = [];
}
SteamEngine.prototype = {
  __proto__: SyncEngine.prototype,
  _storeObj: SteamStore,
  _trackerObj: SteamTracker,
  _recordObj: SteamRecord,

  _findDupe: function(item) {
    for (let [id, value] in Iterator(this._store.items)) {
      if (item.denomination == value) {
        return id;
      }
    }
  }
};


function makeSteamEngine() {
  return new SteamEngine();
}

function cleanAndGo(server) {
  Svc.Prefs.resetBranch("");
  Records.clearCache();
  server.stop(run_next_test);
}

/*
 * Tests
 * 
 * SyncEngine._sync() is divided into four rather independent steps:
 *
 * - _syncStartupCb()
 * - _processIncoming()
 * - _uploadOutgoing()
 * - _syncFinish()
 * 
 * In the spirit of unit testing, these are tested individually for
 * different scenarios below.
 */

add_test(function test_syncStartup_emptyOrOutdatedGlobalsResetsSync() {
  _("SyncEngine._syncStartupCb resets sync and wipes server data if there's no or an outdated global record");

  let syncTesting = new SyncTestingInfrastructure();
  Svc.Prefs.set("clusterURL", "http://localhost:8080/");
  Svc.Prefs.set("username", "foo");

  // Some server side data that's going to be wiped
  let collection = new ServerCollection();
  collection.wbos.flying = new ServerWBO(
      'flying', encryptPayload({id: 'flying',
                                denomination: "LNER Class A3 4472"}));
  collection.wbos.scotsman = new ServerWBO(
      'scotsman', encryptPayload({id: 'scotsman',
                                  denomination: "Flying Scotsman"}));

  let server = sync_httpd_setup({
      "/1.1/foo/storage/steam": collection.handler()
  });

  let engine = makeSteamEngine();
  engine._store.items = {rekolok: "Rekonstruktionslokomotive"};

  // Confirm initial environment
  do_check_eq(engine._tracker.changedIDs["rekolok"], undefined);
  let metaGlobal = Records.get(engine.metaURL);
  do_check_eq(metaGlobal.payload.engines, undefined);
  do_check_true(!!collection.wbos.flying.payload);
  do_check_true(!!collection.wbos.scotsman.payload);

  engine.lastSync = Date.now() / 1000;
  engine.lastSyncLocal = Date.now();

  // Trying to prompt a wipe -- we no longer track CryptoMeta per engine,
  // so it has nothing to check.
  engine._syncStartupCb(function (err) {
    try {
      do_check_false(!!err);

      // The meta/global WBO has been filled with data about the engine
      let engineData = metaGlobal.payload.engines["steam"];
      do_check_eq(engineData.version, engine.version);
      do_check_eq(engineData.syncID, engine.syncID);

      // Sync was reset and server data was wiped
      do_check_eq(engine.lastSync, 0);
      do_check_eq(collection.wbos.flying.payload, undefined);
      do_check_eq(collection.wbos.scotsman.payload, undefined);

    } finally {
      cleanAndGo(server);
    }
  });
});

add_test(function test_syncStartup_serverHasNewerVersion() {
  _("SyncEngine._syncStartup ");

  let syncTesting = new SyncTestingInfrastructure();
  Svc.Prefs.set("clusterURL", "http://localhost:8080/");
  Svc.Prefs.set("username", "foo");
  let global = new ServerWBO('global', {engines: {steam: {version: 23456}}});
  let server = httpd_setup({
      "/1.1/foo/storage/meta/global": global.handler()
  });

  let engine = makeSteamEngine();

  // The server has a newer version of the data and our engine can
  // handle.  That should give us an exception.
  let error;
  engine._syncStartupCb(function (error) {
    do_check_eq(error.failureCode, VERSION_OUT_OF_DATE);
    cleanAndGo(server);
  });
});

add_test(function test_syncStartup_syncIDMismatchResetsClient() {
  _("SyncEngine._syncStartup resets sync if syncIDs don't match");

  let syncTesting = new SyncTestingInfrastructure();
  Svc.Prefs.set("clusterURL", "http://localhost:8080/");
  Svc.Prefs.set("username", "foo");
  let server = sync_httpd_setup({});

  // global record with a different syncID than our engine has
  let engine = makeSteamEngine();
  let global = new ServerWBO('global',
                             {engines: {steam: {version: engine.version,
                                                syncID: 'foobar'}}});
  server.registerPathHandler("/1.1/foo/storage/meta/global", global.handler());

  // Confirm initial environment
  do_check_eq(engine.syncID, 'fake-guid-0');
  do_check_eq(engine._tracker.changedIDs["rekolok"], undefined);

  engine.lastSync = Date.now() / 1000;
  engine.lastSyncLocal = Date.now();
  engine._syncStartupCb(function (err) {
    try {
      // The engine has assumed the server's syncID
      do_check_eq(engine.syncID, 'foobar');

      // Sync was reset
      do_check_eq(engine.lastSync, 0);

    } finally {
      cleanAndGo(server);
    }
  });
});

add_test(function test_processIncoming_emptyServer() {
  _("SyncEngine._processIncoming working with an empty server backend");

  let syncTesting = new SyncTestingInfrastructure();
  Svc.Prefs.set("clusterURL", "http://localhost:8080/");
  Svc.Prefs.set("username", "foo");
  let collection = new ServerCollection();

  let server = sync_httpd_setup({
      "/1.1/foo/storage/steam": collection.handler()
  });

  let engine = makeSteamEngine();
  try {

    // Merely ensure that this code path is run without any errors
    engine._processIncoming();
    do_check_eq(engine.lastSync, 0);

  } finally {
    cleanAndGo(server);
  }
});

add_test(function test_processIncoming_createFromServer() {
  _("SyncEngine._processIncoming creates new records from server data");

  let syncTesting = new SyncTestingInfrastructure();
  Svc.Prefs.set("clusterURL", "http://localhost:8080/");
  Svc.Prefs.set("username", "foo");
  
  generateNewKeys();

  // Some server records that will be downloaded
  let collection = new ServerCollection();
  collection.wbos.flying = new ServerWBO(
      'flying', encryptPayload({id: 'flying',
                                denomination: "LNER Class A3 4472"}));
  collection.wbos.scotsman = new ServerWBO(
      'scotsman', encryptPayload({id: 'scotsman',
                                  denomination: "Flying Scotsman"}));

  // Two pathological cases involving relative URIs gone wrong.
  collection.wbos['../pathological'] = new ServerWBO(
      '../pathological', encryptPayload({id: '../pathological',
                                         denomination: "Pathological Case"}));

  let server = sync_httpd_setup({
      "/1.1/foo/storage/steam": collection.handler(),
      "/1.1/foo/storage/steam/flying": collection.wbos.flying.handler(),
      "/1.1/foo/storage/steam/scotsman": collection.wbos.scotsman.handler()
  });

  let engine = makeSteamEngine();
  let meta_global = Records.set(engine.metaURL, new WBORecord(engine.metaURL));
  meta_global.payload.engines = {steam: {version: engine.version,
                                         syncID: engine.syncID}};

  // Confirm initial environment
  do_check_eq(engine.lastSync, 0);
  do_check_eq(engine.lastModified, null);
  do_check_eq(engine._store.items.flying, undefined);
  do_check_eq(engine._store.items.scotsman, undefined);
  do_check_eq(engine._store.items['../pathological'], undefined);

  engine._syncStartupCb(function (err) {
    try {
      engine._processIncoming();

      // Timestamps of last sync and last server modification are set.
      do_check_true(engine.lastSync > 0);
      do_check_true(engine.lastModified > 0);

      // Local records have been created from the server data.
      do_check_eq(engine._store.items.flying, "LNER Class A3 4472");
      do_check_eq(engine._store.items.scotsman, "Flying Scotsman");
      do_check_eq(engine._store.items['../pathological'], "Pathological Case");

    } finally {
      cleanAndGo(server);
    }
  });
});

add_test(function test_processIncoming_reconcile() {
  _("SyncEngine._processIncoming updates local records");

  let syncTesting = new SyncTestingInfrastructure();
  Svc.Prefs.set("clusterURL", "http://localhost:8080/");
  Svc.Prefs.set("username", "foo");
  let collection = new ServerCollection();

  // This server record is newer than the corresponding client one,
  // so it'll update its data.
  collection.wbos.newrecord = new ServerWBO(
      'newrecord', encryptPayload({id: 'newrecord',
                                   denomination: "New stuff..."}));

  // This server record is newer than the corresponding client one,
  // so it'll update its data.
  collection.wbos.newerserver = new ServerWBO(
      'newerserver', encryptPayload({id: 'newerserver',
                                     denomination: "New data!"}));

  // This server record is 2 mins older than the client counterpart
  // but identical to it, so we're expecting the client record's
  // changedID to be reset.
  collection.wbos.olderidentical = new ServerWBO(
      'olderidentical', encryptPayload({id: 'olderidentical',
                                        denomination: "Older but identical"}));
  collection.wbos.olderidentical.modified -= 120;

  // This item simply has different data than the corresponding client
  // record (which is unmodified), so it will update the client as well
  collection.wbos.updateclient = new ServerWBO(
      'updateclient', encryptPayload({id: 'updateclient',
                                      denomination: "Get this!"}));

  // This is a dupe of 'original' but with a longer GUID, so we're
  // expecting it to be marked for deletion from the server
  collection.wbos.duplication = new ServerWBO(
      'duplication', encryptPayload({id: 'duplication',
                                     denomination: "Original Entry"}));

  // This is a dupe of 'long_original' but with a shorter GUID, so we're
  // expecting it to replace 'long_original'.
  collection.wbos.dupe = new ServerWBO(
      'dupe', encryptPayload({id: 'dupe',
                              denomination: "Long Original Entry"}));  

  // This record is marked as deleted, so we're expecting the client
  // record to be removed.
  collection.wbos.nukeme = new ServerWBO(
      'nukeme', encryptPayload({id: 'nukeme',
                                denomination: "Nuke me!",
                                deleted: true}));

  let server = sync_httpd_setup({
      "/1.1/foo/storage/steam": collection.handler()
  });

  let engine = makeSteamEngine();
  engine._store.items = {newerserver: "New data, but not as new as server!",
                         olderidentical: "Older but identical",
                         updateclient: "Got data?",
                         original: "Original Entry",
                         long_original: "Long Original Entry",
                         nukeme: "Nuke me!"};
  // Make this record 1 min old, thus older than the one on the server
  engine._tracker.addChangedID('newerserver', Date.now()/1000 - 60);
  // This record has been changed 2 mins later than the one on the server
  engine._tracker.addChangedID('olderidentical', Date.now()/1000);

  let meta_global = Records.set(engine.metaURL, new WBORecord(engine.metaURL));
  meta_global.payload.engines = {steam: {version: engine.version,
                                         syncID: engine.syncID}};

  // Confirm initial environment
  do_check_eq(engine._store.items.newrecord, undefined);
  do_check_eq(engine._store.items.newerserver, "New data, but not as new as server!");
  do_check_eq(engine._store.items.olderidentical, "Older but identical");
  do_check_eq(engine._store.items.updateclient, "Got data?");
  do_check_eq(engine._store.items.nukeme, "Nuke me!");
  do_check_true(engine._tracker.changedIDs['olderidentical'] > 0);

  engine._syncStartupCb(function (err) {
    try {
      engine._processIncoming();

      // Timestamps of last sync and last server modification are set.
      do_check_true(engine.lastSync > 0);
      do_check_true(engine.lastModified > 0);

      // The new record is created.
      do_check_eq(engine._store.items.newrecord, "New stuff...");

      // The 'newerserver' record is updated since the server data is newer.
      do_check_eq(engine._store.items.newerserver, "New data!");

      // The data for 'olderidentical' is identical on the server, so
      // it's no longer marked as changed anymore.
      do_check_eq(engine._store.items.olderidentical, "Older but identical");
      do_check_eq(engine._tracker.changedIDs['olderidentical'], undefined);

      // Updated with server data.
      do_check_eq(engine._store.items.updateclient, "Get this!");

      // The dupe with the shorter ID is kept, the longer one is slated
      // for deletion.
      do_check_eq(engine._store.items.long_original, undefined);
      do_check_eq(engine._store.items.dupe, "Long Original Entry");
      do_check_neq(engine._delete.ids.indexOf('duplication'), -1);

      // The 'nukeme' record marked as deleted is removed.
      do_check_eq(engine._store.items.nukeme, undefined);

    } finally {
      cleanAndGo(server);
    }
  });
});

add_test(function test_processIncoming_mobile_batchSize() {
  _("SyncEngine._processIncoming doesn't fetch everything at once on mobile clients");

  let syncTesting = new SyncTestingInfrastructure();
  Svc.Prefs.set("clusterURL", "http://localhost:8080/");
  Svc.Prefs.set("username", "foo");
  Svc.Prefs.set("client.type", "mobile");

  // A collection that logs each GET
  let collection = new ServerCollection();
  collection.get_log = [];
  collection._get = collection.get;
  collection.get = function (options) {
    this.get_log.push(options);
    return this._get(options);
  };

  // Let's create some 234 server side records. They're all at least
  // 10 minutes old.
  for (var i = 0; i < 234; i++) {
    let id = 'record-no-' + i;
    let payload = encryptPayload({id: id, denomination: "Record No. " + i});
    let wbo = new ServerWBO(id, payload);
    wbo.modified = Date.now()/1000 - 60*(i+10);
    collection.wbos[id] = wbo;
  }

  let server = sync_httpd_setup({
      "/1.1/foo/storage/steam": collection.handler()
  });

  let engine = makeSteamEngine();
  let meta_global = Records.set(engine.metaURL, new WBORecord(engine.metaURL));
  meta_global.payload.engines = {steam: {version: engine.version,
                                         syncID: engine.syncID}};


  _("On a mobile client, we get new records from the server in batches of 50.");
  engine._syncStartupCb(function (err) {
      do_check_true(!err);
      engine._processIncomingCb(function (err) {
        try {
          do_check_true(!err);

          do_check_eq([id for (id in engine._store.items)].length, 234);
          do_check_true('record-no-0' in engine._store.items);
          do_check_true('record-no-49' in engine._store.items);
          do_check_true('record-no-50' in engine._store.items);
          do_check_true('record-no-233' in engine._store.items);

          // Verify that the right number of GET requests with the right
          // kind of parameters were made.
          do_check_eq(collection.get_log.length,
                      Math.ceil(234 / MOBILE_BATCH_SIZE) + 1);
          do_check_eq(collection.get_log[0].full, 1);
          do_check_eq(collection.get_log[0].limit, MOBILE_BATCH_SIZE);
          do_check_eq(collection.get_log[1].full, undefined);
          do_check_eq(collection.get_log[1].limit, undefined);
          for (let i = 1; i <= Math.floor(234 / MOBILE_BATCH_SIZE); i++) {
            do_check_eq(collection.get_log[i+1].full, 1);
            do_check_eq(collection.get_log[i+1].limit, undefined);
            if (i < Math.floor(234 / MOBILE_BATCH_SIZE))
              do_check_eq(collection.get_log[i+1].ids.length, MOBILE_BATCH_SIZE);
            else
              do_check_eq(collection.get_log[i+1].ids.length, 234 % MOBILE_BATCH_SIZE);
          }
          _("Done with checks.");
        } finally {
          _("Clean and go.");
          cleanAndGo(server);
        }
      })
    });
});

// This test formerly attempted to download three batches, making the third
// fail with an HTTP 500 error. The test assessed whether the first two batches
// were completely applied, and the third not at all -- assuming 50 records per
// batch, it tested that 100 had been applied. This worked, because our
// downloads were serial.
//
// In a modern, async, concurrent world, testing in this way is more difficult.
// We'll observe that, say, 78 records applied -- the third request failed
// part-way through the line-by-line processing of the second.
//
// Instead we will adapt, verifying that behavior is within spec.
//
add_test(function test_processIncoming_store_toFetch() {
  _("If processIncoming fails in the middle of a batch on mobile, state is saved in toFetch and lastSync.");
  let syncTesting = new SyncTestingInfrastructure();
  Svc.Prefs.set("clusterURL", "http://localhost:8080/");
  Svc.Prefs.set("username", "foo");
  Svc.Prefs.set("client.type", "mobile");

  // A collection that throws at the fourth get.
  let collection = new ServerCollection();
  collection._get_calls = 0;
  collection._get = collection.get;
  collection.get = function() {
    this._get_calls += 1;
    if (this._get_calls > 3) {
      _("Failing HTTP serve.");
      throw "Abort on fourth call!";
    }
    return this._get.apply(this, arguments);
  };

  // Let's create three batches worth of server side records.
  for (var i = 0; i < MOBILE_BATCH_SIZE * 3; i++) {
    let id = 'record-no-' + i;
    let payload = encryptPayload({id: id, denomination: "Record No. " + id});
    let wbo = new ServerWBO(id, payload);
    wbo.modified = Date.now()/1000 + 60 * (i - MOBILE_BATCH_SIZE * 3);
    collection.wbos[id] = wbo;
  }

  let engine = makeSteamEngine();
  engine.enabled = true;

  let meta_global = Records.set(engine.metaURL, new WBORecord(engine.metaURL));
  meta_global.payload.engines = {steam: {version: engine.version,
                                         syncID: engine.syncID}};
  let server = sync_httpd_setup({
      "/1.1/foo/storage/steam": collection.handler()
  });

  try {

    // Confirm initial environment
    do_check_eq(engine.lastSync, 0);
    do_check_eq([id for (id in engine._store.items)].length, 0);

    let error;
    try {
      engine.sync();
    } catch (ex) {
      error = ex;
    }
    do_check_true(!!error);

    // Only the first two batches have been applied.
    let appliedIDs   = [id for (id in engine._store.items)];
    let appliedCount = appliedIDs.length;
    do_check_true(MOBILE_BATCH_SIZE <= appliedCount <= (2 * MOBILE_BATCH_SIZE));

    // Verify that all items will be fetched on the next sync: either
    //
    // * They are in toFetch (i.e., known failures), or
    // * They have modified times greater than the engine's lastSync.
    //
    // (Or, of course, they're in the engine store.)
    let lastSync   = engine.lastSync;
    let notFetched = [id for (id in collection.wbos) if (appliedIDs.indexOf(id) == -1)];
    let future     = [id for (id in collection.wbos) if (collection.wbos[id].modified > lastSync)];
    let toFetch    = engine.toFetch;

    _("lastSync: "    + lastSync);
    _("Not fetched: " + notFetched);
    _("Future: "      + future);
    _("To fetch: "    + toFetch);

    do_check_true(notFetched.every(function (id) {
      return future.indexOf(id) != -1 ||
             toFetch.indexOf(id) != -1;
    }));

    // We only update lastSync for batches that completed before an HTTP error,
    // so only count in whole batch sizes.
    let newestCompleted = appliedCount - appliedCount % MOBILE_BATCH_SIZE;
    do_check_eq(engine.lastSync,
                  collection.wbos["record-no-" + (newestCompleted - 1)].modified);

  } finally {
    cleanAndGo(server);
  }
});

add_test(function test_processIncoming_resume_toFetch() {
  _("toFetch and previousFailed items left over from previous syncs are fetched on the next sync, along with new items.");
  let syncTesting = new SyncTestingInfrastructure();
  Svc.Prefs.set("clusterURL", "http://localhost:8080/");
  Svc.Prefs.set("username", "foo");

  const LASTSYNC = Date.now() / 1000;

  // Server records that will be downloaded
  let collection = new ServerCollection();
  collection.wbos.flying = new ServerWBO(
      'flying', encryptPayload({id: 'flying',
                                denomination: "LNER Class A3 4472"}));
  collection.wbos.scotsman = new ServerWBO(
      'scotsman', encryptPayload({id: 'scotsman',
                                  denomination: "Flying Scotsman"}));
  collection.wbos.rekolok = new ServerWBO(
      'rekolok', encryptPayload({id: 'rekolok',
                                 denomination: "Rekonstruktionslokomotive"}));
  for (var i = 0; i < 3; i++) {
    let id = 'failed' + i;
    let payload = encryptPayload({id: id, denomination: "Record No. " + i});
    let wbo = new ServerWBO(id, payload);
    wbo.modified = LASTSYNC - 10;
    collection.wbos[id] = wbo;
  }

  collection.wbos.flying.modified = collection.wbos.scotsman.modified
    = LASTSYNC - 10;
  collection.wbos.rekolok.modified = LASTSYNC + 10;

  // Time travel 10 seconds into the future but still download the above WBOs.
  let engine = makeSteamEngine();
  engine.lastSync = LASTSYNC;
  engine.toFetch = ["flying", "scotsman"];
  engine.previousFailed = ["failed0", "failed1", "failed2"];

  let meta_global = Records.set(engine.metaURL, new WBORecord(engine.metaURL));
  meta_global.payload.engines = {steam: {version: engine.version,
                                         syncID: engine.syncID}};
  let server = sync_httpd_setup({
      "/1.1/foo/storage/steam": collection.handler()
  });

  // Confirm initial environment
  do_check_eq(engine._store.items.flying, undefined);
  do_check_eq(engine._store.items.scotsman, undefined);
  do_check_eq(engine._store.items.rekolok, undefined);

  engine._syncStartupCb(function (err) {
    try {
      engine._processIncoming();

      // Local records have been created from the server data.
      do_check_eq(engine._store.items.flying, "LNER Class A3 4472");
      do_check_eq(engine._store.items.scotsman, "Flying Scotsman");
      do_check_eq(engine._store.items.rekolok, "Rekonstruktionslokomotive");
      do_check_eq(engine._store.items.failed0, "Record No. 0");
      do_check_eq(engine._store.items.failed1, "Record No. 1");
      do_check_eq(engine._store.items.failed2, "Record No. 2");

    } finally {
      cleanAndGo(server);
    }
  });
});

add_test(function test_processIncoming_applyIncomingBatchSize_smaller() {
  _("Ensure that a number of incoming items less than applyIncomingBatchSize is still applied.");
  let syncTesting = new SyncTestingInfrastructure();
  Svc.Prefs.set("clusterURL", "http://localhost:8080/");
  Svc.Prefs.set("username", "foo");

  // Engine that doesn't like the first and last record it's given.
  const APPLY_BATCH_SIZE = 10;
  let engine = makeSteamEngine();
  engine.applyIncomingBatchSize = APPLY_BATCH_SIZE;
  engine._store._applyIncomingBatch = engine._store.applyIncomingBatch;
  engine._store.applyIncomingBatch = function (records) {
    let failed1 = records.shift();
    let failed2 = records.pop();
    this._applyIncomingBatch(records);
    return [failed1.id, failed2.id];
  };

  // Let's create less than a batch worth of server side records.
  let collection = new ServerCollection();
  for (let i = 0; i < APPLY_BATCH_SIZE - 1; i++) {
    let id = 'record-no-' + i;
    let payload = encryptPayload({id: id, denomination: "Record No. " + id});
    collection.wbos[id] = new ServerWBO(id, payload);
  }

  let meta_global = Records.set(engine.metaURL, new WBORecord(engine.metaURL));
  meta_global.payload.engines = {steam: {version: engine.version,
                                         syncID: engine.syncID}};
  let server = sync_httpd_setup({
      "/1.1/foo/storage/steam": collection.handler()
  });

  // Confirm initial environment
  do_check_eq([id for (id in engine._store.items)].length, 0);

  engine._syncStartupCb(function (err) {
    try {
      engine._processIncoming();

      // Records have been applied and the expected failures have failed.
      do_check_eq([id for (id in engine._store.items)].length,
                  APPLY_BATCH_SIZE - 1 - 2);
      do_check_eq(engine.toFetch.length, 0);
      do_check_eq(engine.previousFailed.length, 2);
      do_check_eq(engine.previousFailed[0], "record-no-0");
      do_check_eq(engine.previousFailed[1], "record-no-8");

    } finally {
      cleanAndGo(server);
    }
  });
});

add_test(function test_processIncoming_applyIncomingBatchSize_multiple() {
  _("Ensure that incoming items are applied according to applyIncomingBatchSize.");
  let syncTesting = new SyncTestingInfrastructure();
  Svc.Prefs.set("clusterURL", "http://localhost:8080/");
  Svc.Prefs.set("username", "foo");

  const APPLY_BATCH_SIZE = 10;

  // Engine that applies records in batches.
  let engine = makeSteamEngine();
  engine.applyIncomingBatchSize = APPLY_BATCH_SIZE;
  let batchCalls = 0;
  engine._store._applyIncomingBatch = engine._store.applyIncomingBatch;
  engine._store.applyIncomingBatch = function (records) {
    batchCalls += 1;
    do_check_eq(records.length, APPLY_BATCH_SIZE);
    this._applyIncomingBatch.apply(this, arguments);
  };

  // Let's create three batches worth of server side records.
  let collection = new ServerCollection();
  for (let i = 0; i < APPLY_BATCH_SIZE * 3; i++) {
    let id = 'record-no-' + i;
    let payload = encryptPayload({id: id, denomination: "Record No. " + id});
    collection.wbos[id] = new ServerWBO(id, payload);
  }

  let meta_global = Records.set(engine.metaURL, new WBORecord(engine.metaURL));
  meta_global.payload.engines = {steam: {version: engine.version,
                                         syncID: engine.syncID}};
  let server = sync_httpd_setup({
      "/1.1/foo/storage/steam": collection.handler()
  });

  // Confirm initial environment
  do_check_eq([id for (id in engine._store.items)].length, 0);

  engine._syncStartupCb(function (err) {
    try {
      engine._processIncoming();

      // Records have been applied in 3 batches.
      do_check_eq(batchCalls, 3);
      do_check_eq([id for (id in engine._store.items)].length,
                  APPLY_BATCH_SIZE * 3);

    } finally {
      cleanAndGo(server);
    }
  });
});

add_test(function test_processIncoming_failed_items_reported_once() {
  _("Ensure that failed records are reported only once.");
  let syncTesting = new SyncTestingInfrastructure();
  Svc.Prefs.set("clusterURL", "http://localhost:8080/");
  Svc.Prefs.set("username", "foo");

  const APPLY_BATCH_SIZE = 5;
  const NUMBER_OF_RECORDS = 15;

  // Engine that fails the first record.
  let engine = makeSteamEngine();
  engine.applyIncomingBatchSize = APPLY_BATCH_SIZE;
  engine._store._applyIncomingBatch = engine._store.applyIncomingBatch;
  engine._store.applyIncomingBatch = function (records) {
    engine._store._applyIncomingBatch(records.slice(1));
    return [records[0].id];
  };

  // Create a batch of server side records.
  let collection = new ServerCollection();
  for (var i = 0; i < NUMBER_OF_RECORDS; i++) {
    let id = 'record-no-' + i;
    let payload = encryptPayload({id: id, denomination: "Record No. " + id});
    collection.wbos[id] = new ServerWBO(id, payload);
  }

  let meta_global = Records.set(engine.metaURL, new WBORecord(engine.metaURL));
  meta_global.payload.engines = {steam: {version: engine.version,
                                         syncID: engine.syncID}};
  let server = sync_httpd_setup({
      "/1.1/foo/storage/steam": collection.handler()
  });

  let called = 0;
  let counts;

  // Confirm initial environment.
  do_check_eq(engine.lastSync, 0);
  do_check_eq(engine.toFetch.length, 0);
  do_check_eq(engine.previousFailed.length, 0);
  do_check_eq([id for (id in engine._store.items)].length, 0);

  Svc.Obs.add("weave:engine:sync:apply-failed", function(count) {
    _("Called with " + JSON.stringify(counts));
    counts = count;
    called++;
  });

  // Do sync.
  engine._syncStartupCb(function (err) {
    _("syncStartupCB passed: " + err);

    try {
      engine._processIncoming();

      // Confirm failures.
      do_check_eq([id for (id in engine._store.items)].length, 12);
      do_check_eq(engine.previousFailed.length, 3);
      do_check_eq(engine.previousFailed[0], "record-no-0");
      do_check_eq(engine.previousFailed[1], "record-no-5");
      do_check_eq(engine.previousFailed[2], "record-no-10");

      // There are newly failed records and they are reported.
      do_check_eq(called, 1);
      do_check_eq(counts.failed, 3);
      do_check_eq(counts.applied, 15);
      do_check_eq(counts.newFailed, 3);

      // Sync again, 1 of the failed items are the same, the rest didn't fail.
      engine._processIncoming();

      // Confirming removed failures.
      do_check_eq([id for (id in engine._store.items)].length, 14);
      do_check_eq(engine.previousFailed.length, 1);
      do_check_eq(engine.previousFailed[0], "record-no-0");

      // Failures weren't notified again because there were no newly failed items.
      do_check_eq(called, 1);
      do_check_eq(counts.failed, 3);
      do_check_eq(counts.applied, 15);
      do_check_eq(counts.newFailed, 3);
    } finally {
      server.stop(run_next_test);
      Svc.Prefs.resetBranch("");
      Records.clearCache();
    }
  });
});


add_test(function test_processIncoming_previousFailed() {
  _("Ensure that failed records are retried.");
  let syncTesting = new SyncTestingInfrastructure();
  Svc.Prefs.set("clusterURL", "http://localhost:8080/");
  Svc.Prefs.set("username", "foo");
  Svc.Prefs.set("client.type", "mobile");

  const APPLY_BATCH_SIZE = 4;
  const NUMBER_OF_RECORDS = 14;

  // Engine that fails the first 2 records.
  let engine = makeSteamEngine();
  engine.mobileGUIDFetchBatchSize = engine.applyIncomingBatchSize = APPLY_BATCH_SIZE;
  engine._store._applyIncomingBatch = engine._store.applyIncomingBatch;
  engine._store.applyIncomingBatch = function (records) {
    engine._store._applyIncomingBatch(records.slice(2));
    return [records[0].id, records[1].id];
  };

  // Create a batch of server side records.
  let collection = new ServerCollection();
  for (var i = 0; i < NUMBER_OF_RECORDS; i++) {
    let id = 'record-no-' + i;
    let payload = encryptPayload({id: id, denomination: "Record No. " + i});
    collection.wbos[id] = new ServerWBO(id, payload);
  }

  let meta_global = Records.set(engine.metaURL, new WBORecord(engine.metaURL));
  meta_global.payload.engines = {steam: {version: engine.version,
                                         syncID: engine.syncID}};
  let server = sync_httpd_setup({
      "/1.1/foo/storage/steam": collection.handler()
  });

  // Confirm initial environment.
  do_check_eq(engine.lastSync, 0);
  do_check_eq(engine.toFetch.length, 0);
  do_check_eq(engine.previousFailed.length, 0);
  do_check_eq([id for (id in engine._store.items)].length, 0);

  // Initial failed items in previousFailed to be reset.
  let previousFailed = [Utils.makeGUID(), Utils.makeGUID(), Utils.makeGUID()];
  engine.previousFailed = previousFailed;
  do_check_eq(engine.previousFailed, previousFailed);

  // Do sync.
  engine._syncStartupCb(function (err) {
    do_check_true(!err);

    try {
      engine._processIncoming();

      // Expected result: 4 sync batches with 2 failures each => 8 failures
      do_check_eq([id for (id in engine._store.items)].length, 6);
      do_check_eq(engine.previousFailed.length, 8);
      do_check_eq(engine.previousFailed[0], "record-no-0");
      do_check_eq(engine.previousFailed[1], "record-no-1");
      do_check_eq(engine.previousFailed[2], "record-no-4");
      do_check_eq(engine.previousFailed[3], "record-no-5");
      do_check_eq(engine.previousFailed[4], "record-no-8");
      do_check_eq(engine.previousFailed[5], "record-no-9");
      do_check_eq(engine.previousFailed[6], "record-no-12");
      do_check_eq(engine.previousFailed[7], "record-no-13");

      // Sync again with the same failed items (records 0, 1, 8, 9).
      engine._processIncoming();

      // A second sync with the same failed items should not add the same items again.
      // Items that did not fail a second time should no longer be in previousFailed.
      do_check_eq([id for (id in engine._store.items)].length, 10);
      do_check_eq(engine.previousFailed.length, 4);
      do_check_eq(engine.previousFailed[0], "record-no-0");
      do_check_eq(engine.previousFailed[1], "record-no-1");
      do_check_eq(engine.previousFailed[2], "record-no-8");
      do_check_eq(engine.previousFailed[3], "record-no-9");

      // Refetched items that didn't fail the second time are in engine._store.items.
      do_check_eq(engine._store.items['record-no-4'], "Record No. 4");
      do_check_eq(engine._store.items['record-no-5'], "Record No. 5");
      do_check_eq(engine._store.items['record-no-12'], "Record No. 12");
      do_check_eq(engine._store.items['record-no-13'], "Record No. 13");
    } finally {
      server.stop(run_next_test);
      Svc.Prefs.resetBranch("");
      Records.clearCache();
    }
  });
});


add_test(function test_processIncoming_failed_records() {
  _("Ensure that failed records from _reconcile and applyIncomingBatch are refetched.");
  let syncTesting = new SyncTestingInfrastructure();
  Svc.Prefs.set("clusterURL", "http://localhost:8080/");
  Svc.Prefs.set("username", "foo");

  // Let's create three and a bit batches worth of server side records.
  let collection = new ServerCollection();
  const NUMBER_OF_RECORDS = MOBILE_BATCH_SIZE * 3 + 5;
  for (var i = 0; i < NUMBER_OF_RECORDS; i++) {
    let id = 'record-no-' + i;
    let payload = encryptPayload({id: id, denomination: "Record No. " + id});
    let wbo = new ServerWBO(id, payload);
    wbo.modified = Date.now()/1000 + 60 * (i - MOBILE_BATCH_SIZE * 3);
    collection.wbos[id] = wbo;
  }

  // Engine that batches but likes to throw on a couple of records,
  // two in each batch: the even ones fail in reconcile, the odd ones
  // in applyIncoming.
  const BOGUS_RECORDS = ["record-no-" + 42,
                         "record-no-" + 23,
                         "record-no-" + (42 + MOBILE_BATCH_SIZE),
                         "record-no-" + (23 + MOBILE_BATCH_SIZE),
                         "record-no-" + (42 + MOBILE_BATCH_SIZE * 2),
                         "record-no-" + (23 + MOBILE_BATCH_SIZE * 2),
                         "record-no-" + (2 + MOBILE_BATCH_SIZE * 3),
                         "record-no-" + (1 + MOBILE_BATCH_SIZE * 3)];
  let engine = makeSteamEngine();
  engine.applyIncomingBatchSize = MOBILE_BATCH_SIZE;

  engine.__reconcile = engine._reconcile;
  engine._reconcile = function _reconcile(record) {
    if (BOGUS_RECORDS.indexOf(record.id) % 2 == 0) {
      throw "I don't like this record! Baaaaaah!";
    }
    return this.__reconcile.apply(this, arguments);
  };
  engine._store._applyIncoming = engine._store.applyIncoming;
  engine._store.applyIncoming = function (record) {
    if (BOGUS_RECORDS.indexOf(record.id) % 2 == 1) {
      throw "I don't like this record! Baaaaaah!";
    }
    return this._applyIncoming.apply(this, arguments);
  };

  let meta_global = Records.set(engine.metaURL, new WBORecord(engine.metaURL));
  meta_global.payload.engines = {steam: {version: engine.version,
                                         syncID: engine.syncID}};

  // Keep track of requests made of a collection.
  let count = 0;
  let uris  = [];
  function recording_handler(collection) {
    let h = collection.handler();
    return function(req, res) {
      ++count;
      uris.push(req.path + "?" + req.queryString);
      return h(req, res);
    };
  }
  let server = sync_httpd_setup({
      "/1.1/foo/storage/steam": recording_handler(collection)
  });

  // Confirm initial environment
  do_check_eq(engine.lastSync, 0);
  do_check_eq(engine.toFetch.length, 0);
  do_check_eq(engine.previousFailed.length, 0);
  do_check_eq([id for (id in engine._store.items)].length, 0);

  let observerSubject;
  let observerData;
  Svc.Obs.add("weave:engine:sync:apply-failed",
              function onApplyFailed(subject, data) {
    Svc.Obs.remove("weave:engine:sync:apply-failed", onApplyFailed);
    observerSubject = subject;
    observerData = data;
  });

  engine._syncStartupCb(function (err) {
    try {
      engine._processIncoming();
      _("_processIncoming done.");

      // Ensure that all records but the bogus 4 have been applied.
      do_check_eq([id for (id in engine._store.items)].length,
                  NUMBER_OF_RECORDS - BOGUS_RECORDS.length);

      // Ensure that the bogus records will be fetched again on the next sync.
      do_check_eq(engine.previousFailed.length, BOGUS_RECORDS.length);
      engine.previousFailed.sort();
      BOGUS_RECORDS.sort();
      for (let i = 0; i < engine.previousFailed.length; i++) {
        do_check_eq(engine.previousFailed[i], BOGUS_RECORDS[i]);
      }

      // Ensure the observer was notified
      do_check_eq(observerData, engine.name);
      do_check_eq(observerSubject.failed, BOGUS_RECORDS.length);

      // Testing batching of failed item fetches.
      // Try to sync again. Ensure that we split the request into chunks to avoid
      // URI length limitations.
      function batchDownload(batchSize) {
        count = 0;
        uris  = [];
        engine.guidFetchBatchSize = batchSize;
        engine._processIncoming();
        _("Tried again. Requests: " + count + "; URIs: " + JSON.stringify(uris));
        return count;
      }

      // There are 8 bad records, so this needs 3 additional fetches.
      // There's always one fetch for "records since".
      _("Test batching with ID batch size 3, normal mobile batch size.");
      do_check_eq(batchDownload(3), 4);

      // Now see with a more realistic limit.
      _("Test batching with sufficient ID batch size.");
      do_check_eq(batchDownload(BOGUS_RECORDS.length), 2);

      // If we're on mobile, that limit is used by default.
      _("Test batching with tiny mobile batch size.");
      Svc.Prefs.set("client.type", "mobile");
      engine.mobileGUIDFetchBatchSize = 2;
      do_check_eq(batchDownload(BOGUS_RECORDS.length), 5);

    } finally {
      cleanAndGo(server);
    }
  });
});

add_test(function test_processIncoming_decrypt_failed() {
  _("Ensure that records failing to decrypt are either replaced or refetched.");
  Svc.Prefs.set("clusterURL", "http://localhost:8080/");
  Svc.Prefs.set("username", "foo");

  // Some good and some bogus records. One doesn't contain valid JSON,
  // the other will throw during decrypt.
  let collection = new ServerCollection();
  collection.wbos.flying = new ServerWBO(
      'flying', encryptPayload({id: 'flying',
                                denomination: "LNER Class A3 4472"}));
  collection.wbos.nojson = new ServerWBO("nojson", "This is invalid JSON");
  collection.wbos.nojson2 = new ServerWBO("nojson2", "This is invalid JSON");
  collection.wbos.scotsman = new ServerWBO(
      'scotsman', encryptPayload({id: 'scotsman',
                                  denomination: "Flying Scotsman"}));
  collection.wbos.nodecrypt = new ServerWBO("nodecrypt", "Decrypt this!");
  collection.wbos.nodecrypt2 = new ServerWBO("nodecrypt2", "Decrypt this!");

  // Patch the fake crypto service to throw on the record above.
  Svc.Crypto._decrypt = Svc.Crypto.decrypt;
  Svc.Crypto.decrypt = function (ciphertext) {
    if (ciphertext == "Decrypt this!") {
      throw "Derp! Cipher finalized failed. Im ur crypto destroyin ur recordz.";
    }
    return this._decrypt.apply(this, arguments);
  };

  // Some broken records also exist locally.
  let engine = makeSteamEngine();
  engine.enabled = true;
  engine._store.items = {nojson: "Valid JSON",
                         nodecrypt: "Valid ciphertext"};

  let meta_global = Records.set(engine.metaURL, new WBORecord(engine.metaURL));
  meta_global.payload.engines = {steam: {version: engine.version,
                                         syncID: engine.syncID}};
  let server = sync_httpd_setup({
      "/1.1/foo/storage/steam": collection.handler()
  });

  try {

    // Confirm initial state
    do_check_eq(engine.toFetch.length, 0);
    do_check_eq(engine.previousFailed.length, 0);

    let observerSubject;
    let observerData;
    Svc.Obs.add("weave:engine:sync:apply-failed",
                function onApplyFailed(subject, data) {
      Svc.Obs.remove("weave:engine:sync:apply-failed", onApplyFailed);
      observerSubject = subject;
      observerData = data;
    });

    engine.lastSync = collection.wbos.nojson.modified - 1;
    engine.sync();

    do_check_eq(engine.previousFailed.length, 4);
    do_check_eq(engine.previousFailed[0], "nojson");
    do_check_eq(engine.previousFailed[1], "nojson2");
    do_check_eq(engine.previousFailed[2], "nodecrypt");
    do_check_eq(engine.previousFailed[3], "nodecrypt2");

    // Ensure the observer was notified
    do_check_eq(observerData, engine.name);
    do_check_eq(observerSubject.applied, 2);
    do_check_eq(observerSubject.failed, 4);

  } finally {
    cleanAndGo(server);
  }
});


add_test(function test_uploadOutgoing_toEmptyServer() {
  _("SyncEngine._uploadOutgoing uploads new records to server");

  let syncTesting = new SyncTestingInfrastructure();
  Svc.Prefs.set("clusterURL", "http://localhost:8080/");
  Svc.Prefs.set("username", "foo");
  let collection = new ServerCollection();
  collection.wbos.flying = new ServerWBO('flying');
  collection.wbos.scotsman = new ServerWBO('scotsman');

  let server = sync_httpd_setup({
      "/1.1/foo/storage/steam": collection.handler(),
      "/1.1/foo/storage/steam/flying": collection.wbos.flying.handler(),
      "/1.1/foo/storage/steam/scotsman": collection.wbos.scotsman.handler()
  });
  generateNewKeys();

  let engine = makeSteamEngine();
  engine.lastSync = 123; // needs to be non-zero so that tracker is queried
  engine._store.items = {flying: "LNER Class A3 4472",
                         scotsman: "Flying Scotsman"};
  // Mark one of these records as changed 
  engine._tracker.addChangedID('scotsman', 0);

  let meta_global = Records.set(engine.metaURL, new WBORecord(engine.metaURL));
  meta_global.payload.engines = {steam: {version: engine.version,
                                         syncID: engine.syncID}};

  // Confirm initial environment
  do_check_eq(engine.lastSyncLocal, 0);
  do_check_eq(collection.wbos.flying.payload, undefined);
  do_check_eq(collection.wbos.scotsman.payload, undefined);

  engine._syncStartupCb(function (err) {
    try {
      engine._uploadOutgoing();

      // Local timestamp has been set.
      do_check_true(engine.lastSyncLocal > 0);

      // Ensure the marked record ('scotsman') has been uploaded and is
      // no longer marked.
      do_check_eq(collection.wbos.flying.payload, undefined);
      do_check_true(!!collection.wbos.scotsman.payload);
      do_check_eq(JSON.parse(collection.wbos.scotsman.data.ciphertext).id,
                  'scotsman');
      do_check_eq(engine._tracker.changedIDs['scotsman'], undefined);

      // The 'flying' record wasn't marked so it wasn't uploaded
      do_check_eq(collection.wbos.flying.payload, undefined);

    } finally {
      cleanAndGo(server);
    }
  });
});


add_test(function test_uploadOutgoing_failed() {
  _("SyncEngine._uploadOutgoing doesn't clear the tracker of objects that failed to upload.");

  let syncTesting = new SyncTestingInfrastructure();
  Svc.Prefs.set("clusterURL", "http://localhost:8080/");
  Svc.Prefs.set("username", "foo");
  let collection = new ServerCollection();
  // We only define the "flying" WBO on the server, not the "scotsman"
  // and "peppercorn" ones.
  collection.wbos.flying = new ServerWBO('flying');

  let server = sync_httpd_setup({
      "/1.1/foo/storage/steam": collection.handler()
  });

  let engine = makeSteamEngine();
  engine.lastSync = 123; // needs to be non-zero so that tracker is queried
  engine._store.items = {flying: "LNER Class A3 4472",
                         scotsman: "Flying Scotsman",
                         peppercorn: "Peppercorn Class"};
  // Mark these records as changed 
  const FLYING_CHANGED = 12345;
  const SCOTSMAN_CHANGED = 23456;
  const PEPPERCORN_CHANGED = 34567;
  engine._tracker.addChangedID('flying', FLYING_CHANGED);
  engine._tracker.addChangedID('scotsman', SCOTSMAN_CHANGED);
  engine._tracker.addChangedID('peppercorn', PEPPERCORN_CHANGED);

  let meta_global = Records.set(engine.metaURL, new WBORecord(engine.metaURL));
  meta_global.payload.engines = {steam: {version: engine.version,
                                         syncID: engine.syncID}};

  try {

    // Confirm initial environment
    do_check_eq(engine.lastSyncLocal, 0);
    do_check_eq(collection.wbos.flying.payload, undefined);
    do_check_eq(engine._tracker.changedIDs['flying'], FLYING_CHANGED);
    do_check_eq(engine._tracker.changedIDs['scotsman'], SCOTSMAN_CHANGED);
    do_check_eq(engine._tracker.changedIDs['peppercorn'], PEPPERCORN_CHANGED);

    engine.enabled = true;
    engine.sync();

    // Local timestamp has been set.
    do_check_true(engine.lastSyncLocal > 0);

    // Ensure the 'flying' record has been uploaded and is no longer marked.
    do_check_true(!!collection.wbos.flying.payload);
    do_check_eq(engine._tracker.changedIDs['flying'], undefined);

    // The 'scotsman' and 'peppercorn' records couldn't be uploaded so
    // they weren't cleared from the tracker.
    do_check_eq(engine._tracker.changedIDs['scotsman'], SCOTSMAN_CHANGED);
    do_check_eq(engine._tracker.changedIDs['peppercorn'], PEPPERCORN_CHANGED);

  } finally {
    cleanAndGo(server);
  }
});


add_test(function test_uploadOutgoing_MAX_UPLOAD_RECORDS() {
  _("SyncEngine._uploadOutgoing uploads in batches of MAX_UPLOAD_RECORDS");

  let syncTesting = new SyncTestingInfrastructure();
  Svc.Prefs.set("clusterURL", "http://localhost:8080/");
  Svc.Prefs.set("username", "foo");
  let collection = new ServerCollection();

  // Let's count how many times the client posts to the server
  var noOfUploads = 0;
  collection.post = (function(orig) {
    return function() {
      noOfUploads++;
      return orig.apply(this, arguments);
    };
  }(collection.post));

  // Create a bunch of records (and server side handlers)
  let engine = makeSteamEngine();
  for (var i = 0; i < 234; i++) {
    let id = 'record-no-' + i;
    engine._store.items[id] = "Record No. " + i;
    engine._tracker.addChangedID(id, 0);
    collection.wbos[id] = new ServerWBO(id);
  }

  let meta_global = Records.set(engine.metaURL, new WBORecord(engine.metaURL));
  meta_global.payload.engines = {steam: {version: engine.version,
                                         syncID: engine.syncID}};

  let server = sync_httpd_setup({
      "/1.1/foo/storage/steam": collection.handler()
  });

  // Confirm initial environment
  do_check_eq(noOfUploads, 0);

  engine._syncStartupCb(function (err) {
    try {
      engine._uploadOutgoing();

      // Ensure all records have been uploaded
      for (i = 0; i < 234; i++) {
        do_check_true(!!collection.wbos['record-no-'+i].payload);
      }

      // Ensure that the uploads were performed in batches of MAX_UPLOAD_RECORDS
      do_check_eq(noOfUploads, Math.ceil(234/MAX_UPLOAD_RECORDS));

    } finally {
      cleanAndGo(server);
    }
  });
});


add_test(function test_syncFinish_noDelete() {
  _("SyncEngine._syncFinish resets tracker's score");
  let engine = makeSteamEngine();
  engine._delete = {}; // Nothing to delete
  engine._tracker.score = 100;

  // _syncFinish() will reset the engine's score.
  engine._syncFinish();
  do_check_eq(engine.score, 0);
  run_next_test();
});


add_test(function test_syncFinish_deleteByIds() {
  _("SyncEngine._syncFinish deletes server records slated for deletion (list of record IDs).");

  let syncTesting = new SyncTestingInfrastructure();
  Svc.Prefs.set("clusterURL", "http://localhost:8080/");
  Svc.Prefs.set("username", "foo");
  let collection = new ServerCollection();
  collection.wbos.flying = new ServerWBO(
      'flying', encryptPayload({id: 'flying',
                                denomination: "LNER Class A3 4472"}));
  collection.wbos.scotsman = new ServerWBO(
      'scotsman', encryptPayload({id: 'scotsman',
                                  denomination: "Flying Scotsman"}));
  collection.wbos.rekolok = new ServerWBO(
      'rekolok', encryptPayload({id: 'rekolok',
                                denomination: "Rekonstruktionslokomotive"}));

  let server = httpd_setup({
      "/1.1/foo/storage/steam": collection.handler()
  });

  let engine = makeSteamEngine();
  try {
    engine._delete = {ids: ['flying', 'rekolok']};
    engine._syncFinish();

    // The 'flying' and 'rekolok' records were deleted while the
    // 'scotsman' one wasn't.
    do_check_eq(collection.wbos.flying.payload, undefined);
    do_check_true(!!collection.wbos.scotsman.payload);
    do_check_eq(collection.wbos.rekolok.payload, undefined);

    // The deletion todo list has been reset.
    do_check_eq(engine._delete.ids, undefined);

  } finally {
    cleanAndGo(server);
  }
});


add_test(function test_syncFinish_deleteLotsInBatches() {
  _("SyncEngine._syncFinish deletes server records in batches of 100 (list of record IDs).");

  let syncTesting = new SyncTestingInfrastructure();
  Svc.Prefs.set("clusterURL", "http://localhost:8080/");
  Svc.Prefs.set("username", "foo");
  let collection = new ServerCollection();

  // Let's count how many times the client does a DELETE request to the server
  var noOfUploads = 0;
  collection.delete = (function(orig) {
    return function() {
      noOfUploads++;
      return orig.apply(this, arguments);
    };
  }(collection.delete));

  // Create a bunch of records on the server
  let now = Date.now();
  for (var i = 0; i < 234; i++) {
    let id = 'record-no-' + i;
    let payload = encryptPayload({id: id, denomination: "Record No. " + i});
    let wbo = new ServerWBO(id, payload);
    wbo.modified = now / 1000 - 60 * (i + 110);
    collection.wbos[id] = wbo;
  }

  let server = httpd_setup({
      "/1.1/foo/storage/steam": collection.handler()
  });

  let engine = makeSteamEngine();
  try {

    // Confirm initial environment
    do_check_eq(noOfUploads, 0);

    // Declare what we want to have deleted: all records no. 100 and
    // up and all records that are less than 200 mins old (which are
    // records 0 thru 90).
    engine._delete = {ids: [],
                      newer: now / 1000 - 60 * 200.5};
    for (i = 100; i < 234; i++) {
      engine._delete.ids.push('record-no-' + i);
    }

    engine._syncFinish();

    // Ensure that the appropriate server data has been wiped while
    // preserving records 90 thru 200.
    for (i = 0; i < 234; i++) {
      let id = 'record-no-' + i;
      if (i <= 90 || i >= 100) {
        do_check_eq(collection.wbos[id].payload, undefined);
      } else {
        do_check_true(!!collection.wbos[id].payload);
      }
    }

    // The deletion was done in batches
    do_check_eq(noOfUploads, 2 + 1);

    // The deletion todo list has been reset.
    do_check_eq(engine._delete.ids, undefined);

  } finally {
    cleanAndGo(server);
  }
});


add_test(function test_sync_partialUpload() {
  _("SyncEngine.sync() keeps changedIDs that couldn't be uploaded.");

  let syncTesting = new SyncTestingInfrastructure();
  Svc.Prefs.set("clusterURL", "http://localhost:8080/");
  Svc.Prefs.set("username", "foo");

  let collection = new ServerCollection();
  let server = sync_httpd_setup({
      "/1.1/foo/storage/steam": collection.handler()
  });
  generateNewKeys();

  let engine = makeSteamEngine();
  engine.lastSync = 123; // needs to be non-zero so that tracker is queried
  engine.lastSyncLocal = 456;

  // Let the third upload fail completely
  var noOfUploads = 0;
  collection.post = (function(orig) {
    return function() {
      if (noOfUploads == 2)
        throw "FAIL!";
      noOfUploads++;
      return orig.apply(this, arguments);
    };
  }(collection.post));

  // Create a bunch of records (and server side handlers)
  for (let i = 0; i < 234; i++) {
    let id = 'record-no-' + i;
    engine._store.items[id] = "Record No. " + i;
    engine._tracker.addChangedID(id, i);
    // Let two items in the first upload batch fail.
    if ((i != 23) && (i != 42))
      collection.wbos[id] = new ServerWBO(id);
  }

  let meta_global = Records.set(engine.metaURL, new WBORecord(engine.metaURL));
  meta_global.payload.engines = {steam: {version: engine.version,
                                         syncID: engine.syncID}};

  try {

    engine.enabled = true;
    let error;
    try {
      engine.sync();
    } catch (ex) {
      error = ex;
    }
    do_check_true(!!error);

    // The timestamp has been updated.
    do_check_true(engine.lastSyncLocal > 456);

    for (let i = 0; i < 234; i++) {
      let id = 'record-no-' + i;
      // Ensure failed records are back in the tracker:
      // * records no. 23 and 42 were rejected by the server,
      // * records no. 200 and higher couldn't be uploaded because we failed
      //   hard on the 3rd upload.
      if ((i == 23) || (i == 42) || (i >= 200))
        do_check_eq(engine._tracker.changedIDs[id], i);
      else
        do_check_false(id in engine._tracker.changedIDs);
    }

  } finally {
    cleanAndGo(server);
  }
});

add_test(function test_canDecrypt_noCryptoKeys() {
  _("SyncEngine.canDecrypt returns false if the engine fails to decrypt items on the server, e.g. due to a missing crypto key collection.");
  let syncTesting = new SyncTestingInfrastructure();
  Svc.Prefs.set("clusterURL", "http://localhost:8080/");
  Svc.Prefs.set("username", "foo");

  // Wipe CollectionKeys so we can test the desired scenario.
  CollectionKeys.clear();

  let collection = new ServerCollection();
  collection.wbos.flying = new ServerWBO(
      'flying', encryptPayload({id: 'flying',
                                denomination: "LNER Class A3 4472"}));

  let server = sync_httpd_setup({
      "/1.1/foo/storage/steam": collection.handler()
  });

  let engine = makeSteamEngine();
  try {

    do_check_false(engine.canDecrypt());

  } finally {
    cleanAndGo(server);
  }
});

add_test(function test_canDecrypt_true() {
  _("SyncEngine.canDecrypt returns true if the engine can decrypt the items on the server.");
  let syncTesting = new SyncTestingInfrastructure();
  Svc.Prefs.set("clusterURL", "http://localhost:8080/");
  Svc.Prefs.set("username", "foo");

  // Set up CollectionKeys, as service.js does.
  generateNewKeys();
  
  let collection = new ServerCollection();
  collection.wbos.flying = new ServerWBO(
      'flying', encryptPayload({id: 'flying',
                                denomination: "LNER Class A3 4472"}));

  let server = sync_httpd_setup({
      "/1.1/foo/storage/steam": collection.handler()
  });

  let engine = makeSteamEngine();
  try {
    do_check_true(engine.canDecrypt());
  } finally {
    cleanAndGo(server);
  }
});

function run_test() {
  if (DISABLE_TESTS_BUG_604565)
    return;

  generateNewKeys();

  run_next_test();
}
