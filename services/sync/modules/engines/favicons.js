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
 * The Original Code is Firefox Sync.
 *
 * The Initial Developer of the Original Code is
 * the Mozilla Foundation.
 * Portions created by the Initial Developer are Copyright (C) 2011
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
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

"use strict";

const EXPORTED_SYMBOLS = ['FaviconsEngine', 'FaviconRecord'];

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cu = Components.utils;

// Statement callback constants.
const REASON_FINISHED = Ci.mozIStorageStatementCallback.REASON_FINISHED;
const REASON_CANCELED = Ci.mozIStorageStatementCallback.REASON_CANCELED;
const REASON_ERROR    = Ci.mozIStorageStatementCallback.REASON_ERROR;

Cu.import("resource://services-sync/async.js");
Cu.import("resource://services-sync/engines.js");
Cu.import("resource://services-sync/record.js");
Cu.import("resource://services-sync/util.js");
Cu.import("resource://services-sync/constants.js");

function FaviconRecord(collection, id) {
  CryptoWrapper.call(this, collection, id);
}
FaviconRecord.prototype = {
  __proto__: CryptoWrapper.prototype,
  _logName: "Sync.Record.Favicons"
};

Utils.deferGetSet(FaviconRecord, "cleartext", ["url", "expiration", "icon", "mime"]);

function FaviconsEngine() {
  SyncEngine.call(this, "Favicons");
}
FaviconsEngine.prototype = {
  __proto__:   SyncEngine.prototype,
  _recordObj:  FaviconRecord,
  _storeObj:   FaviconsStore,
  _trackerObj: FaviconsTracker,
  version:     1,

  /**
   * We don't want to upload or download anything if both bookmarks and
   * history are disabled.
   */
  get enabled() {
    let bm = Engines.get("bookmarks");
    if (bm && bm.enabled) {
      return true;
    }
    let hi = Engines.get("history");
    return (hi && hi.enabled);
  },

  /**
   * Return true if the server data should be applied.
   * If we have a local version, and it's got an expiry time further in the
   * future, keep the local one.
   * TODO: switch to using a lastModified timestamp instead.
   */
  _reconcile: function _reconcile(item) {
    let store = this._store;
    let cb = Async.makeSpinningCallback();
    store.faviconExpiry(item.id, cb);

    let localExpiration = cb.wait();
    let result = !localExpiration ||
                 (item.expiration && (localExpiration < item.expiration));
    this._log.trace("FI: _reconcile(" + JSON.stringify(item) + ") => " + result);
    return result;
  },

  /**
   * Interface for tracking changes observed by other engines.
   * Could do this through actual notifications, of course.
   */
  notifyFaviconChange: function notifyFaviconChange(faviconURL) {
    this._log.debug("Got notifyFaviconChange notification for " +
                    faviconURL);
    this._tracker.addChangedFaviconURL(faviconURL);
  }
}

