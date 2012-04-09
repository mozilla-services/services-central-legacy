/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const EXPORTED_SYMBOLS = [
  "Stage",
];

const {classes: Cc, interfaces: Ci, utils: Cu, results: Cr} = Components;

Cu.import("resource://gre/modules/Services.jsm");

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
    let url = Svc.Prefs.get("clusterURL", null);

    if (url) {
      this.advance();
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
 *   TODO
 */
function CreateStorageServiceClientStage() {
  Stage.prototype.constructor.call(this, arguments);
}
CreateStorageServiceClientStage.prototype = {
  __proto__: Stage.prototype,
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
FetchInfoCollectionsState.prototype = {
  __proto__: Stage.prototype,
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
