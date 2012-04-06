/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const EXPORTED_SYMBOLS = [
  "CheckPreconditionsStage",
  "CreateStorageServiceClientStage",
  "EnsureClusterURLStage",
  "EnsureServiceCredentialsStage",
  "EnsureSpecialRecordsStage",
  "EnsureSyncKeyStage",
  "FetchInfoCollectionsStage",
  "FinishStage",
  "ProcessClientCommandsStage",
  "ProcessFirstSyncPrefStage",
  "ProcessInfoCollectionsStage",
  "Stage",
  "SyncClientsRepositoryStage",
  "SyncRepositoriesStage",
  "UpdateRepositoryStateStage",
];

const {classes: Cc, interfaces: Ci, utils: Cu, results: Cr} = Components;

Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://services-sync/client.js");

/**
 * Represents a specific phase in the syncing process.
 *
 * This is an abstract base type.
 *
 * Stages are instantiated and used by a GlobalSession. Stages share the same
 * constructor and the functions {begin, advance, abort}.
 *
 * The role of a stage is perform some specific, well-defined task. When it is
 * time for a stage to run, begin() is called. The stage then does what it
 * knows how to do.
 *
 * When a stage is finished executing, it calls advance() on success or abort()
 * if errors were encountered. The stage MUST call one of these or the session
 * will hang.
 */
function Stage(globalSession) {
  this.session = globalSession;
  this.state = globalSession.state;
}
Stage.prototype = {
  begin: function begin() {
    throw new Error("begin() must be defined.");
  },

  advance: function advance() {
    this.session.advance(null);
  },

  abort: function abort(error) {
    this.session.advance(error);
  },
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
    // TODO call Status.resetSync?
    // TODO ensure Status.checkSetup != CLIENT_NOT_CONFIGURED ?
    // TODO check master password?

    if (Svc.Prefs.get("firstSync") == "notReady") {
      this.abort(new Error("Client not ready."));
    }

    if (Services.io.offline) {
      this.abort(new Error("Network is offline."));
    }

    if (Status.minimumNextSync > Date.now()) {
      this.abort(new Error("Backoff not met."));
    }

    this.advance();
  },
};

/**
 * Obtain credentials used to talk to the storage service.
 *
 * By default, we obtain a BrowserID assertion and exchange this for an access
 * token with the token server. If we get lucky, we have an access token
 * cached locally.
 *
 * If you wish to obtain service credentials from a custom source, simply
 * monkeypatch begin() to do what you want.
 */
function EnsureServiceCredentialsStage() {
  Stage.prototype.constructor.call(this, arguments);
}
EnsureServiceCredentialsStage.prototype = {
  __proto__: Stage.prototype,

  begin: function begin() {
    // TODO implement.
    this.advance();
  },
};

/**
 * Obtain the master key used for data encryption.
 *
 * By default, the Sync Key comes from Persona key wrapping.
 *
 * It is possible to change where the Sync Key comes from by monkeypatching
 * begin(). Just replace begin() with your function that grabs the Sync Key
 * from wherever you have it.
 *
 * Postconditions:
 *
 *   this.state.syncKey set to an instance of XXX.
 */
function EnsureSyncKeyStage() {
  Stage.prototype.constructor.call(this, arguments);
}
EnsureSyncKeyStage.prototype = {
  __proto__: Stage.prototype,

  begin: function begin() {
    this.advance();
  },
};

/**
 * Ensures that a cluserURL is set.
 *
 * Postconditions:
 *
 *   GlobalState.cluserURL is set
 */
function EnsureClusterURLStage() {
  Stage.prototype.constructor.call(this, arguments);
}
EnsureClusterURLStage.prototype = {
  __proto__: Stage.prototype,

  begin: function begin() {
    if (this.state.clusterURL) {
      this.advance();
      return;
    }

    // TODO implement cluster search logic.
    this.abort(new Error("No cluster URL defined."));
  },
};

/**
 * Create the HTTP client used to speak with the storage service.
 *
 * Postconditions:
 *
 *   this.state.syncClient is populated with a SyncClient instance.
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
    this.state.client = new SyncClient(this.state.clusterURL);
    this.state.client.addListener(this);
    this.state.client.addListener(this.session);

    this.advance();
  },

  /**
   * StorageServiceClient callback that gets invoked at request time.
   *
   * This hooks up HTTP authentication to outgoing requests.
   */
  onDispatch: function onDispatch(client, request) {
    if (this.state.username && this.state.basicPassword) {
      this._log.debug("Adding HTTP Basic auth to request.");
      let up = this.state.username + ":" + this.state.basicPassword;
      request.setHeader("authorization", "Basic " + btoa(up));
      return;
    }

    this._log.info("No HTTP authentication credentials available.");
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
    let request = this.state.syncClient.getCollectionInfo();
    request.dispatch(this.onRequestComplete);
  },

  onRequestComplete: function onRequestComplete(error, request) {
    if (error) {
      this.abort(error);
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
    // TODO make conditional if we already have values.

    this.session.syncClient.fetchMetaGlobal(this.onFetch);
  },

  /**
   * Callback invoked upon completion of meta global fetch.
   */
  onFetch: function onFetch(error, record) {
    if (error instanceof MetaGlobalRequestError &&
        error.condition == MetaGlobalRequestError.NOT_FOUND) {
        this.clearStateAndAdvance();
        return;
    } else if (error) {
      this.abort(error);
      return;
    }

    // No error means we have a record. However, we still need to ensure its
    // content is sane.
    if (!record.syncID || !record.storageVersion ||
        (!record.repositories || !record.repositories.length)) {
      this.clearStateAndAdvance();
      return;
    }

    this.state.remoteSyncID = record.syncID;
    this.state.remoteStorageVersion = record.storageVersion;
    this.state.remoteRepositoryInfo = record.repositories;

    this.advance();
  },

  clearStateAndAdvance: function clearStateAndAdvance() {
    this.state.remoteSyncID = null;
    this.state.remoteStorageVersion = null;
    this.state.remoteRepositoryInfo = null;

    this.advance();
  },
};
/**
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
