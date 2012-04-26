/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

const {classes: Cc, interfaces: Ci, utils: Cu, results: Cr} = Components;

Cu.import("resource://services-common/log4moz.js");
Cu.import("resource://services-common/rest.js");
Cu.import("resource://services-sync/util.js");

const EXPORTED_SYMBOLS = [
  "Repository",
  "RepositorySession",
  "TrackingSession",
  "Server11Repository",
  "Crypto5Middleware"
];

const DONE = { toString: function() { return "<DONE>"; } };

/**
 * Base repository.
 */
function Repository() {}
Repository.prototype = {

  /**
   * Values to pass to and from callbacks.
   */
  DONE: DONE,

  /**
   * Create a new session object.
   *
   * @param storeCallback
   *        Callback with the signature (error). It may be called multiple
   *        times with error objects. It will be always called with the DONE
   *        value when the store operation has been completed.
   *        storeCallback should call session.abort() to signal that the fetch
   *        should be aborted.
   *        @param error
   *               One of two values: DONE, or an error object.
   *               `error.guids` is an array of GUIDs of records that couldn't
   *               be stored.
   *               `error.info` describes the error, e.g. an exception.
   *
   * @param sessionCallback
   *        Callback with the signature (error, session). Invoked once a
   *        session object has been instantiated.
   *        Session will be an object which implements the RepositorySession
   *        interface.
   *
   * @return nothing: see `sessionCallback`.
   */
  createSession: function createSession(storeCallback, sessionCallback) {
    sessionCallback("Repository must implement 'createSession'");
  }
};

/**
 * A session for working with a Repository. It is not wise to have more than
 * one session open at a time for a single Repository.
 */
function RepositorySession(repository, storeCallback) {
  this.repository = repository;
  this.storeCallback = storeCallback;
  this._log = Log4Moz.repository.getLogger(this._logName);
  this._log.level = Log4Moz.Level[Svc.Prefs.get(this._logLevel)];
}
RepositorySession.prototype = {
  _logLevel: "log.logger.repositorysession",
  _logName: "Sync.RepositorySession",

  /**
   * Has abort() been called on this session?
   */
  aborted: false,

  /**
   * Invoked as part of store().
   */
  storeCallback: null,

  /**
   * Used for tracking changes. The timestamp can be set with an initial value,
   * and will be reported in the finish callback.
   */
  timestamp: 0,

  /**
   * Used to persist tracking data between sessions.
   *
   * The bundle is included in the finish callback.
   */
  unbundle: function unbundle(bundle) {
  },

  /**
   * Retrieve a sequence of GUIDs corresponding to records that have been
   * modified since timestamp. The callback is invoked exactly once.
   *
   * @param timestamp
   *        Number of seconds since the epoch (can be a decimal number).
   * @param guidsCallback
   *        Callback function with the signature (error, guids_array).
   *        @param error is null for a successful operation.
   */
  guidsSince: function guidsSince(timestamp, guidsCallback) {
    throw "RepositorySession must implement 'guidsSince'";
  },

  /**
   * Interface expected to be used by fetchCallback and storeCallback.
   * Invoking this method will make an effort to abort the current fetch.
   *
   * An aborted session does not cause further callbacks to be invoked.
   */
  abort: function abort() {
    this.aborted = true;
  },

  /**
   * Retrieve a sequence of records that have been modified since timestamp.
   * Invoke the callback once for each retrieved record, then finally with
   * the DONE value.
   *
   * @param timestamp
   *        Number of seconds since the epoch (can be a decimal number).
   * @param fetchCallback
   *        Callback function with the signature (error, record).
   *        fetchCallback should call session.abort() to signal that the fetch
   *        should be aborted.
   *        @param error is null for a successful operation.
   *        @param record will be the DONE value on the last invocation.
   */
  fetchSince: function fetchSince(timestamp, fetchCallback) {
    throw "RepositorySession must implement 'fetchSince'";
  },

  /**
   * Retrieve a sequence of records by GUID. guids should be an iterable.
   * Invoke the callback once for each retrieved record, then finally with
   * the DONE value.
   *
   * @param guids
   *        Array of GUIDs to retrieve.
   * @param fetchCallback
   *        Callback function with the signature (error, record).
   *        fetchCallback should call session.abort() to signal that the fetch
   *        should be aborted.
   *        @param error is null for a succcessful operation.
   *        @param record will be the DONE value on the last invocation.
   */
  fetch: function fetch(guids, fetchCallback) {
    throw "RepositorySession must implement 'fetch'";
  },

  /**
   * Store an individual record in such a way that it won't be unnecessarily
   * returned by a fetch operation.
   *
   * Implementations may choose to flush records to the data store in batches.
   * Callers must therefore call store with the DONE value after the last item.
   *
   * @param record
   *        A record to store, or the value DONE.
   */
  store: function store(record) {
    throw "RepositorySession must implement 'store'";
  },

  /**
   * Delete all items stored in the repository.
   *
   * @param wipeCallback
   *        Callback function with the signature (error).
   *        @param error is null for a successful operation.
   */
  wipe: function wipe(wipeCallback) {
    throw "RepositorySession must implement 'wipe'";
  },

  /**
   * Perform any necessary startup, such as initializing timestamps, that must
   * occur before fetching.
   *
   * begin is separate from the constructor to allow for delayed
   * initialization.
   */
  begin: function begin(callback) {
    callback();
  },

  /**
   * Perform any necessary cleanup, invoking callback when it's safe to
   * proceed.
   * The callback is invoked with the session timestamp and a 'bundle' object,
   * which can be used for persisting tracking data between sessions.
   */
  finish: function finish(callback) {
    callback({timestamp: this.timestamp});
  },
};

