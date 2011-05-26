/* ***** BEGIN LICENSE BLOCK *****
 * Version: MPL 1.1/GPL 2.0/LGPL 2.1
 *
 * The contents of this file are subject to the Mozilla Public License Version
 * 1.1 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
 * for the specific language governing rights and limitations under the
 * License.
 *
 * The Original Code is Bookmarks Sync.
 *
 * The Initial Developer of the Original Code is Mozilla.
 * Portions created by the Initial Developer are Copyright (C) 2007
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *  Dan Mills <thunder@mozilla.com>
 *  Myk Melez <myk@mozilla.org>
 *  Anant Narayanan <anant@kix.in>
 *  Philipp von Weitershausen <philipp@weitershausen.de>
 *  Richard Newman <rnewman@mozilla.com>
 *
 * Alternatively, the contents of this file may be used under the terms of
 * either the GNU General Public License Version 2 or later (the "GPL"), or
 * the GNU Lesser General Public License Version 2.1 or later (the "LGPL"),
 * in which case the provisions of the GPL or the LGPL are applicable instead
 * of those above. If you wish to allow use of your version of this file only
 * under the terms of either the GPL or the LGPL, and not to allow others to
 * use your version of this file under the terms of the MPL, indicate your
 * decision by deleting the provisions above and replace them with the notice
 * and other provisions required by the GPL or the LGPL. If you do not delete
 * the provisions above, a recipient may use your version of this file under
 * the terms of any one of the MPL, the GPL or the LGPL.
 *
 * ***** END LICENSE BLOCK ***** */

const EXPORTED_SYMBOLS = ['Engines', 'Engine', 'SyncEngine',
                          'Tracker', 'Store'];

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cr = Components.results;
const Cu = Components.utils;

Cu.import("resource://services-sync/record.js");
Cu.import("resource://services-sync/constants.js");
Cu.import("resource://services-sync/ext/Observers.js");
Cu.import("resource://services-sync/identity.js");
Cu.import("resource://services-sync/log4moz.js");
Cu.import("resource://services-sync/resource.js");
Cu.import("resource://services-sync/util.js");
Cu.import("resource://services-sync/async.js");

Cu.import("resource://services-sync/main.js");    // So we can get to Service for callbacks.

/*
 * Trackers are associated with a single engine and deal with
 * listening for changes to their particular data type.
 *
 * There are two things they keep track of:
 * 1) A score, indicating how urgently the engine wants to sync
 * 2) A list of IDs for all the changed items that need to be synced
 * and updating their 'score', indicating how urgently they
 * want to sync.
 *
 */
function Tracker(name) {
  name = name || "Unnamed";
  this.name = this.file = name.toLowerCase();

  this._log = Log4Moz.repository.getLogger("Tracker." + name);
  let level = Svc.Prefs.get("log.logger.engine." + this.name, "Debug");
  this._log.level = Log4Moz.Level[level];

  this._score = 0;
  this._ignored = [];
  this.ignoreAll = false;
  this.changedIDs = {};
  this.loadChangedIDs();
}
Tracker.prototype = {
  /*
   * Score can be called as often as desired to decide which engines to sync
   *
   * Valid values for score:
   * -1: Do not sync unless the user specifically requests it (almost disabled)
   * 0: Nothing has changed
   * 100: Please sync me ASAP!
   *
   * Setting it to other values should (but doesn't currently) throw an exception
   */
  get score() {
    return this._score;
  },

  set score(value) {
    this._score = value;
    Observers.notify("weave:engine:score:updated", this.name);
  },

  // Should be called by service everytime a sync has been done for an engine
  resetScore: function T_resetScore() {
    this._score = 0;
  },

  saveChangedIDs: function T_saveChangedIDs() {
    Utils.delay(function() {
      Utils.jsonSave("changes/" + this.file, this, this.changedIDs);
    }, 1000, this, "_lazySave");
  },

  loadChangedIDs: function T_loadChangedIDs() {
    Utils.jsonLoad("changes/" + this.file, this, function(json) {
      if (json) {
        this.changedIDs = json;
      }
    });
  },

  // ignore/unignore specific IDs.  Useful for ignoring items that are
  // being processed, or that shouldn't be synced.
  // But note: not persisted to disk

  ignoreID: function T_ignoreID(id) {
    this.unignoreID(id);
    this._ignored.push(id);
  },

  unignoreID: function T_unignoreID(id) {
    let index = this._ignored.indexOf(id);
    if (index != -1)
      this._ignored.splice(index, 1);
  },

  addChangedID: function addChangedID(id, when) {
    if (!id) {
      this._log.warn("Attempted to add undefined ID to tracker");
      return false;
    }
    if (this.ignoreAll || (id in this._ignored))
      return false;

    // Default to the current time in seconds if no time is provided
    if (when == null)
      when = Math.floor(Date.now() / 1000);

    // Add/update the entry if we have a newer time
    if ((this.changedIDs[id] || -Infinity) < when) {
      this._log.trace("Adding changed ID: " + [id, when]);
      this.changedIDs[id] = when;
      this.saveChangedIDs();
    }
    return true;
  },

  removeChangedID: function T_removeChangedID(id) {
    if (!id) {
      this._log.warn("Attempted to remove undefined ID to tracker");
      return false;
    }
    if (this.ignoreAll || (id in this._ignored))
      return false;
    if (this.changedIDs[id] != null) {
      this._log.trace("Removing changed ID " + id);
      delete this.changedIDs[id];
      this.saveChangedIDs();
    }
    return true;
  },

  clearChangedIDs: function T_clearChangedIDs() {
    this._log.trace("Clearing changed ID list");
    this.changedIDs = {};
    this.saveChangedIDs();
  }
};



