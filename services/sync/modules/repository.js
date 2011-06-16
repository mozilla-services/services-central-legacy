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

const EXPORTED_SYMBOLS = ["Repository",
                          "ServerRepository",
                          "Crypto5Middleware"];

/**
 * Base repository
 */
function Repository() {}
Repository.prototype = {

  /**
   * Values to pass to and from callbacks.
   */
  DONE: {
    // DONE is an iterable of length 1 and contains just itself.
    // This allows us to simply pass DONE whenever an iterator is expected.
    __iterator__: function() {
      return (function() {
        yield Repository.prototype.DONE;
      })();
    }
  },
  STOP: {},

  /**
   * Retrieve a sequence of GUIDs corresponding to records that have been
   * modified since timestamp.
   */
  guidsSince: function guidsSince(timestamp, guidsCallback) {
    throw "Repository must implement 'guidsSince'";
  },

  /**
   * Retrieve a sequence of records that have been modified since timestamp.
   * Invoke the callback with one or more records each time. The last record
   * will always be the DONE object.
   */
  fetchSince: function fetchSince(timestamp, fetchCallback) {
    throw "Repository must implement 'fetchSince'";
  },

  /**
   * Retrieve a sequence of records by GUID. guids should be an iterable.
   * Invoke the callback, as with fetchSince.
   */
  fetch: function fetch(guids, fetchCallback) {
    throw "Repository must implement 'fetch'";
  },

  /**
   * Store the given sequence of records. Invoke the callback with a sequence
   * of errors, if there were any, and DONE when complete.
   */
  store: function store(recs, storeCallback) {
    throw "Repository must implement 'store'";
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

  downloadLimit: null,

  /**
   * Repository API
   */

  guidsSince: function guidsSince(timestamp, guidsCallback) {

  },

  fetchSince: function fetchSince(timestamp, fetchCallback) {
    let uri = this.uri;
    if (this.downloadLimit) {
      uri += "limit=newer&sort=index";
    }
    this._fetchRecords(uri, fetchCallback);
  },

  fetch: function fetch(guids, fetchCallback) {
    let uri = this.uri;
    if (!Array.isArray(guids)) {
      guids = [guid for (guid in guids)];
    }
    uri += "ids=" + guids;
    this._fetchRecords(uri, fetchCallback);
  },

  store: function store(recs, storeCallback) {
    if (!Array.isArray(guids)) {
      recs = [record for (record in recs)];
    }
    //TODO batching
    let resource = new AsyncResource(uri);
    resource.put(recs, function onPut(error, result) {
      //TODO process result, may contain errors
      storeCallback(error);
    });
  },

  /**
   * Private stuff
   */

  _fetchRecords: function(uri, fetchCallback) {
    let resource = new AsyncResource(uri);
    resource.setHeader("Accept", "application/newlines");

    //TODO XXX resource._data and resouce._onProgress are so retarded,
    // need a better streaming api for resource

    let readyToRead = true;
    function incomingRecordGenerator() {
      let newline;
      //TODO abort on STOP
      while ((newline = resource._data.indexOf("\n")) > 0) {
        let json = resource._data.slice(0, newline);
        resource._data = resource._data.slice(newline + 1);
        yield JSON.parse(json);
      }
      readyToRead = true;
    }

    resource._onProgress = function onProgress() {
      if (!readyToRead) {
        return;
      }
      readyToRead = false;
      let rv = fetchCallback(null, incomingRecordGenerator());
      // TODO process rv, abort on STOP
    };
    resource.get(function onGet(error, result) {
      let rv = fetchCallback(error, Repository.prototype.DONE);
      // TODO process rv, abort on STOP
    });
  }

};



/**
 * Wraps a server repository to implement storage version 5 crypto.
 *
 * Transforms a local record to a WBO.
 */
function Crypto5Middleware(repository) {
  Repository.call(this);
  this.repository = repository;
}
Crypto5Middleware = {

  __proto__: Repository.prototype,

  /**
   * Repository API
   */

  guidsSince: function guidsSince(timestamp, guidsCallback) {
    this.repository.guidsSince(timestamp, guidsCallback);
  },

  fetchSince: function fetchSince(timestamp, fetchCallback) {
    function decryptCallback(errs, recs) {
      return fetchCallback(errs, (this.decrypt(rec) for (rec in recs)));
    }
    this.repository.fetchSince(timestamp, decryptCallback.bind(this));
  },

  fetch: function fetch(guids, fetchCallback) {
    function decryptCallback(errs, recs) {
      return fetchCallback(errs, (this.decrypt(rec) for (rec in recs)));
    }
    this.repository.fetch(guids, decryptCallback.bind(this));
  },

  store: function store(recs, storeCallback) {
    this.repository.store((this.encrypt(rec) for (rec in recs)), storeCallback);
  },

  /**
   * Crypto + storage format stuff
   */

  //XXX TODO this doesn't handle errors and key refetches very well
  // idea: catch exceptions in the recs iterator and don't invoke callback
  // until we have keys.
  encrypt: function encrypt(record, keyBundle) {
    keyBundle = keyBundle || CollectionKeys.keyForCollection(this.collection);
    if (!keyBundle)
      throw new Error("Key bundle is null for " + this.uri.spec);

    let iv = Svc.Crypto.generateRandomIV();
    let ciphertext = Svc.Crypto.encrypt(JSON.stringify(record),
                                        keyBundle.encryptionKey, iv);
    let payload = {IV: iv,
                   ciphertext: ciphertext,
                   hmac: this.ciphertextHMAC(ciphertext, keyBundle)};
    return {id: record.id,
            sortindex: record.sortindex,
            payload: JSON.stringify(payload)};
  },

  decrypt: function decrypt(record, keyBundle) {
  },

  ciphertextHMAC: function ciphertextHMAC(ciphertext, keyBundle) {
    let hasher = keyBundle.sha256HMACHasher;
    if (!hasher)
      throw "Cannot compute HMAC without an HMAC key.";

    return Utils.bytesAsHex(Utils.digestUTF8(ciphertext, hasher));
  },

};