//TODO question:
// how do we deal with http failures, like 400 (e.g. over quota), 401, 503, etc?
// probably best to decouple them from the synchronizer and notify the service
// or engine via observer notification directly from SyncStorageRequest.
// synchronizer probably only needs to know that it failed, not why.

/**
 * Sync 1.1 server repository
 *
 * Retrieves from and stores to a collection on an HTTP server that implements
 * the Sync 1.1 API.
 *
 * @param serverURI
 *        URI of the Sync 1.1 server (string)
 * @param username
 *        Username on the server (string)
 * @param collection
 *        Name of the collection (string)
 */
function Server11Repository(serverURI, username, collection) {
  Repository.call(this);

  if (serverURI[serverURI.length - 1] != "/") {
    serverURI += "/";
  }
  this.uri = serverURI + "1.1/" + username + "/storage/" + collection;
}
Server11Repository.prototype = {

  __proto__: Repository.prototype,

  /**
   * The complete URI (string) of the repository
   */
  uri: null,

  /**
   * TODO implement + document this
   */
  downloadLimit: null,

  createSession: function createSession(storeCallback, sessionCallback) {
    let session = new Server11Session(this, storeCallback);
    sessionCallback(null, session);
  }
};

/**
 * N.B., Server11Session does not currently implement the necessary
 * transactionality to be the second pair in a sync exchange: that is, if
 * stores are performed prior to reads, the reads will include records added by
 * the store operation.
 *
 * TODO: change this?
 * TODO: update Server11Session to track timestamps for records passing through.
 */
