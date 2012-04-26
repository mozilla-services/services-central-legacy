/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

const {classes: Cc, interfaces: Ci, utils: Cu, results: Cr} = Components;

Cu.import("resource://services-common/log4moz.js");
Cu.import("resource://services-sync/repository.js");
Cu.import("resource://services-sync/util.js");

const EXPORTED_SYMBOLS = ["Synchronizer"];

/**
 * A SynchronizerSession exchanges data between two RepositorySessions.
 * As with other kinds of session, this is a one-shot object.
 *
 * SynchronizerSession is an implementation detail of the Synchronizer. It is
 * not a public class. Synchronizer interacts with SynchronizerSession through
 * three callbacks:
 *
 *   - onInitialized, invoked when the session has been established after calling
 *     'init';
 *   - onSynchronized, invoked when synchronization has completed;
 *   - onFetchError, invoked when a fetch failed (and accepts a return val);
 *   - onStoreError, when storing an item failed;
 *   - onSessionError, when beginning a RepositorySession failed.
 *
 * and two methods:
 *
 *   - init, which will ultimately cause onInitialized to be invoked;
 *   - synchronize, which will result in onSynchronized being called.
 *
 * SynchronizerSession grabs a session for each of our repositories. Once both
 * sessions are set up, we pair invocations of fetchSince and store callbacks,
 * switching places once the first stream is done. Then we finish each session
 * and invoke a callback.
 *
 * Example usage:
 *
 *   let session = new SynchronizerSession(synchronizer);
 *   session.onInitialized = function (err) {
 *     // Add error handling here.
 *     session.synchronize();
 *   };
 *   session.onSynchronized = function (err) {
 *     // Rock on!
 *     callback(err);
 *   };
 *   session.init();
 */
function SynchronizerSession(synchronizer) {
  this.synchronizer = synchronizer;

  let level = Svc.Prefs.get("log.logger.synchronizer");
  this._log = Log4Moz.repository.getLogger(this._logName);
  this._log.level = Log4Moz.Level[level];
}
SynchronizerSession.prototype = {
  _logName: "Sync.Synchronizer",

  sessionA:     null,
  sessionB:     null,
  synchronizer: null,

  //
  // TODO: Need to persist all of these.
  //
  bundleA:     null,
  bundleB:     null,

  /**
   * Synchronizer interface.
   * Override these methods!
   */

  onInitialized: function onInitialized(error) {
    throw "Override onInitialized.";
  },

  onSynchronized: function onSynchronized(error) {
    throw "Override onSynchronized.";
  },

  /**
   * Invoked when a fetch of a record has failed. The arguments are the same as
   * for the callback on `RepositorySession.fetchSince`.
   *
   * Override this if you want to terminate fetching, or apply
   * other recovery/etc. handling, when failure occurs.
   */
  onFetchError: function onFetchError(error, record) {
    // E.g., session.abort();
  },

  /**
   * Invoked when storage of a record has failed. This mirrors
   * `RepositorySession.storeCallback`.
   *
   * storeCallback doesn't admit any kind of control flow, so only bother
   * overriding this if you want to watch what's happening.
   */
  onStoreError: function onStoreError(error) {
  },

  /**
   * Invoked when a RepositorySession could not be established.
   */
  onSessionError: function onSessionError(error) {
  },

  /**
   * Initialize the two repository sessions, then invoke onInitialized.
   * This is a public method.
   */
  init: function init() {
    this.synchronizer
        .repositoryA.createSession(this.storeCallbackA.bind(this),
                                   this.sessionCallbackA.bind(this));
  },

  /**
   * Creating a session invokes these two callbacks. We chain them to create
   * both sessions.
   */
  sessionCallbackA: function sessionCallbackA(error, session) {
    if (error) {
      this.onInitialized(error);
      return;
    }
    this.sessionA = session;
    session.unbundle(this.bundleA);
    this.synchronizer.repositoryB.createSession(this.storeCallbackB.bind(this),
                                                this.sessionCallbackB.bind(this));
  },

  sessionCallbackB: function sessionCallbackB(error, session) {
    if (error) {
      return this.sessionA.finish(function () {
        this.onInitialized(error);
      }.bind(this));
    }
    this.sessionB = session;
    session.unbundle(this.bundleB);
    return this.onInitialized();
  },

  /**
   * Assuming that two sessions have been initialized, sync, then clean up and
   * invoke onSynchronized.
   */
  synchronize: function synchronize() {
    this._log.trace("Fetching from A into B.");
    let timestamp = this.synchronizer.bundleA.timestamp;
    this.synchronizeSessions(this.sessionA, this.sessionB, timestamp);
  },

  /**
   * Begin the `from` session, fetching records since `timestamp` into `to`.
   * We use this method in each direction in turn: once in `synchronize`, and
   * once in a callback that indicates that the first direction is done.
   */
  synchronizeSessions: function synchronizeSessions(from, to, timestamp) {
    from.begin(function (err) {
      if (err) {
        // Hook for handling. No response channel yet.
        this.onSessionError(err);
        return;
      }
      from.fetchSince(timestamp, this.fetchCallback.bind(this, to));
    }.bind(this));
  },

  /**
   * Internal callback for fetched records. `bind` is used to curry the value
   * of `session`, allowing us to use one callback for both directions.
   */
  fetchCallback: function fetchCallback(session, error, record) {
    if (error) {
      this._log.warn("Got error " + Utils.exceptionStr(error) +
                     " fetching. Invoking onFetchError for handling.");
      // Return the handler value, which allows the caller to do useful things
      // like abort.
      return this.onFetchError(error, record);
    }
    session.store(record);
    return null;
  },

  /**
   * The two storeCallbacks are instrumental in switching sync direction and
   * actually finishing the sync. This is where the magic happens: each
   * callback is invoked when storing fails or completes, and so we can flip
   * directions (for the first) and invoke the output callback (for the
   * second).
   */
  storeCallbackB: function storeCallbackB(error) {
    if (error != Repository.prototype.DONE) {
      // Hook for handling. No response channel yet.
      this.onStoreError(error);
      return;
    }
    this._log.trace("Done with records in storeCallbackB.");
    this._log.trace("Fetching from B into A.");

    // On to the next!
    let timestamp = this.synchronizer.bundleB.timestamp;
    this.synchronizeSessions(this.sessionB, this.sessionA, timestamp);
  },

  storeCallbackA: function storeCallbackA(error) {
    this._log.debug("In storeCallbackA().");
    if (error != Repository.prototype.DONE) {
      this.onStoreError(error);
      return;
    }
    this._log.trace("Done with records in storeCallbackA.");
    this.finishSync();
  },

  /**
   * Dispose of both sessions and invoke onSynchronized.
   */
  finishSync: function finishSync() {
    this.sessionA.finish(function (bundle) {
      this.bundleA = bundle;
      this.sessionB.finish(function (bundle) {
        this.bundleB = bundle;
        // Finally invoke the output callback.
        this.onSynchronized(null);
      }.bind(this));
    }.bind(this));
  },
};

