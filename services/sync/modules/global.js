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

const EXPORTED_SYMBOLS = ["GlobalSession"];

let MetaGlobal = {

  _record: null,

  modified: false,
  isNew: false,

  fetch: function fetch(callback) {
    if (this._record) {
      callback(null, _record);
      return;
    }
    new SyncStorageRequest(Service.metaURL, function (error, response) {
      //TODO writeme
    });
  },

  store: function store(callback) {
    //TODO write me
  },

  clear: function clear() {
    this._record = null;
  },

  _ensureRecord: function _ensureRecord() {
    if (!this._record) {
      this._record = {};
      this.isNew = true;
    }
  },

  get syncID() {
    return this._record.syncID;
  },
  set syncID(value) {
    this._ensureRecord();
    this._record.syncID = value;
  }
  get storageVersion() {
    return this._record.storageVersion;
  },
  set storageVersion(value) {
    this._ensureRecord();
    this._record.storageVersion = value;
  }
  get engines() {
    return this._record.engines;
  },
  set engines(value) {
    this._ensureRecord();
    this._record.engines = value;
  }

  toSJON: function toJSON() {
    return {syncID:         this.syncID,
            storageVersion: this.storageVersion,
            engines:        this.engines};
  }

};


function GlobalSession() {
}
GlobalSession.prototype = {

  // Things TODO here:

  begin: function begin(callback) {
    Status.resetSync();

    // - lock
    // - figure out whether we have everything to sync
    //   - do we have all credentials?
    //   - do we have a firstSync?
    //   - are we online?
    //   - have we met backoff?
    //   - master password unlocked?
    // - do we have clusterURL?
    //   - if we don't, fetch it.
    //   - if we can't, abort sync
    // - fetch info/collections
    //   - also serves as verifying credentials, abort if unsuccesful
    //   - use ?v=<version> once a day (does we still need that for metrics?)
    // - fetch keys if 'crypto' timestamp differs from local one
    //   - if it's non-existent, goto fresh start.
    //   - decrypt keys with Sync Key, abort if HMAC verification fails.
    // - fetch meta/global if 'meta' timestamp differs from local one
    //   - if it's non-existent, goto fresh start.
    //   - check for storage version. if server data outdated, goto fresh start.
    //     if client is outdated, abort with friendly error message.
    //   - if syncID mismatch, reset local timestamps, refetch keys
    // - if fresh start:
    //   - wipe server. all of it.
    //   - create + upload meta/global
    //   - generate + upload new keys
    // - update engine last modified timestamps from info/collections record
    // - sync clients engine
    //   - clients engine always fetches all records
    // - process reset/wipe requests in 'firstSync' preference
    // - process any commands, including the 'wipeClient' command
    // - infer enabled engines from meta/global
  },

  synchronize: function synchronize(callback) {
    // - sync engines
    //   - only stop if 401 is encountered
  },

  finish: function finish(callback) {
    // - if meta/global has changed, reupload it
    // - unlock
  }

};
