/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * This file defines the various stages which constitute a sync.
 *
 * Stages are defined in the order they execute to increase readability and
 * understanding of the sync process.
 */

"use strict";

const EXPORTED_SYMBOLS = [
  "CheckPreconditionsStage",
  "CreateStorageServiceClientStage",
  "EnsureClientReadyStage",
  "EnsureSpecialRecordsStage",
  "FetchCryptoRecordsStage",
  "FetchInfoCollectionsStage",
  "FinishStage",
  "ProcessClientCommandsStage",
  "ProcessFirstSyncPrefStage",
  "ProcessInfoCollectionsStage",
  "SecurityManagerSetupStage",
  "Stage",
  "SyncClientsRepositoryStage",
  "SyncRepositoriesStage",
  "UpdateRepositoryStateStage",
];

const {classes: Cc, interfaces: Ci, utils: Cu, results: Cr} = Components;

Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://services-common/tokenserverclient.js");
Cu.import("resource://services-sync/client.js");

/**
 * Represents a specific phase in the syncing process.
 *
 * This is an abstract base type.
 *
 * Stages are instantiated and used by a GlobalSession. Stages share the same
 * constructor and the functions {begin, advance, abort, finish}.
 *
 * The role of a stage is perform some specific, well-defined task. When it is
 * time for a stage to run, begin() is called. The stage then does what it
 * knows how to do.
 *
 * When a stage is finished executing, it calls advance() on success or abort()
 * if errors were encountered. If a stage() wishes to terminal the session
 * early but with a successful status, finish() can be called. The stage MUST
 * call one of these or the session will hang.
 */
function Stage(session) {
  this.session = session;
  this.config = session.config;
  this.state = session.state;
  this.intent = session.intent;
}
Stage.prototype = {
  begin: function begin() {
    throw new Error("begin() must be implemented in stage.");
  },

  advance: function advance() {
    this.session.advance(null);
  },

  abort: function abort(error) {
    this.session.advance(error);
  },

  /**
   * Finishes a sync session.
   *
   * This can be called as an alternative to abort() and advance() if the
   * current session has no more work left to do. This typically happens if
   * there are no outgoing changes and no new server data is detected.
   */
  finish: function finish() {
    this.session.finish();
  },

  /**
   * A hook for stages to validate preconditions.
   *
   * This is called automatically before begin(). If preconditions aren't met,
   * this function should throw an Error.
   */
  validatePreconditions: function validatePreconditions() {},
};

/**
 * Stage to check basic preconditions of a sync.
 *
 * This stage ensures that Sync is configured, the browser is online, and
 * we aren't "blocked" from performing a sync.
 */
function CheckPreconditionsStage() {
  Stage.prototype.constructor.call(this, arguments);
}
CheckPreconditionsStage.prototype = {
  __proto__: Stage.prototype,

  begin: function begin() {
    if (Services.io.offline) {
      this.abort(new Error("Network is offline."));
    }

    if (Status.minimumNextSync > Date.now()) {
      this.abort(new Error("Backoff not met."));
    }

    this.advance();
  },
};

function SecurityManagerSetupStage() {
  Stage.prototype.constructor.call(this, arguments);
}
SecurityManagerSetupStage.prototype = {
  __proto__: Stage.prototype,

  begin: function begin() {
    this.state.securityManager.onSyncStart(this, this.onSyncStartFinish);
  },

  onSyncStartFinish: function onSyncStartFinish(error) {
    if (error) {
      this.abort(error);
      return;
    }

    // TODO reserved for more checking.
    this.advance();
  },
};

/**
 * Create the HTTP client used to speak with the storage service.
 *
 * Postconditions:
 *
 *   this.session.syncClient is populated with a SyncClient instance.
 *
 * The created SyncClient instance should also have a listener registered which
 * does the appropriate HTTP authentication in the onDispatch hook. This stage
 * registers itself as a listener and provides a default implementation of
 * onDispatch.
 *
 * If you wish to use custom HTTP authentication, you can simply monkeypatch
 * the onDispatch function with your own. e.g.
 *
 *   Cu.import("resource://services-sync/stages.js");
 *
 *   CreateStorageServiceClientStage.prototype.onDispatch =
 *    function customHttpAuth(client, request) {
 *      request.setHeader("authorization", "CUSTOM AUTH HEADER");
 *    };
 */