/**
 * A Synchronizer exchanges data between two Repositories.
 *
 * It tracks whatever information is necessary to reify the syncing
 * relationship between these two sources/sinks: e.g., last sync time.
 *
 * The synchronizer must keep track of the set of IDs that have been stored and
 * not modified since the session last fetched new records. That is, a record
 * which has been received from another source should not be re-uploaded to
 * that source, regardless of timestamp, unless it is changed locally.
 *
 * This is to avoid endless uploads of the same record from repository to
 * repository. It seems fragile to rely on reconciliation and not modifying
 * timestamps to eliminate a loop.
 *
 * There are two situations in which this might occur:
 *
 * * In store-first-fetch-second, this could occur inside the same session.
 * * In fetch-first-store-second, this could occur in a subsequent session.
 *
 * Note that one-session memory is not enough: a fetch could easily be aborted
 * before the new item has been reached, leaving it open for re-upload later.
 *
 * This tracking is obviously specific to a synchronizer, not to the
 * repository, but it is calculated by the session itself, because the set of
 * tracked IDs for a given sequence of stores depends on the process of
 * reconciliation.
 *
 * - On store, track the ID.
 * - On fetch, skip items that have been stored.
 * - TODO: If a subsequent fetch predates our stored timestamp, do not skip records.
 * - When an item is modified locally, remove it from the tracker.
 */

function Synchronizer() {
  let level = Svc.Prefs.get(this._logLevel);
  this._log = Log4Moz.repository.getLogger(this._logName);
  this._log.level = Log4Moz.Level[level];
}
Synchronizer.prototype = {
  _logLevel: "log.logger.synchronizer",
  _logName: "Sync.Synchronizer",

  /**
   * Keep track of timestamps and other metadata.
   * TODO: These need to be persisted.
   */
  bundleA: {timestamp: 0},
  bundleB: {timestamp: 0},

  /**
   * Repositories to sync.
   *
   * The synchronizer will first sync from A to B and then from B to A.
   */
  repositoryA: null,
  repositoryB: null,

  /**
   * Do the stuff to the thing.
   */
  synchronize: function synchronize(callback) {
    this._log.trace("Entering Synchronizer.synchronize().");

    let session = new SynchronizerSession(this);
    session.onSessionError = function (error) {
      this._log.warn("Error in SynchronizerSession: " +
                     Utils.exceptionStr(error));
      return callback(error);
    };
    session.onInitialized = function (error) {
      // Invoked with session as `this`.
      if (error) {
        this._log.warn("Error initializing SynchronizerSession: " +
                       Utils.exceptionStr(error));
        return callback(error);
      }
      return session.synchronize();
    };
    session.onSynchronized = function (error) {
      // Invoked with session as `this`.
      if (error) {
        this._log.warn("Error during synchronization: " +
                       Utils.exceptionStr(error));
        return callback(error);
      }
      // Copy across the bundles from within the session.
      session.synchronizer.bundleA = session.bundleA;
      session.synchronizer.bundleB = session.bundleB;
      return callback();
    };
    session.init();
  },

  /**
   * Synchronize. This method blocks execution of the caller. It is deprecated
   * and solely kept for backward-compatibility.
   */
  sync: function sync() {
    Async.callSpinningly(this, this.synchronize);
  }
};


/**
 * Synchronize a Firefox engine to a Server11Collection.
 *
 * N.B., this class layers two accessors -- local and remote -- on top of the
 * undiscriminated pair of repositories exposed by Synchronizer.
 */
function EngineCollectionSynchronizer(name, local, remote) {
  Synchronizer.call(this);
  this.Name = name;
  this.name = name.toLowerCase();
  this.repositoryA = local;
  this.repositoryB = remote;
}
EngineCollectionSynchronizer.prototype = {
  __proto__: Synchronizer.prototype,

  /**
   * Convention.
   */
  get localRepository()  { return this.repositoryA; },
  get serverRepository() { return this.repositoryB; },

  /**
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

  /**
   * lastSyncLocal is a timestamp in local time.
   */
  get lastSyncLocal() {
    return parseInt(Svc.Prefs.get(this.name + ".lastSyncLocal", "0"), 10);
  },
  set lastSyncLocal(value) {
    // Store as a string because pref can only store C longs as numbers.
    Svc.Prefs.set(this.name + ".lastSyncLocal", value.toString());
  },
};