function Server11Session(repository, storeCallback) {
  RepositorySession.call(this, repository, storeCallback);

  this.batch         = [];   // Holds items until we have enough for a batch.
  this.flushQueue    = [];   // Holds completed batches to be flushed.
}
Server11Session.prototype = {
  __proto__: RepositorySession.prototype,
  _logName: "Sync.Server11Session",

  batch:         null,
  flushQueue:    null,

  /**
   * Flushing control.
   */
  done: false,
  flushing: 0,

  /**
   * Aborting control.
   */
  request: null,

  /**
   * Upload batch size.
   */
  batchSize: 100,

  /**
   * Session API.
   */
  guidsSince: function guidsSince(timestamp, guidsCallback) {
    let request = new SyncStorageRequest(this.repository.uri + "?newer=" + timestamp);
    request.get(function (error) {
      // Network error of sorts.
      if (error) {
        guidsCallback(error);
        return;
      }

      // HTTP error (could be a mis-configured server, wrong password, etc.)
      let response = request.response;
      if (response.status != 200) {
        guidsCallback(response);
        return;
      }

      // Convert the result to JSON. Invalid JSON is sadfaces.
      let result;
      try {
        result = JSON.parse(response.body);
      } catch (ex) {
        guidsCallback(ex);
        return;
      }
      guidsCallback(null, result);
    });
  },

  /**
   * TODO: this relies on onComplete being called on our behalf...
   * is that correct?
   */
  abort: function abort() {
    let r = this.request;
    this.request = null;
    if (r) {
      this.aborted = true;
      r.abort();
    }
  },

  fetchSince: function fetchSince(timestamp, fetchCallback) {
    let uri = this.repository.uri + "?full=1&newer=" + timestamp;
    if (this.repository.downloadLimit) {
      uri += "&limit=" + this.repository.downloadLimit + "&sort=index";
    }
    this._fetchRecords(uri, fetchCallback);
  },

  fetch: function fetch(guids, fetchCallback) {
    let uri = this.repository.uri + "?full=1&ids=" + guids;
    this._fetchRecords(uri, fetchCallback);
  },

  wipe: function wipe(wipeCallback) {
    //TODO this doesn't deal HTTP errors correctly.
    let request = new SyncStorageRequest(this.repository.uri);
    request.delete(wipeCallback);
  },

  store: function store(record) {
    // Ensure that we can't be finished more than once.
    if (this.done) {
      throw "Store session already marked as DONE.";
    }

    if (record != DONE) {
      this.batch.push(record);
      if (this.rollBatch(false)) {
        this.flush();
      }
      return;
    }

    this.done = true;
    this.rollBatch(true);
    this.flush();
  },

  /**
   * Private stuff.
   */

  /**
   * Perform a fetch and call fetchCallback appropriately.
   */
  _fetchRecords: function(uri, fetchCallback) {
    let request = new SyncStorageRequest(uri);

    // Track this so we can abort.
    this.request = request;
    request.setHeader("Accept", "application/newlines");

    request.onProgress = function onProgress() {
      let response = request.response;
      if (!response.success) {
        request.abort();
        fetchCallback(response, DONE);
        return;
      }
      let newline;

      while (!this.aborted &&
             (newline = response.body.indexOf("\n")) > 0) {
        let json = response.body.slice(0, newline);
        response.body = response.body.slice(newline + 1);
        let error, record;
        try {
          record = JSON.parse(json);
        } catch(ex) {
          // Notify the caller of genuine parsing errors.
          error = ex;
        }
        fetchCallback(error, record);
      }
    };

    request.onComplete = function onComplete(error) {
      let response = request.response;
      // 'response.success' exposes nsIHttpChannel::requestSucceeded.
      if (error || response.success) {
        fetchCallback(error, DONE);
      } else {
        // We had an HTTP error, pass the HTTP response as the error.
        fetchCallback(response, DONE);
      }
    };
    request.get();
  },

  /**
   * Work through the flush queue, flushing each batch. If an existing
   * flush is in progress, return. Ensure that if `done` is true, the
   * storeCallback is invoked once all items have been flushed.
   *
   * flush is invoked once per queued batch, and at least once (for DONE).
   *
   * Because store is specified to invoke the callback on error, rather than
   * aborting, we can flush each batch either in parallel or serially.
   */
  flush: function flush() {
    // Don't have more than one flush pending at once.
    if (this.flushing) {
      this._log.trace("Already flushing: returning.");
      return;
    }

    this.flushing = true;

    /**
     * Ensure that storeCallback is called with DONE when all of our batch
     * operations have completed, there are no more batches coming, and we've
     * been signaled.
     * This is safe to call repeatedly.
     */
    function finalmente() {
      this._log.trace("finalmente: " + this.flushing + ", " + this.flushQueue.length);
      this.flushing = false;

      if (this.flushQueue.length) {
        // There are outstanding batches, but nobody working on them. We should
        // kick off a flush.
        this._log.debug("Outstanding batches: scheduling flush.");
        Utils.nextTick(this.flush, this);
        return;
      }
      if (!this.done) {
        // We're not done yet, but we have nothing left to work on. Return
        // quietly; flush will be invoked again when the next batch arrives.
        this._log.trace("Not done: awaiting more data.");
        return;
      }
      if (!this.storeCallback) {
        // Uh oh. We're done, but the callback is gone. That should only happen
        // if we raced to the finish.
        this._log.warn("No store callback in flush!");
        return;
      }

      // Invoke the callback and prevent it being called again.
      this.storeCallback(DONE);
      this.storeCallback = null;
    }
    finalmente = finalmente.bind(this);

    //TODO should factor this helper out instead of redefining it all the time.
    function batchGUIDs(batch) {
      return [record.id for each (record in batch)];
    }

    this._log.debug("Flush queue length: " + this.flushQueue.length);

    // Finish up if we have an empty batch left.
    if (!this.flushQueue.length) {
      finalmente();
      return;
    }

    let batch = this.flushQueue.pop();
    let request;
    try {
      request = new SyncStorageRequest(this.repository.uri);
    } catch (ex) {
      this.storeCallback({info: ex, guids: batchGUIDs(batch)});
      finalmente();
      return;
    }

    request.post(batch, function onPost(error) {
      // Network error of sorts.
      if (error) {
        this.storeCallback({info: error, guids: batchGUIDs(batch)});
        return finalmente();
      }

      // HTTP error (could be a mis-configured server, over quota, etc.)
      // 'result.success' exposes nsIHttpChannel::requestSucceeded.
      if (!request.response.success) {
        this.storeCallback({info: request.response, guids: batchGUIDs(batch)});
        return finalmente();
      }

      // Analyze return value for whether some objects couldn't be saved.
      let resultObj;
      try {
        resultObj = JSON.parse(request.response.body);
      } catch (ex) {
        this._log.warn("Caught JSON parse exception: " + Utils.exceptionStr(ex));
        // Server return value did not parse as JSON. We must assume it's not
        // a valid implementation.
        this.storeCallback({info: ex, guids: batchGUIDs(batch)});
        return finalmente();
      }
      let failedIDs = Object.keys(resultObj.failed);
      if (failedIDs.length) {
        this.storeCallback({info: resultObj, guids: resultObj.failedIDs});
        return finalmente();
      }

      // TODO should we also process `resultObj.success` and verify it matches
      // all items in our batch?

      return finalmente();
    }.bind(this));
  },

  /*
   * Push the current batch into the queue for flushing, and
   * set us up for more items.
   * Returns true if a new batch was pushed.
   */
  rollBatch: function rollBatch(done) {
    let batch = this.batch;
    if (batch.length &&
        (batch.length == this.batchSize ||
         done)) {
      this.batch = [];
      this.flushQueue.push(batch);
      this._log.trace("Rolled batch.");
      return true;
    }
    this._log.trace("Not rolling batch.");
    return false;
  }
};