/*
 * Data Stores
 * These can wrap, serialize items and apply commands
 */

function Store(name) {
  name = name || "Unnamed";
  this.name = name.toLowerCase();

  this._log = Log4Moz.repository.getLogger("Store." + name);
  let level = Svc.Prefs.get("log.logger.engine." + this.name, "Debug");
  this._log.level = Log4Moz.Level[level];

  XPCOMUtils.defineLazyGetter(this, "_timer", function() {
    return Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
  });
}
Store.prototype = {

  _sleep: function _sleep(delay) {
    let cb = Async.makeSyncCallback();
    this._timer.initWithCallback({notify: cb}, delay,
                                 Ci.nsITimer.TYPE_ONE_SHOT);
    Async.waitForSyncCallback(cb);
  },

  applyIncomingBatch: function applyIncomingBatch(records) {
    let failed = [];
    for each (let record in records) {
      try {
        this.applyIncoming(record);
      } catch (ex) {
        this._log.warn("Failed to apply incoming record " + record.id);
        this._log.warn("Encountered exception: " + Utils.exceptionStr(ex));
        failed.push(record.id);
      }
    };
    return failed;
  },

  applyIncoming: function Store_applyIncoming(record) {
    if (record.deleted)
      this.remove(record);
    else if (!this.itemExists(record.id))
      this.create(record);
    else
      this.update(record);
  },

  // override these in derived objects

  create: function Store_create(record) {
    throw "override create in a subclass";
  },

  remove: function Store_remove(record) {
    throw "override remove in a subclass";
  },

  update: function Store_update(record) {
    throw "override update in a subclass";
  },

  itemExists: function Store_itemExists(id) {
    throw "override itemExists in a subclass";
  },

  createRecord: function Store_createRecord(id, collection) {
    throw "override createRecord in a subclass";
  },

  changeItemID: function Store_changeItemID(oldID, newID) {
    throw "override changeItemID in a subclass";
  },

  getAllIDs: function Store_getAllIDs() {
    throw "override getAllIDs in a subclass";
  },

  wipe: function Store_wipe() {
    throw "override wipe in a subclass";
  }
};


// Singleton service, holds registered engines

XPCOMUtils.defineLazyGetter(this, "Engines", function() {
  return new EngineManagerSvc();
});

function EngineManagerSvc() {
  this._engines = {};
  this._log = Log4Moz.repository.getLogger("Service.Engines");
  this._log.level = Log4Moz.Level[Svc.Prefs.get(
    "log.logger.service.engines", "Debug")];
}
EngineManagerSvc.prototype = {
  get: function EngMgr_get(name) {
    // Return an array of engines if we have an array of names
    if (Utils.isArray(name)) {
      let engines = [];
      name.forEach(function(name) {
        let engine = this.get(name);
        if (engine)
          engines.push(engine);
      }, this);
      return engines;
    }

    let engine = this._engines[name];
    if (!engine) {
      this._log.debug("Could not get engine: " + name);
      if (Object.keys)
        this._log.debug("Engines are: " + JSON.stringify(Object.keys(this._engines)));
    }
    return engine;
  },
  getAll: function EngMgr_getAll() {
    return [engine for ([name, engine] in Iterator(Engines._engines))];
  },
  getEnabled: function EngMgr_getEnabled() {
    return this.getAll().filter(function(engine) engine.enabled);
  },

  /**
   * Register an Engine to the service. Alternatively, give an array of engine
   * objects to register.
   *
   * @param engineObject
   *        Engine object used to get an instance of the engine
   * @return The engine object if anything failed
   */
  register: function EngMgr_register(engineObject) {
    if (Utils.isArray(engineObject))
      return engineObject.map(this.register, this);

    try {
      let engine = new engineObject();
      let name = engine.name;
      if (name in this._engines)
        this._log.error("Engine '" + name + "' is already registered!");
      else
        this._engines[name] = engine;
    }
    catch(ex) {
      let mesg = ex.message ? ex.message : ex;
      let name = engineObject || "";
      name = name.prototype || "";
      name = name.name || "";

      let out = "Could not initialize engine '" + name + "': " + mesg;
      this._log.error(out);

      return engineObject;
    }
  },
  unregister: function EngMgr_unregister(val) {
    let name = val;
    if (val instanceof Engine)
      name = val.name;
    delete this._engines[name];
  }
};