function FaviconsStore(name) {
  Store.call(this, name);

  // Explicitly nullify our references to our cached services so we don't leak.
  Svc.Obs.add("places-shutdown", function() {
    for each ([query, stmt] in Iterator(this._statements)) {
      stmt.finalize();
    }
    this._statements = {};
  }, this);
}
FaviconsStore.prototype = {
  __proto__: Store.prototype,

  // Utilities.
  _getStatement: function _getStatement(query) {
    // TODO: statement reuse.
    // We use the history connection *because that's what the Favicon Service
    // uses*!
    let db = PlacesUtils.history.QueryInterface(Ci.nsPIPlacesDatabase)
                        .DBConnection;
    return db.createAsyncStatement(query);
  },

  // Shared bits for faviconExpiry and retrieveRecordByGUID callback objects.
  _singleResultCb: {
    // Provide these.
    callback:  null,
    statement: null,
    transform: function (result) {
      return result;
    },

    handleCompletion: function (reason) {
      this.invokeCallback((reason == REASON_ERROR ? reason : null));
    },

    handleError: function (err) {
      this.invokeCallback(err);
    },

    handleResult: function (resultSet) {
      // We only care about the first.
      this.invokeCallback(null, this.transform(resultSet.getNextRow()));
    },

    /**
     * Invoke the input callback if it has not yet been invoked.
     */
    invokeCallback: function invokeCallback(err, result) {
      let c = this.callback;
      if (c) {
        this.callback = null;
        c(err, result);
      }
    }
  },

  // Async layer.

  /**
   * Set the `icon` field of the provided record.
   * Invokes the provided callback with the record when complete.
   */
  _populateRecordIcon: function _populateRecordIcon(record, callback) {
    this._log.info("Invoking _populateRecordIcon for " + record.id + ".");
    if (!record) {
      return callback(new Error("record is " + record));
    }
    try {
      // TODO: async.
      // TODO: lazy?
      // data: URL includes MIME type, which saves us an attribute, and handily
      // takes care of encoding.
      record.icon = Svc.Favicons.getFaviconDataAsDataURL(Utils.makeURI(record.url));
      callback(null, record);
    } catch (ex) {
      this._log.debug("Caught exception " + Utils.exceptionStr(ex) + " in _populateRecordIcon.");
      return callback(ex);
    }
  },

  _createRecord: function _createRecord(guid, collection, callback) {
    let rec = new FaviconRecord(collection, guid);
    this._retrieveRecordByGUID(guid, function (err, attributes) {
      if (err) {
        return callback(err);
      }
      if (!attributes) {
        rec.deleted = true;
        return callback(null, rec);
      }
      rec.url        = attributes.url;
      rec.expiration = attributes.expiration;
      this._populateRecordIcon(rec, callback);
    }.bind(this));
  },

  _create: function _create(record, callback) {
    // TODO: set ID.
    this.storeFavicon(record.url,
                      record.icon,
                      record.expiration,
                      callback);
  },

  _remove: function _remove(record, callback) {
    if (!record.id) {
      callback(new Error("No GUID by which to remove..."));
    }
    this._log.trace("Removing favicon record " + record.id);

    // TODO: what happens if I remove a favicon from the DB that's still
    // referenced by places items?
    const query = "DELETE FROM moz_favicons " +
                  "WHERE url = :guid";               // TODO
    let statement = this._getStatement(query);
    statement.params.guid = record.id;
    let cb = {
      __proto__: this._singleResultCb,
      callback:  callback,
      statement: statement
    };
    statement.executeAsync(cb);
  },

  // Synchronous Store API layer.
  createRecord: function createRecord(guid, collection) {
    let cb = Async.makeSpinningCallback();
    this._createRecord(guid, collection, cb);
    return cb.wait();
  },

  create: function create(record) {
    let cb = Async.makeSpinningCallback();
    this._create(record, cb);
    return cb.wait();
  },

  update: function update(record) {
    this.create(record);
  },

  remove: function remove(record) {
    let cb = Async.makeSpinningCallback();
    this._remove(record, cb);
    return cb.wait();
  },

  itemExists: function itemExists(id) {
    const query = "SELECT id FROM moz_favicons " +
                  "WHERE url = :iconURL " +
                  "LIMIT 1";
    let statement = this._getStatement(query);
    statement.params.iconURL = id; // TODO: we use URL == id for now.
    return !!Async.querySpinningly(statement, ["id"])[0];
  },

  retrieveRecordByGUID: function retrieveRecordByGUID(guid) {
    return Async.callSpinningly(this, this._retrieveRecordByGUID.bind(this, guid));
  },

  /**
   * Retrieve metadata about the provided GUID, invoking callback with the result.
   * If nothing is known about that GUID, the result is `null`.
   */
  _retrieveRecordByGUID: function _retrieveRecordByGUID(guid, callback) {
    const query = "SELECT id, url, expiration, mime_type FROM moz_favicons " +
                  "WHERE url = :guid " +
                  "LIMIT 1";

    let statement = this._getStatement(query);
    statement.params.guid = guid;
    let cb = {
      __proto__: this._singleResultCb,
      callback:  callback,
      statement: statement,
      transform: function (result) {
        if (!result) {
          return null;
        }
        return {faviconid:  result.getResultByName("id"),
                guid:       result.getResultByName("url"),  // TODO
                url:        result.getResultByName("url"),
                mime:       result.getResultByName("mime_type"),
                expiration: result.getResultByName("expiration")};
      }
    };
    statement.executeAsync(cb);
  },


  changeItemID: function changeItemID(oldID, newID) {
    throw new Error("changeItemID is nonsensical for favicons.");
  },

  // TODO: sortindex...
  getAllIDs: function getAllIDs() {
    const query = "SELECT DISTINCT url FROM moz_favicons";
    let statement = this._getStatement(query);
    let recs = Async.querySpinningly(statement, ["url"]);

    // TODO: GUID.
    let result = {};
    for each (let rec in recs) {
      result[rec.url] = true;
    }
    return result;
  },

  wipe: function wipe() {
    const query = "DELETE FROM moz_favicons";
    let statement = this._getStatement(query);
    Async.querySpinningly(statement, []);
  },

  /**
   * Invoke the callback with the expiration time (if we have one) of the
   * favicon named by URI.
   *
   * If the expiration time is falsy, no expiration is known for the given URI.
   *
   * If the first argument to the callback is truthy, an exception was
   * encountered during fetch.
   */
  faviconExpiry: function faviconExpiry(guid, callback) {
    const query = "SELECT id, expiration FROM moz_favicons " +
                  // TODO: guid not URL.
                  "WHERE url = :iconURL " +
                  "LIMIT 1";

    let statement = this._getStatement(query);
    statement.params.iconURL = guid;
    let cb = {
      __proto__: this._singleResultCb,
      callback: callback,
      statement: statement,
      transform: function (result) {
        return result ? result.getResultByName("expiration") : null;
      }
    };
    statement.executeAsync(cb);
  },

  /**
   * Store the provided favicon data into the database.
   * At present this function is internally synchronous.
   */
  // TODO: need to specify GUID.
  storeFavicon: function storeFavicon(url, dataURL, expiration, callback) {
    try {
      // Yes, this is a synchronous call. We don't want to replicate all of the
      // work that nsFaviconService.cpp does; wait until mozIAsyncFavicons
      // supports asynchronous insertion. (TODO)
      this._log.debug("Invoking Svc.Favicons.setFaviconDataFromDataURL(" +
                      [url, dataURL, expiration] + ");");
      Svc.Favicons.setFaviconDataFromDataURL(Utils.makeURI(url), dataURL, expiration);
      callback();
    } catch (ex if ex.result === Components.results.NS_ERROR_FAILURE) {
      // Throws NS_ERROR_FAILURE if the favicon is overbloated and won't be saved
      // to the db.
      callback(ex);
    }
  }
}
function FaviconsTracker(name) {
  Tracker.call(this, name);
}
FaviconsTracker.prototype = {
  __proto__: Tracker.prototype,

  addChangedFaviconURL: function addChangedFaviconURL(faviconURL) {
    // TODO: GUID lookup.
    let guid = faviconURL;
    this.addChangedID(guid);
  }
}