/**
 * Wraps a server repository to implement storage version 5 crypto.
 *
 * Transforms a local record to a WBO.
 */
function Crypto5Middleware(repository, keyBundle) {
  Repository.call(this);
  this.repository = repository;
  this.keyBundle = keyBundle;
}
Crypto5Middleware.prototype = {
  __proto__: Repository.prototype,
  _logLevel: "log.logger.crypto5middleware",
  _logName: "Sync.Crypto5Middleware",

  /**
   * Repository API
   */

  createSession: function createSession(storeCallback, sessionCallback) {
    function cb(err, session) {
      if (err) {
        return sessionCallback(err);
      }
      return sessionCallback(null, new Crypto5StoreSession(this, session));
    }
    this.repository.createSession(storeCallback, cb.bind(this));
  },

  /**
   * Crypto + storage format stuff
   */

  encrypt: function encrypt(record) {
    // 'sortindex' and 'ttl' are properties on the outer WBO.
    let sortindex = record.sortindex;
    let ttl = record.ttl;
    delete record.sortindex;
    delete record.ttl;

    let iv = Svc.Crypto.generateRandomIV();
    let ciphertext = Svc.Crypto.encrypt(JSON.stringify(record),
                                        this.keyBundle.encryptionKey, iv);
    let payload = {IV:         iv,
                   ciphertext: ciphertext,
                   hmac:       this.ciphertextHMAC(ciphertext)};
    return {id:        record.id,
            sortindex: sortindex,
            ttl:       ttl,
            payload:   JSON.stringify(payload)};
  },

  //XXX TODO this doesn't handle key refetches yet
  decrypt: function decrypt(wbo) {
    let payload = JSON.parse(wbo.payload);

    // Authenticate the encrypted blob with the expected HMAC
    let computedHMAC = this.ciphertextHMAC(payload.ciphertext);
    if (computedHMAC != payload.hmac) {
      Utils.throwHMACMismatch(payload.hmac, computedHMAC);
    }

    // Handle invalid data here. Elsewhere we assume that cleartext is an object.
    let cleartext = Svc.Crypto.decrypt(payload.ciphertext,
                                       this.keyBundle.encryptionKey,
                                       payload.IV);
    let record = JSON.parse(cleartext);

    // Verify that the outer WBO's id matches the inner record's id.
    if (record.id != wbo.id) {
      throw "Record id mismatch: " + record.id + " != " + wbo.id;
    }

    // Copy outer WBO attributes to inner record.
    record.modified = wbo.modified;
    record.sortindex = wbo.sortindex;
    record.ttl = wbo.ttl;
    return record;
  },

  ciphertextHMAC: function ciphertextHMAC(ciphertext) {
    let hasher = this.keyBundle.sha256HMACHasher;
    if (!hasher) {
      throw "Cannot compute HMAC without an HMAC key.";
    }
    return Utils.bytesAsHex(Utils.digestUTF8(ciphertext, hasher));
  }

};