function Engine(name) {
  this.Name = name || "Unnamed";
  this.name = name.toLowerCase();

  this._notify = Utils.notify("weave:engine:");
  this._log = Log4Moz.repository.getLogger("Engine." + this.Name);
  let level = Svc.Prefs.get("log.logger.engine." + this.name, "Debug");
  this._log.level = Log4Moz.Level[level];

  this._tracker; // initialize tracker to load previously changed IDs
  this._log.debug("Engine initialized");
}
Engine.prototype = {
  // _storeObj, and _trackerObj should to be overridden in subclasses
  _storeObj: Store,
  _trackerObj: Tracker,

  get prefName() this.name,
  get enabled() Svc.Prefs.get("engine." + this.prefName, false),
  set enabled(val) Svc.Prefs.set("engine." + this.prefName, !!val),

  get score() this._tracker.score,

  get _store() {
    let store = new this._storeObj(this.Name);
    this.__defineGetter__("_store", function() store);
    return store;
  },

  get _tracker() {
    let tracker = new this._trackerObj(this.Name);
    this.__defineGetter__("_tracker", function() tracker);
    return tracker;
  },

  sync: function Engine_sync() {
    if (!this.enabled)
      return;

    if (!this._sync)
      throw "engine does not implement _sync method";

    this._notify("sync", this.name, this._sync)();
  },

  /**
   * Get rid of any local metadata.
   */
  resetClient: function Engine_resetClient() {
    if (!this._resetClient)
      throw "engine does not implement _resetClient method";

    this._notify("reset-client", this.name, this._resetClient)();
  },

  _wipeClient: function Engine__wipeClient() {
    this.resetClient();
    this._log.debug("Deleting all local data");
    this._tracker.ignoreAll = true;
    this._store.wipe();
    this._tracker.ignoreAll = false;
    this._tracker.clearChangedIDs();
  },

  wipeClient: function Engine_wipeClient() {
    this._notify("wipe-client", this.name, this._wipeClient)();
  }
};

function SyncEngine(name) {
  Engine.call(this, name || "SyncEngine");
  this.loadToFetch();
}

// Enumeration to define approaches to handling bad records.
// Attached to the constructor to allow use as a kind of static enumeration.
SyncEngine.kRecoveryStrategy = {
  ignore: "ignore",
  retry:  "retry",
  error:  "error"
};