function CreateStorageServiceClientStage() {
  Stage.prototype.constructor.call(this, arguments);
}
CreateStorageServiceClientStage.prototype = {
  __proto__: Stage.prototype,

  begin: function begin() {
    this.state.client = new SyncClient(this.state.storageServerURL);
    this.state.client.addListener(this.session);

    this.config.securityManager.onCreateSyncClient(this, this.state.client,
                                                   this.advance);
  },
};

function EnsureClientReadyStage() {
  Stage.prototype.constructor.call(this, arguments);
}
EnsureClientReadyStage.prototype = {
  __proto__: Stage.prototype,

  REQUIRED_CONFIGURATION_PROPERTIES: ["rootKeyBundle", "keyRecordID"],
  REQUIRED_STATE_PROPERTIES: ["storageServerURL"],

  begin: function begin() {
    for (let k of this.REQUIRED_CONFIGURATION_PROPERTIES) {
      if (!this.config[k]) {
        this.abort(new Error("Required property on GlobalConfiguration not " +
                             "set: " + k));
        return;
      }
    }

    for (let k of this.REQUIRED_STATE_PROPERTIES) {
      if (!this.state[k]) {
        this.abort(new Error("Required property of GlobalState not set: " + k));
        return;
      }
    }

    this.advance();
  },
};

/**
 * Fetch info/collections from the server.
 *
 * Postconditions:
 *
 *    this.state.remoteCollectionsLastModified is populated with a map of the
 *    remote collection names to Date instances they were last modified.
 *
 * If a conditional request is performed and the server returns a 304, the
 * stage should populate this.state.remoteCollectionsLastModified with the
 * cached info.
 */
function FetchInfoCollectionsStage() {
  Stage.prototype.constructor.call(this, arguments);
}
FetchInfoCollectionsStage.prototype = {
  __proto__: Stage.prototype,

  begin: function begin() {
    let request = this.session.syncClient.getCollectionInfo();
    request.dispatch(this.onRequestComplete);
  },

  onRequestComplete: function onRequestComplete(error, request) {
    if (error) {
      this.abort(error);
      return;
    }

    // Conditional request resulted in no new data. The next stage will
    // finish the sync if it needs to.
    if (request.notModified) {
      this.advance();
      return;
    }

    this.state.remoteCollectionsLastModified = request.resultObj;
    this.advance();
  },
};

/**
 * Consider the state of collections and determine what to do next.
 *
 * Postconditions:
 *
 *   TODO
 */
function ProcessInfoCollectionsStage() {
  Stage.prototype.constructor.call(this, arguments);
}
ProcessInfoCollectionsStage.prototype = {
  __proto__: Stage.prototype,

  validatePreconditions: function validatePreconditions() {
    if (!this.state.remoteCollectionsLastModified) {
      throw new Error("GlobalState.remoteCollectionsLastModified not set.");
    }

    if (!this.state.localCollectionsLastModified) {
      throw new Error("GlobalState.localCollectionsLastModified not set.");
    }
  },

  begin: function begin() {
    // If the server doesn't have any new data and we have no outgoing data,
    // the session can be finished since there is nothing to do.
    let haveIncomingData = false;
    let haveOutgoingData = this.intent.outgoingRepositories.size() > 0;

    for (let [k, v] in Iterator(this.remoteCollectionsLastModified)) {
      if (!(k in this.localCollectionsLastModified)) {
        haveIncomingData = true;
        continue;
      }

      if (v > this.localCollectionsLastModified) {
        haveIncomingData = true;

        // If "meta" changed remotely, blow away locally cached values.
        if (k == "meta") {
          this.state.remoteSyncID = null;
          this.state.remoteStorageVersion = null;
          this.state.remoteRepositoryInfo = null;
        }

        continue;
      }
    }

    if (!haveIncomingData && !haveOutgoingData) {
      this._log.info("No local or remote changes. Sync not necessary.");
      this.finish();
      return;
    }

    this.advance();
  },
};

/**
 * Ensure the meta/global record is up to date.
 *
 * Postconditions:
 *
 *   - this.state.remoteSyncID is set to the value of the remote SyncID string.
 *   - this.state.remoteStorageVersion is set to the value of the remote
 *     storage version.
 *   - this.state.remoteRepositoryInfo is populated with information on engines.
 *
 * If a remote meta/global record does not exist, the values of the above
 * variables should all be set to null. A subsequent stage will interpret this
 * as a fresh server and do the right thing.
 */
