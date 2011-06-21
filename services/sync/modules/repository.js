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
 *   Philipp von Weitershausen <philipp@weitershausen.de>
 *   Richard Newman <rnewman@mozilla.com>
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

const {classes: Cc, interfaces: Ci, utils: Cu, results: Cr} = Components;

Cu.import("resource://services-sync/resource.js");
Cu.import("resource://services-sync/util.js");

const EXPORTED_SYMBOLS = ["Repository",
                          "ServerRepository",
                          "Crypto5Middleware"];

const DONE = {};
const STOP = {};

/**
 * Base repository
 */
function Repository() {}
Repository.prototype = {

  /**
   * Values to pass to and from callbacks.
   */
  DONE: DONE,
  STOP: STOP,

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
    throw "Repository must implement 'guidsSince'";
  },

  /**
   * Retrieve a sequence of records that have been modified since timestamp.
   * Invoke the callback once for each retrieved record and finally with
   * the DONE value.
   *
   * @param timestamp
   *        Number of seconds since the epoch (can be a decimal number).
   * @param fetchCallback
   *        Callback function with the signature (error, record).
   *        @param error is null for a successful operation.
   *        @param record will be the DONE value on the last invocation.
   *        @return STOP if the fetch operation should be aborted,
   */
  fetchSince: function fetchSince(timestamp, fetchCallback) {
    throw "Repository must implement 'fetchSince'";
  },

  /**
   * Retrieve a sequence of records by GUID. guids should be an iterable.
   * Invoke the callback once for each retrieved record and finally with
   * the DONE value.
   *
   * @param guids
   *        Array of GUIDs to retrieve.
   * @param fetchCallback
   *        Callback function with the signature (error, record).
   *        @param error is null for a succcessful operation.
   *        @param record will be the DONE value on the last invocation.
   *        @return STOP if the fetch operation should be aborted.
   */
  fetch: function fetch(guids, fetchCallback) {
    throw "Repository must implement 'fetch'";
  },

  /**
   * Create and return a new store session object.
   *
   * @param storeCallback
   *        Callback with the signature (error). It may be called multiple
   *        times with error objects. It will be always called with the DONE
   *        value when the store operation has been completed.
   *        @param error is an error object (where `error.guids` is an array
   *                     of the records' GUIDs that couldn't be stored) or
   *                     the DONE value.
   *        @return STOP if the store session should be aborted.
   *
   * @return an object with the following interface:
   *
   *   store(record) -- Store an individual record. Implementations may
   *                    choose to flush records to the data store in batches.
   *                    Callers must therefore call it with the DONE value
   *                    after the last item.
   */
  newStoreSession: function newStoreSession(storeCallback) {
    throw "Repository must implement 'newStoreSession'";
  }

};


/**
 * Implement the Sync 1.1 API
 */
function ServerRepository(uri) {
  Repository.call(this);
  this.uri = uri;
}
ServerRepository.prototype = {

  __proto__: Repository.prototype,

  uri: null,
  downloadLimit: null,

  /**
   * Repository API
   */

  guidsSince: function guidsSince(timestamp, guidsCallback) {
    let resource = new AsyncResource(this.uri + "?newer=" + timestamp);
    resource.get(function (error, result) {
      if (error) {
        guidsCallback(error);
        return;
      }
      try {
        result = JSON.parse(result);
      } catch (ex) {
        //TODO
        guidsCallback(ex);
        return;
      }
      guidsCallback(null, result);
    });
  },

  fetchSince: function fetchSince(timestamp, fetchCallback) {
    let uri = this.uri + "?full=1&newer=" + timestamp;
    if (this.downloadLimit) {
      uri += "&limit=" + this.downloadLimit + "&sort=index";
    }
    this._fetchRecords(uri, fetchCallback);
  },

  fetch: function fetch(guids, fetchCallback) {
    let uri = this.uri + "?full=1&ids=" + guids;
    this._fetchRecords(uri, fetchCallback);
  },

  newStoreSession: function newStoreSession(storeCallback) {
    return new ServerStoreSession(this, storeCallback);
  },

  /**
   * Private stuff
   */

  _fetchRecords: function(uri, fetchCallback) {
    let resource = new AsyncResource(uri);
    resource.setHeader("Accept", "application/newlines");

    //TODO XXX resource._data and resouce._onProgress are so retarded,
    // ('this' is the ChannelListener, not the resource!)
    // need a better streaming api for resource

    resource._onProgress = function onProgress() {
      let newline;
      while ((newline = this._data.indexOf("\n")) > 0) {
        let json = this._data.slice(0, newline);
        this._data = this._data.slice(newline + 1);
        let rv, record;
        try {
          record = JSON.parse(json);
        } catch(ex) {
          //TODO
          rv = fetchCallback(ex);
        }
        rv = fetchCallback(null, record);
        // TODO process rv, abort on STOP
      }
    };
    resource.get(function onGet(error, result) {
      fetchCallback(error, DONE);
    });
  }

};

function ServerStoreSession(repository, storeCallback) {
  this.repository = repository;
  this.storeCallback = storeCallback;
  this.batch = [];
}
ServerStoreSession.prototype = {

  repository: null,
  storeCallback: null,
  batch: null,

  batchSize: 100,

  store: function store(record) {
    if (record == DONE) {
      if (this.batch.length) {
        this.flush(true);
      } else {
        this.storeCallback(DONE);
      }
      return;
    }
    this.batch.push(record);
    if (this.batch.length == this.batchSize) {
      this.flush();
    }
  },

  flush: function flush(last) {
    let batch = this.batch;
    this.batch = [];
    let resource = new AsyncResource(this.repository.uri);
    let storeCallback = this.storeCallback;
    resource.post(batch, function onPost(error, result) {
      if (error) {
        storeCallback(error);
      }
      //TODO process result, may contain errors about individual records
      if (last) {
        storeCallback(DONE);
      }
    });
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

  /**
   * Repository API
   */

  guidsSince: function guidsSince(timestamp, guidsCallback) {
    this.repository.guidsSince(timestamp, guidsCallback);
  },

  fetchSince: function fetchSince(timestamp, fetchCallback) {
    this.repository.fetchSince(timestamp, this.makeDecryptCb(fetchCallback));
  },

  fetch: function fetch(guids, fetchCallback) {
    this.repository.fetch(guids, this.makeDecryptCb(fetchCallback));
  },

  newStoreSession: function newStoreSession(storeCallback) {
    return new Crypto5StoreSession(this, storeCallback);
  },

  /**
   * Crypto + storage format stuff
   */

  //XXX TODO this doesn't handle key refetches yet
  makeDecryptCb: function makeDecryptCb(fetchCallback) {
    return (function decryptCallback(error, record) {
      if (!error && record != DONE) {
        try {
          record = this.decrypt(record);
        } catch (ex) {
          record = null;
          error = ex;
        }
      }
      return fetchCallback(error, record);
    }).bind(this);
  },

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

function Crypto5StoreSession(repository, storeCallback) {
  this.repository = repository;
  this.storeCallback = storeCallback;
  this.session = repository.repository.newStoreSession(storeCallback);
}
Crypto5StoreSession.prototype = {

  repository: null,
  storeCallback: null,
  session: null,

  store: function store(record) {
    if (record == DONE) {
      this.session.store(record);
      return;
    }

    let wbo;
    try {
      wbo = this.repository.encrypt(record);
    } catch(ex) {
      //TODO this feels weird.
      this.storeCallback({error: ex, guids: [record.id]});
      return;
    }
    this.session.store(wbo);
  }

};