SyncEngine.prototype = {
  __proto__: Engine.prototype,
  _recordObj: CryptoWrapper,
  version: 1,

  // How many records to pull in a single sync. This is primarily to avoid very
  // long first syncs against profiles with many history records.
  downloadLimit: null,

  // How many records to pull at one time when specifying IDs. This is to avoid
  // URI length limitations.
  guidFetchBatchSize: DEFAULT_GUID_FETCH_BATCH_SIZE,
  mobileGUIDFetchBatchSize: DEFAULT_MOBILE_GUID_FETCH_BATCH_SIZE,

  // How many records to process in a single batch.
  applyIncomingBatchSize: DEFAULT_STORE_BATCH_SIZE,

  get storageURL() Svc.Prefs.get("clusterURL") + SYNC_API_VERSION +
    "/" + ID.get("WeaveID").username + "/storage/",

  get engineURL() this.storageURL + this.name,

  get cryptoKeysURL() this.storageURL + "crypto/keys",

  get metaURL() this.storageURL + "meta/global",

  get syncID() {
    // Generate a random syncID if we don't have one
    let syncID = Svc.Prefs.get(this.name + ".syncID", "");
    return syncID == "" ? this.syncID = Utils.makeGUID() : syncID;
  },
  set syncID(value) {
    Svc.Prefs.set(this.name + ".syncID", value);
  },

  /*
   * lastSync is a timestamp in server time.
   */
  get lastSync() {
    return parseFloat(Svc.Prefs.get(this.name + ".lastSync", "0"));
  },
  set lastSync(value) {
    // Reset the pref in-case it's a number instead of a string
    Svc.Prefs.reset(this.name + ".lastSync");
    // Store the value as a string to keep floating point precision
    Svc.Prefs.set(this.name + ".lastSync", value.toString());
  },
  resetLastSync: function SyncEngine_resetLastSync() {
    this._log.debug("Resetting " + this.name + " last sync time");
    Svc.Prefs.reset(this.name + ".lastSync");
    Svc.Prefs.set(this.name + ".lastSync", "0");
    this.lastSyncLocal = 0;
  },

  get toFetch() this._toFetch,
  set toFetch(val) {
    this._toFetch = val;
    Utils.delay(function () {
      Utils.jsonSave("toFetch/" + this.name, this, val);
    }, 0, this, "_toFetchDelay");
  },

  loadToFetch: function loadToFetch() {
    // Initialize to empty if there's no file
    this._toFetch = [];
    Utils.jsonLoad("toFetch/" + this.name, this, function(toFetch) {
      if (toFetch) {
        this._toFetch = toFetch;
      }
    });
  },

  /*
   * lastSyncLocal is a timestamp in local time.
   */
  get lastSyncLocal() {
    return parseInt(Svc.Prefs.get(this.name + ".lastSyncLocal", "0"), 10);
  },
  set lastSyncLocal(value) {
    // Store as a string because pref can only store C longs as numbers.
    Svc.Prefs.set(this.name + ".lastSyncLocal", value.toString());
  },

  /*
   * Returns a mapping of IDs -> changed timestamp. Engine implementations
   * can override this method to bypass the tracker for certain or all
   * changed items.
   */
  getChangedIDs: function getChangedIDs() {
    return this._tracker.changedIDs;
  },

  // Create a new record using the store and add in crypto fields
  _createRecord: function SyncEngine__createRecord(id) {
    let record = this._store.createRecord(id, this.name);
    record.id = id;
    record.collection = this.name;
    return record;
  },

  // Any setup that needs to happen at the beginning of each sync.
  _syncStartupCb: function _syncStartupCb(callback) {
    try {
      this._syncStartupUnsafe(callback);
    } catch (ex) {
      callback(ex);
    }
  },

  // This is wrapped in a try block by _syncStartupCb.
  _syncStartupUnsafe: function _syncStartupUnsafe(callback) {
    // Determine if we need to wipe on outdated versions
    let metaGlobal = Records.get(this.metaURL);
    let engines = metaGlobal.payload.engines || {};
    let engineData = engines[this.name] || {};

    let needsWipe = false;
    let bouncer = function(f) f();

    // Assume missing versions are 0 and wipe the server
    if ((engineData.version || 0) < this.version) {
      this._log.debug("Old engine data: " + [engineData.version, this.version]);

      // Prepare to clear the server and upload everything
      needsWipe = true;
      this.syncID = "";

      // Set the newer version and newly generated syncID
      engineData.version = this.version;
      engineData.syncID = this.syncID;

      // Put the new data back into meta/global and mark for upload
      engines[this.name] = engineData;
      metaGlobal.payload.engines = engines;
      metaGlobal.changed = true;
    }
    // Don't sync this engine if the server has newer data
    else if (engineData.version > this.version) {
      let error = new String("New data: " + [engineData.version, this.version]);
      error.failureCode = VERSION_OUT_OF_DATE;
      throw error;
    }
    // Changes to syncID mean we'll need to upload everything
    else if (engineData.syncID != this.syncID) {
      this._log.debug("Engine syncIDs: " + [engineData.syncID, this.syncID]);
      this.syncID = engineData.syncID;
      bouncer = this._resetClientCb;
    }

    bouncer.call(this, function (error) {
      if (error) {
        throw error;         // Will get caught by our wrapper.
      }

      // Delete any existing data and reupload on bad version or missing meta.
      // No crypto component here...? We could regenerate per-collection keys...
      if (needsWipe) {
        this.wipeServer(true);
      }

      // Save objects that need to be uploaded in this._modified. We also save
      // the timestamp of this fetch in this.lastSyncLocal. As we successfully
      // upload objects we remove them from this._modified. If an error occurs
      // or any objects fail to upload, they will remain in this._modified. At
      // the end of a sync, or after an error, we add all objects remaining in
      // this._modified to the tracker.
      this.lastSyncLocal = Date.now();
      if (this.lastSync) {
        this._modified = this.getChangedIDs();
      } else {
        // Mark all items to be uploaded, but treat them as changed from long ago
        this._log.debug("First sync, uploading all items");
        this._modified = {};
        for (let id in this._store.getAllIDs())
          this._modified[id] = 0;
      }
      // Clear the tracker now. If the sync fails we'll add the ones we failed
      // to upload back.
      this._tracker.clearChangedIDs();

      // Array of just the IDs from this._modified. This is what we iterate over
      // so we can modify this._modified during the iteration.
      this._modifiedIDs = [id for (id in this._modified)];
      this._log.info(this._modifiedIDs.length +
                     " outgoing items pre-reconciliation");

      // Keep track of what to delete at the end of sync
      this._delete = {};
      callback();
    }.bind(this));
  },

  /*
   * Fetch a list of URLs from the (presumably collection) URL.
   */
  _guidFetcher: function _guidFetcher(url, newer, limit, sort) {
    let args = [];
    if (newer)
      args.push("newer=" + newer);
    if (limit)
      args.push("limit=" + limit);
    if (sort)
      args.push("sort=" + sort);

    let uri = Utils.makeURL(url);
    if (args.length)
      uri.query = args.join("&");

    return new AsyncResource(uri);
  },

  _processIncoming: function _processIncoming() {
    Async.callSpinningly(this, this._processIncomingCb);
  },

  // Process incoming records.
  _processIncomingCb: function _processIncomingCb(callback) {
    this._log.trace("Downloading & applying server changes.");
    try {
      this._processIncomingUnsafe(callback);
    } catch (ex) {
      callback(ex);
    }
  },

  // Returns true if the record was successfully handled.
  _handleRecord: function _handleRecord(item, onFailure) {
    try {
      try {
        item.decrypt();
      } catch (ex if Utils.isHMACMismatch(ex)) {
        let strategy = this.handleHMACMismatch(item, true);
        if (strategy == SyncEngine.kRecoveryStrategy.retry) {
          // You only get one retry.
          try {
            // Try decrypting again, typically because we've got new keys.
            this._log.info("Trying decrypt again...");
            item.decrypt();
            strategy = null;
          } catch (ex if Utils.isHMACMismatch(ex)) {
            strategy = this.handleHMACMismatch(item, false);
          }
        }

        switch (strategy) {
          case null:
            // Retry succeeded! No further handling.
            break;
          case SyncEngine.kRecoveryStrategy.retry:
            this._log.debug("Ignoring second retry suggestion.");
            // Fall through to error case.
          case SyncEngine.kRecoveryStrategy.error:
            this._log.warn("Error decrypting record: " + Utils.exceptionStr(ex));
            onFailure(item);
            return false;
          case SyncEngine.kRecoveryStrategy.ignore:
            this._log.debug("Ignoring record " + item.id +
                            " with bad HMAC: already handled.");
            return false;
        }
      }
    } catch (ex) {
      this._log.warn("Error decrypting record: " + Utils.exceptionStr(ex));
      onFailure(item);
      return false;
    }
    return true;
  },

  _processIncomingUnsafe: function _newProcessIncomingUnsafe(callback) {
    this._log.trace("In _processIncomingUnsafe.");

    // Steps:
    // 1. Fetch new items from the server, up to our limit.
    // 2. If we hit the limit, fetch GUIDs and batch the rest, according to our
    //    client type.
    // 3. If we had any prior failed items, try to fetch those, too.
    // 4. Persist both old and new failures, ping observers, and invoke the callback.
    //
    // Complications:
    // * Batches, when executed asynchronously, can complete out of order. Indeed,
    //   they can even be processed line-by-line out of order. That means we can't
    //   naïvely track last modified times; we must either store the IDs that
    //   contributed to failed batches in toFetch, or take the greatest
    //   modified time of the last successful batch as our last successful sync
    //   time.
    // * If we need to abort due to a mid-sync error, we need to stop HTTP
    //   requests mid-flight: they're running in parallel, not sequentially. We
    //   handle that for now with an `aborted` flag, which we set if the final
    //   callback is invoked with an error. This doesn't stop the HTTP
    //   requests, but it does stop us doing line-by-line processing.

    // Figure out how many total items to fetch this sync; do less on mobile.
    let batchSize = Infinity;
    let isMobile = (Svc.Prefs.get("client.type") == "mobile");

    if (isMobile) {
      batchSize = MOBILE_BATCH_SIZE;
    }

    let fetchBatch = this.toFetch;    // Persisted records that we want to retry.
    let aborting   = false;           // If true, don't process any more records.
    let collName   = this.name;       // Collection for each item.

    // Not binding recordHandler to 'this' for performance reasons. It gets
    // called for every incoming record. Similarly for doApplyBatch and
    // doPersistFailed.
    let self = this;

    // `collection` is the AsyncCollection (i.e., AsyncResource) object that's
    // in control of the fetch.
    //
    // On the collection object we store:
    // * handled:           record IDs that we processed.
    // * applyBatch:        records that we'll apply at the end of the batch.
    // * lastModified:      the largest timestamp we've seen.
    // * failed:            IDs that did not process or reconcile.
    // * counts:            a map of applied/failed/reconciled.
    //
    // recordHandler (called in onRecord on AsyncResource) updates these as it
    // processes each downloaded record.
    function recordHandler(item, collection) {
      // So that HTTP requests don't continue to do work if we've had a failure.
      if (aborting)
        return;

      // Grab a later last modified if possible. Track it per-fetch, because
      // resource fetches will complete out of order.
      if (!collection.lastModified ||
          item.modified > collection.lastModified)
        collection.lastModified = item.modified;

      // Track the collection for the WBO.
      item.collection = collName;

      // Remember which records were processed so we can skip retries.
      collection.handled.push(item.id);

      function trackFailed(item) {
        collection.failed.push(item.id);
        collection.counts.failed++;
      }

      if (!self._handleRecord(item, trackFailed)) {
        self._log.warn("Failed to handle incoming record " + item.id);
        return;
      };

      let shouldApply;
      try {
        shouldApply = self._reconcile(item);
      } catch (ex) {
        self._log.warn("Failed to reconcile incoming record " + item.id);
        self._log.warn("Encountered exception: " + Utils.exceptionStr(ex));
        trackFailed(item);
        return;
      }

      if (shouldApply) {
        collection.counts.applied++;
        collection.applyBatch.push(item);
      } else {
        collection.counts.reconciled++;
        self._log.trace("Skipping reconciled incoming item " + item.id);
      }

      if (collection.applyBatch.length == self.applyIncomingBatchSize) {
        doApplyBatch(collection);
      }
    }

    // Apply the items that a collection has accrued, updating metadata.
    function doApplyBatch(collection) {
      self._tracker.ignoreAll = true;
      let failures = self._store.applyIncomingBatch(collection.applyBatch);
      if (failures) {
        collection.failed = collection.failed.concat(failures);
        collection.counts.failed += failures.length;
      }
      self._tracker.ignoreAll = false;
      collection.applyBatch = [];
    }

    // Persist any items that have failed into toFetch.
    // Note that we don't alter counts.
    function doPersistFailed(collection) {
      self._log.debug("Persisting " + collection.counts.failed + " potential new failures.");
      self.toFetch = Utils.arrayUnion(self.toFetch, collection.failed);
      collection.failed = [];
    }

    // Return a Collection object that's set up to track downloaded items.
    // TODO: would be nice to bust this out into its own class.
    let engineURL = this.engineURL;
    let recordObj = this._recordObj;
    function preparedCollection() {
      let r = new AsyncCollection(engineURL, recordObj);
      r.applyBatch = [];              // Latest chunk to apply.
      r.handled    = [];              // Every record we've seen.
      r.failed     = [];              // Records that didn't apply.
      r.counts     = {applied: 0, reconciled: 0, failed: 0};
      r.lastModified  = 0
      r.recordHandler = recordHandler;
      return r;
    }

    // This function fetches an array of GUIDs that we haven't handled yet.
    // `callback` should be a function of (error, guids).
    //
    // Optionally provide an array of IDs that have already been handled, and
    // those that should also be fetched (e.g., past failures to retry).
    //
    // If shouldFetchGUIDs is false, it means that the caller knows there are no
    // more items on the server. In that case, only `more` are passed on, and
    // this function behaves like a trampoline.
    //
    // Pass 'since' to use as a historical value of this.lastSync: make sure we
    // get an overlapping batch. We'll remove values in `handled`, so they
    // won't be re-processed.
    function retrieveRemainingGUIDs(callback, handled, more, since, shouldFetchGUIDs) {
      if (this.downloadLimit != null && this.downloadLimit <= 0) {
        shouldFetchGUIDs = false;
      }

      if (!shouldFetchGUIDs) {
        this._log.debug("Not fetching more GUIDs. downloadLimit: " +
                        this.downloadLimit);
        let remaining = Utils.arraySub(more, handled);
        callback(null, remaining);
        return;
      }

      // There's no need to reduce the limit to account for existing items;
      // they're subsequently removed from the returned list.
      this._log.debug("Fetching more GUIDs.");
      let fetcher = this._guidFetcher(
        this.engineURL,
        since,                 // Newer than this...
        this.downloadLimit,    // No more than this...
        "index");              // Highest weight first.

      fetcher.get(function (error, guids) {
        if (error) {
          callback(error);
          return;
        }
        if (!guids.success) {
          this._log.trace("Non-success; calling with error = guids.");
          callback(guids);
          return;
        }

        // Figure out which GUIDs weren't just fetched. Remove any that
        // were already waiting. Append new ones. Hand over.
        let desired   = Utils.arrayUnion(guids.obj, more);
        let remaining = Utils.arraySub(desired, handled);
        this._log.trace("Remaining GUIDs: " + remaining);
        callback(null, remaining);
      }.bind(this));
    }

    // Called each time an asynchronous batch collection fetch completes.
    function handleBatchResult(error, response, resource) {
      this._log.trace("Handling batch result... " + error + ", " + response);

      // This function is wrapped by the async utils; returning will cause an
      // error to propagate to the final callback.
      if (error) {
        return error;
      }

      if (response.success) {
        // Apply any un-applied items, just as we do within the record handler.
        if (resource.applyBatch.length) {
          doApplyBatch(resource);
        }
        resource.batchHandled = true;
        return null;
      }

      response.failureCode = ENGINE_DOWNLOAD_FAIL;
      return response;
    }

    // Notify observers if records failed to apply. Pass the count object
    // along so that they can make an informed decision on what to do.
    // Finally, invoke the callback.
    function finishUp(error, counts) {
      try {
        if (counts.failed) {
          this._log.debug("count.failed is " + counts.failed +
                          "; notifying observers for " + this.name);
          Observers.notify("weave:engine:sync:apply-failed", counts, self.name);
        }
        this._log.info("Records: " +
                       counts.applied    + " applied, " +
                       counts.failed     + " failed to apply, " +
                       counts.reconciled + " reconciled.");
      } finally {
        callback(error);
      }
    }

    function updateTimes(coll) {
      m = coll.lastModified;
      if (!this.lastModified || this.lastModified < m) {
        this.lastModified = m;
      }
      if (this.lastSync == null || this.lastSync < m) {
        this.lastSync = m;
      }
    }

    function allBatchesDone(collections, counts, error) {
      this._log.trace("All batches done.");

      // Persist failures, then hand off to callbacks.
      if (error) {
        aborting = true;
      }

      let allFailed = [];

      // Persist failures and compute aggregate counts.
      let applied    = 0;
      let failed     = 0;
      let reconciled = 0;

      for each (let collection in collections) {
        let counts  = collection.counts;
        failed     += counts.failed;
        applied    += counts.applied;
        reconciled += counts.reconciled;
        allFailed   = allFailed.concat(collection.failed);
      }
      this.toFetch = Utils.arrayUnion(this.toFetch, allFailed);

      // Update last sync time. Do this by sorting the collections according to their
      // own last sync, discarding those that have none, and taking the latest one
      // prior to any HTTP failure. (We don't care about minor failures -- we already
      // persisted those.)
      // By discarding batches that aren't marked as complete, we ensure that we're
      // only looking at those that finished prior to any HTTP error that brought us
      // here.
      let completed = collections.filter(function (c) c.batchHandled);
      let sorted    = completed.sort(function (a, b) {
        return (b.lastModified || 0) - (a.lastModified || 0);
      });

      let newest = sorted[0];

      if (newest) {
        updateTimes.call(this, newest);
      } else {
        this._log.trace("No newest batch! Not updating times.");
      }

      // Compute aggregate counts and notify observers.
      counts.applied    += applied;
      counts.failed     += failed;
      counts.reconciled += reconciled;

      finishUp.call(this, error, counts);
    }

    // This function is in charge of the follow-up behavior of
    // _processIncoming, once the initial batch has been fetched.
    function retrieveBatchedItems(counts, error, guids) {
      if (error) {
        this._log.warn("Error fetching remaining GUIDs.");
        callback(error);
        return;
      }

      if (!guids.length) {
        finishUp.call(this, null, counts);
        return;
      }

      // Process any backlog of GUIDs.
      // At this point we impose an upper limit on the number of items to fetch
      // in a single request, even for desktop, to avoid hitting URI limits.
      batchSize = isMobile ? this.mobileGUIDFetchBatchSize :
                             this.guidFetchBatchSize;

      let batches = Utils.slices(guids, batchSize);
      let collections = [];
      for each (let batch in batches) {
        if (!batch.length) {
          continue;
        }

        // Make a new AsyncResource and do this work.
        // Each of these requests runs in parallel.
        let r = preparedCollection();
        r.full  = true;
        r.limit = 0;
        r.newer = 0;
        r.ids   = batch;
        collections.push(r);
      }

      // Now, when the callback fires, each of these collection objects will
      // be carrying a bunch of useful metadata.

      let processBatch = Async.countedCallback(
        handleBatchResult.bind(this),
        collections.length,
        allBatchesDone.bind(this, collections, counts));

      this._log.debug("Batching fetch into " + collections.length + " requests.");
      collections.forEach(function (r) {
        r.get(processBatch);
      });
    }

    // Only bother getting data from the server if there are new items, or
    // if we want to retry some failed items.
    let existingFailures = this.toFetch;
    if (!this.lastModified ||
        this.lastModified > this.lastSync ||
        existingFailures.length) {

      // Track this so we get a broader range of GUIDs, which should avoid
      // issues with batch content ordering.
      let oldLastSync = this.lastSync;

      // Step 1: fetch new items.
      let newitems = preparedCollection();
      newitems.full  = true;
      newitems.limit = batchSize;
      newitems.newer = this.lastSync;
      newitems.get(function (error, resp) {

        if (error) {
          callback(error);
          return;
        }

        // Apply whatever we got.
        if (newitems.applyBatch.length) {
          doApplyBatch(newitems);
        }

        // Persist new failures, but hang on to the old ones -- we don't want to
        // immediately retry the ones that just failed!
        doPersistFailed(newitems);

        if (!resp.success) {
          resp.failureCode = ENGINE_DOWNLOAD_FAIL;
          callback(resp);
          return;
        }

        // Update lastSync for this batch.
        updateTimes.call(this, newitems);

        let limitHit = newitems.limit <= newitems.handled.length;

        // Step 2: more to get? Let's do it!
        let cb = retrieveBatchedItems.bind(this, newitems.counts);
        let remainder = this.toFetch;
        retrieveRemainingGUIDs.call(
            this,
            cb,
            newitems.handled,                 // Items already handled.
            remainder,                        // Additional items to fetch.
            oldLastSync,                      // When to pull GUIDs from.
            limitHit);                        // Whether to fetch more items.
      }.bind(this));

    } else {
      this._log.info("Nothing to do for incoming records.");
      callback();
    }
  },

  /**
   * Find a GUID of an item that is a duplicate of the incoming item but happens
   * to have a different GUID
   *
   * @return GUID of the similar item; falsy otherwise
   */
  _findDupe: function _findDupe(item) {
    // By default, assume there's no dupe items for the engine
  },

  _isEqual: function SyncEngine__isEqual(item) {
    let local = this._createRecord(item.id);
    if (this._log.level <= Log4Moz.Level.Trace)
      this._log.trace("Local record: " + local);
    if (Utils.deepEquals(item.cleartext, local.cleartext)) {
      this._log.trace("Local record is the same");
      return true;
    } else {
      this._log.trace("Local record is different");
      return false;
    }
  },

  _deleteId: function _deleteId(id) {
    this._tracker.removeChangedID(id);

    // Remember this id to delete at the end of sync
    if (this._delete.ids == null)
      this._delete.ids = [id];
    else
      this._delete.ids.push(id);
  },

  _handleDupe: function _handleDupe(item, dupeId) {
    // Prefer shorter guids; for ties, just do an ASCII compare
    let preferLocal = dupeId.length < item.id.length ||
      (dupeId.length == item.id.length && dupeId < item.id);

    if (preferLocal) {
      this._log.trace("Preferring local id: " + [dupeId, item.id]);
      this._deleteId(item.id);
      item.id = dupeId;
      this._tracker.addChangedID(dupeId, 0);
    }
    else {
      this._log.trace("Switching local id to incoming: " + [item.id, dupeId]);
      this._store.changeItemID(dupeId, item.id);
      this._deleteId(dupeId);
    }
  },

  // Reconcile incoming and existing records.  Return true if server
  // data should be applied.
  _reconcile: function SyncEngine__reconcile(item) {
    if (this._log.level <= Log4Moz.Level.Trace)
      this._log.trace("Incoming: " + item);

    this._log.trace("Reconcile step 1: Check for conflicts. item.id is " + item.id);
    if (this._modified && item.id in this._modified) {
      // If the incoming and local changes are the same, skip
      if (this._isEqual(item)) {
        delete this._modified[item.id];
        return false;
      }

      // Records differ so figure out which to take
      let recordAge = AsyncResource.serverTime - item.modified;
      let localAge = Date.now() / 1000 - this._modified[item.id];
      this._log.trace("Record age vs local age: " + [recordAge, localAge]);

      // Apply the record if the record is newer (server wins)
      return recordAge < localAge;
    }

    this._log.trace("Reconcile step 2: Check for updates");
    if (this._store.itemExists(item.id))
      return !this._isEqual(item);

    this._log.trace("Reconcile step 2.5: Don't dupe deletes");
    if (item.deleted)
      return true;

    this._log.trace("Reconcile step 3: Find dupes");
    let dupeId = this._findDupe(item);
    if (dupeId)
      this._handleDupe(item, dupeId);

    // Apply the incoming item (now that the dupe is the right id)
    return true;
  },

  // Upload outgoing records
  _uploadOutgoing: function SyncEngine__uploadOutgoing() {
    this._log.trace("Uploading local changes to server.");
    if (this._modifiedIDs.length) {
      this._log.trace("Preparing " + this._modifiedIDs.length +
                      " outgoing records");

      // collection we'll upload
      let up = new Collection(this.engineURL);
      let count = 0;

      // Upload what we've got so far in the collection
      let doUpload = Utils.bind2(this, function(desc) {
        this._log.info("Uploading " + desc + " of " +
                       this._modifiedIDs.length + " records");
        let resp = up.post();
        if (!resp.success) {
          this._log.debug("Uploading records failed: " + resp);
          resp.failureCode = ENGINE_UPLOAD_FAIL;
          throw resp;
        }

        // Update server timestamp from the upload.
        let modified = resp.headers["x-weave-timestamp"];
        if (modified > this.lastSync)
          this.lastSync = modified;

        let failed_ids = [id for (id in resp.obj.failed)];
        if (failed_ids.length)
          this._log.debug("Records that will be uploaded again because "
                          + "the server couldn't store them: "
                          + failed_ids.join(", "));

        // Clear successfully uploaded objects.
        for each (let id in resp.obj.success) {
          delete this._modified[id];
        }

        up.clearRecords();
      });

      for each (let id in this._modifiedIDs) {
        try {
          let out = this._createRecord(id);
          if (this._log.level <= Log4Moz.Level.Trace)
            this._log.trace("Outgoing: " + out);

          out.encrypt();
          up.pushData(out);
        }
        catch(ex) {
          this._log.warn("Error creating record: " + Utils.exceptionStr(ex));
        }

        // Partial upload
        if ((++count % MAX_UPLOAD_RECORDS) == 0)
          doUpload((count - MAX_UPLOAD_RECORDS) + " - " + count + " out");

        this._store._sleep(0);
      }

      // Final upload
      if (count % MAX_UPLOAD_RECORDS > 0)
        doUpload(count >= MAX_UPLOAD_RECORDS ? "last batch" : "all");
    }
  },

  // Any cleanup necessary.
  // Save the current snapshot so as to calculate changes at next sync
  _syncFinish: function SyncEngine__syncFinish() {
    this._log.trace("Finishing up sync");
    this._tracker.resetScore();

    let doDelete = Utils.bind2(this, function(key, val) {
      let coll = new Collection(this.engineURL, this._recordObj);
      coll[key] = val;
      coll.delete();
    });

    for (let [key, val] in Iterator(this._delete)) {
      // Remove the key for future uses
      delete this._delete[key];

      // Send a simple delete for the property
      if (key != "ids" || val.length <= 100)
        doDelete(key, val);
      else {
        // For many ids, split into chunks of at most 100
        while (val.length > 0) {
          doDelete(key, val.slice(0, 100));
          val = val.slice(100);
        }
      }
    }
  },

  _syncCleanup: function _syncCleanup() {
    if (!this._modified)
      return;

    // Mark failed WBOs as changed again so they are reuploaded next time.
    for (let [id, when] in Iterator(this._modified)) {
      this._tracker.addChangedID(id, when);
    }
    delete this._modified;
    delete this._modifiedIDs;
  },

  _sync: function SyncEngine__sync() {
    try {
      this._syncStartupCb(function (err) {
        if (err) {
          throw err;
        }
        Observers.notify("weave:engine:sync:status", "process-incoming");
        this._processIncoming();
        Observers.notify("weave:engine:sync:status", "upload-outgoing");
        this._uploadOutgoing();
        this._syncFinish();
      }.bind(this));
    } finally {
      this._syncCleanup();
    }
  },

  canDecrypt: function canDecrypt() {
    // Report failure even if there's nothing to decrypt
    let canDecrypt = false;

    // Fetch the most recently uploaded record and try to decrypt it
    let test = new Collection(this.engineURL, this._recordObj);
    test.limit = 1;
    test.sort = "newest";
    test.full = true;
    test.recordHandler = function(record) {
      record.decrypt();
      canDecrypt = true;
    };

    // Any failure fetching/decrypting will just result in false
    try {
      this._log.trace("Trying to decrypt a record from the server..");
      test.get();
    }
    catch(ex) {
      this._log.debug("Failed test decrypt: " + Utils.exceptionStr(ex));
    }

    return canDecrypt;
  },

  _resetClientCb: function _resetClientCb(callback) {
    try {
      this.resetLastSync();
      this.toFetch = [];
      callback();
    } catch (ex) {
      callback(ex);
    }
  },

  wipeServerCb: function wipeServerCb(callback) {
    let cb = function(err) {
      if (!err)
        this._resetClientCb(callback);
      else
        callback(err);
    }.bind(this);
    new AsyncResource(this.engineURL).delete(cb);
  },

  _resetClient: function SyncEngine__resetClient() {
    Async.callSpinningly(this, this._resetClientCb);
  },

  wipeServer: function wipeServer() {
    return Async.callSpinningly(this, this.wipeServerCb);
  },

  removeClientData: function removeClientData(callback) {
    // Implement this method in engines that store client specific data
    // on the server.
    callback();
  },

  /*
   * Decide on (and partially effect) an error-handling strategy.
   *
   * Asks the Service to respond to an HMAC error, which might result in keys
   * being downloaded. That call returns true if an action which might allow a
   * retry to occur.
   *
   * If `mayRetry` is truthy, and the Service suggests a retry,
   * handleHMACMismatch returns kRecoveryStrategy.retry. Otherwise, it returns
   * kRecoveryStrategy.error.
   *
   * Subclasses of SyncEngine can override this method to allow for different
   * behavior -- e.g., to delete and ignore erroneous entries.
   *
   * All return values will be part of the kRecoveryStrategy enumeration.
   */
  handleHMACMismatch: function handleHMACMismatch(item, mayRetry) {
    // By default we either try again, or bail out noisily.
    return (Weave.Service.handleHMACEvent() && mayRetry) ?
           SyncEngine.kRecoveryStrategy.retry :
           SyncEngine.kRecoveryStrategy.error;
  }
};