function FetchMetaGlobalStage() {
  Stage.prototype.constructor.call(this, arguments);
}
FetchMetaGlobalStage.prototype = {
  __proto__: Stage.prototype,

  begin: function begin() {
    // The previous stage will blow away values if the remote collection
    // changed. So, if 1 is set, we can trust that cached value.
    if (this.state.remoteSyncID) {
      this._log.info("Skipping meta/global fetch because local copy is current.");
      this.advance();
      return;
    }

    let request = this.session.syncClient.getMetaGlobal();
    request.dispatch(this.onFetchResponse);
  },

  /**
   * Callback invoked upon completion of meta global fetch.
   */
  onFetchResponse: function onFetchResponse(error, request) {
    if (error) {
      if (error.notFound) {
        this._log.info("Meta global record not present on remote server.");

        // Just in case.
        this.state.remoteSyncID         = null;
        this.state.remoteStorageVersion = null;
        this.state.remoteRepositoryInfo = null;

        this.advance();
        return;
      }

      // TODO make part of StorageServiceRequestError API.
      const properties = ["network", "authentication", "client", "server"];
      for (let k of properties) {
        if (error[k]) {
          this.abort(error[k]);
          return;
        }
      }

      this.abort(new Error("Unhandled StorageServiceRequestError!"));
      return;
    }

    // No error means we have a record. However, we still need to ensure its
    // content is sane. If it doesn't look valid, we wipe the local data which
    // will force a new record to be uploaded.
    let record = request.resultObj;
    if (!record.syncID || !record.storageVersion ||
        (!record.repositories || !record.repositories.length)) {
      this._log.warn("Remote meta global record look invalid. Will reupload.");
      this.clearStateAndAdvance();
      return;
    }

    this.state.remoteSyncID         = record.syncID;
    this.state.remoteStorageVersion = record.storageVersion;
    this.state.remoteRepositoryInfo = record.repositories;

    this.advance();
  },

  clearStateAndAdvance: function clearStateAndAdvance() {
    this.state.remoteSyncID         = null;
    this.state.remoteStorageVersion = null;
    this.state.remoteRepositoryInfo = null;

    this.advance();
  },
};

/**
 * This stage ensures all the special records are in a happy place.
 *
 *
 * - fetch keys if 'crypto' timestamp differs from local one
 * - if it's non-existent, goto fresh start.
 * - decrypt keys with Sync Key, abort if HMAC verification fails.
 * - fetch meta/global if 'meta' timestamp differs from local one
 * - if it's non-existent, goto fresh start.
 * - check for storage version. if server data outdated, goto fresh start.
 *     if client is outdated, abort with friendly error message.
 * - if syncID mismatch, reset local timestamps, refetch keys
 * - if fresh start:
 *   - wipe server. all of it.
 *   - create + upload meta/global
 *   - generate + upload new keys
 */
function EnsureSpecialRecordsStage() {
  Stage.prototype.constructor.call(this, arguments);
}
EnsureSpecialRecordsStage.prototype = {
  __proto__: Stage.prototype,

  begin: function begin() {
    // No remote data means server incorrectly configured. We nuke the site
    // from orbit, just to be sure.
    if (!this.state.remoteSyncID) {
      let request = this.client.deleteCollections();
      request.dispatch(this.onServerWipeFinish);
      return;
    }

    this.ensureMetaGlobal();
  },

  onServerWipeFinish: function onServerWipeFinish(error, request) {
    if (error) {
      this._log.error("Error wiping server data: " +
                      CommonUtils.exceptionStr(error));
      this.abort(error);
      return;
    }

    this._log.info("Server wipe completed.");
    this.ensureMetaGlobal();
  },

  ensureMetaGlobal: function ensureMetaGlobal() {
    // TODO handle storage format mismatch.

    if (!this.state.localSyncID && this.state.remoteSyncID) {
      this._log.info("Setting local global Sync ID to remote: " +
                     this.state.remoteSyncID);
      this.state.localSyncID = this.state.remoteSyncID;
    }

    if (!this.state.localSyncID) {
      this.state.localSyncID = Utils.makeGUID();
    }

    // Upload new meta/global if we need to.
    if (!this.state.remoteSyncID) {
      let record = new MetaGlobalRecord();
      record.syncID = this.state.localSyncID;
      record.storageVersion = 5;

      // TODO add engines.

      let request = this.client.setBSO(record);
      request.dispatch(this.onUploadMetaGlobalFinish);
      return;
    }

    this.onFinishMetaGlobal();
  },

  onUploadMetaGlobalFinish: function onUploadMetaGlobalFinish(error, request) {
    if (error) {
      this._log.warn("Error uploading meta/global: " +
                     CommonUtils.exceptionStr(error));
      this.abort(error);
      return;
    }

    this.onFinishMetaGlobal();
  },

  onFinishMetaGlobal: function onFinishMetaGlobal() {
    // We are guaranteed to have a meta/global on the server and for local
    // and remote to be in sync. It's time to move on to crypto keys.

    this.abort(new Error("Not yet implemented."));
  },


};