function Crypto5StoreSession(repository, innerSession) {
  RepositorySession.call(this, repository);
  this.session = innerSession;
}
Crypto5StoreSession.prototype = {
  __proto__: RepositorySession.prototype,
  _logName: "Sync.Crypto5Middleware",
  _logLevel: "log.logger.crypto5middleware",

  session: null,

  guidsSince: function guidsSince(timestamp, guidsCallback) {
    this.session.guidsSince(timestamp, guidsCallback);
  },

  fetchSince: function fetchSince(timestamp, fetchCallback) {
    this.session.fetchSince(timestamp, this.makeDecryptCb(fetchCallback));
  },

  fetch: function fetch(guids, fetchCallback) {
    this.session.fetch(guids, this.makeDecryptCb(fetchCallback));
  },

  store: function store(record) {
    if (record == DONE) {
      this.session.store(record);
      return;
    }

    let wbo;
    try {
      wbo = this.repository.encrypt(record);
    } catch (ex) {
      //TODO this feels weird and somewhat inefficient.
      this.storeCallback({exception: ex, guids: [record.id]});
      return;
    }
    this.session.store(wbo);
  },

  wipe: function wipe(wipeCallback) {
    this.session.wipe(wipeCallback);
  },

  begin: function begin(callback) {
    this.session.begin(callback);
  },

  finish: function finish(callback) {
    // Clean up GC hack.
    if (this.repository.session == this) {
      this.repository.session = undefined;
    }
    RepositorySession.prototype.finish.call(this, callback);
  },

  //XXX TODO this doesn't handle key refetches yet
  // Idea: consumers should deal with this. If this passes an HMAC error back
  // to them, and this was the first time they've encountered one, they can
  // abort and then restart the fetch.
  makeDecryptCb: function makeDecryptCb(fetchCallback) {
    return (function decryptCallback(error, record) {
      if (!error && record != DONE) {
        try {
          record = this.repository.decrypt(record);
        } catch (ex) {
          record = null;
          error = ex;
        }
      }
      return fetchCallback(error, record);
    }).bind(this);
  }
};

/**
 * A partial repository session that provides tracking services to its
 * subclasses. TrackingSession is not a complete session class; you cannot use
 * it in isolation.
 *
 * TrackingSession implements `unbundle` and `finish` to persist a set of
 * stored IDs. These are called for you by Synchronizer.
 *
 * Invoke `shouldSkip` to decide whether you should skip an item (e.g., in
 * fetchSince).
 *
 * Invoke `trackStore` once you've stored an item that should be skipped in
 * future.
 *
 * If you implement your own `finish` or `unbundle` methods, don't forget to
 * call these!
 */
function TrackingSession(repository, storeCallback) {
  RepositorySession.call(this, repository, storeCallback);

  // Track stored GUIDs so we don't reupload.
  this.stored = {};

  // Track non-uploaded items so that we can later stop tracking them!
  this.forgotten = {};

}
TrackingSession.prototype = {
  __proto__: RepositorySession.prototype,

  forgotten: null,
  stored:    null,

  /**
   * Used for cross-session persistence. A bundle is returned in the finish
   * callback.
   */
  unbundle: function unbundle(bundle) {
    if (bundle && bundle.stored) {
      this.stored = bundle.stored;
    }
  },

  /**
   * Decide whether to skip an outgoing item based on stored IDs.
   * Also maintains the 'to forget' list.
   * MAYBE:
   * If the timestamp is earlier than our own, don't filter.
   * timestamp >= this.timestamp &&
   */
  shouldSkip: function shouldSkip(guid, timestamp) {
    if (guid in this.stored) {
      // One we stored in this session. Skip it.
      // N.B.: this ignores the possibility of records with times in the
      // future that we might want to skip more than once! Is that something we
      // care about?
      this.forgotten[guid] = true;
      return true;
    }
    return false;
  },

  /**
   * Track that an item has been stored. This involves adding to the `stored`
   * map, and removing the item from `forgotten` if necessary.
   */
  trackStore: function trackStore(guid, modified) {
    this.stored[guid] = modified;

    // We need to ensure that we don't forget records if we store/fetch/store.
    // Remove from forgotten.
    if (guid in this.forgotten) {
      delete this.forgotten[guid];
    }
  },

  /**
   * Clean up. For TrackingSession, this involves removing forgotten items from
   * `stored`, and invoking the callback with a bundle containing `stored`. The
   * owner of the session should persist these between sessions.
   */
  finish: function finish(finish) {
    // Forget the items that we've already skipped.
    for (let [guid, forget] in Iterator(this.forgotten)) {
      delete this.stored[guid];
    }
    delete this.forgotten;

    let cb = function (bundle) {
      bundle.stored = this.stored;
      delete this.stored;
      finish(bundle);
    }.bind(this);

    RepositorySession.prototype.finish.call(this, cb);
  }
};