/**
 * Fetches crypto record(s) from the server.
 *
 * Postconditions:
 *
 *   this.state.collectionKeys is populated.
 *
 * If no keys exist on the server or if there was an error decrypting the
 * record, this.state.collectionKeys should be set to null. If the record
 * contains no keys, it should be set to an empty object.
 */
function FetchCryptoRecordsStage() {
  Stage.prototype.constructor.call(this, arguments);
}
FetchCryptoRecordsStage.prototype = {
  __proto__: Stage.prototype,

  begin: function begin() {
    let request = this.session.syncClient.getBSO("crypto",
                                                 this.state.keysRecordID,
                                                 CryptoRecord);
    request.dispatch(this.onKeyFetch);
  },

  onKeyFetch: function onKeyFetch(error, response) {
    if (error) {
      this.abort(error);
      return;
    }

    if (response.notFound) {
      this.state.collectionKeys = null;
      this.advance();
      return;
    }

    let record = response.resultObj;

    // The payload of crypto records is unencrypted JSON. However, there are
    // encrypted contents within.
    //
    // Each record may contain an optional encrypting key, which is an
    // encrypted key bundle used to encrypt other data in the record. If this
    // field is present, the root key bundle is used to decode it. If not, the
    // root key bundle can be used to directly decrypt the other data within.

    let decodingBundle = this.state.syncKeyBundle;

    if (record.encryptingKey) {
      // TODO handle errors properly.
      decodingBundle =
        decodingBundle.unwrapBase64EncodedBundle(record.encryptingKey);
    }

    // TODO this assumes option 2 from the storage format 6 proposal.
    // TODO handle errors.
    let data = decodingBundle.decodeBase64Encoded(record.data);
    let mapping = JSON.parse(data);

    if (!this.state.collectionKeys) {
      this.state.collectionKeys = {};
    }

    for (let [k, v] in Iterator(mapping)) {
      let bundle = decodingBundle.unwrapBase64EncodedKeyBundle(v);
      this.state.collectionKeys[k] = bundle;
    }

    this.advance();
  },
};

function EnsureKeysStage() {
  Stage.prototype.constructor.call(this, arguments);
}
EnsureKeysStage.prototype = {
  __proto__: Stage.prototype,
};

/**
 * Updates state of repositories from server data.
 *
 * Postconditions:
 *
 *   TODO repository modified time
 *   TODO repository enabled state
 */
function UpdateRepositoryStateStage() {
  Stage.prototype.constructor.call(this, arguments);
}
UpdateRepositoryStateStage.prototype = {
  __proto__: Stage.prototype,
};

function SyncClientsRepositoryStage() {
  Stage.prototype.constructor.call(this, arguments);
}
SyncClientsRepositoryStage.prototype = {
  __proto__: Stage.prototype,
};

function ProcessFirstSyncPrefStage() {
  Stage.prototype.constructor.call(this, arguments);
};
ProcessFirstSyncPrefStage.prototype = {
  __proto__: Stage.prototype,
};

function ProcessClientCommandsStage() {
  Stage.prototype.constructor.call(this, arguments);
}
ProcessClientCommandsStage.prototype = {
  __proto__: Stage.prototype,
};

function SyncRepositoriesStage() {
  Stage.prototype.constructor.call(this, arguments);
}
SyncRepositoriesStage.prototype = {
  __proto__: Stage.prototype,
};

function FinishStage() {
  Stage.prototype.constructor.call(this, arguments);
}
FinishStage.prototype = {
  __proto__: Stage.prototype,
};
