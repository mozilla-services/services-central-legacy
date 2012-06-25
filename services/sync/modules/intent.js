/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const EXPORTED_SYMBOLS = ["SyncIntent"];

const Cu = Components.utils;

/**
 * Represents a reason for performing a sync operation.
 *
 * When a sync session is created, a sync intent is associated so the session
 * knows what needs to be synchronized and how to react in case of errors.
 */
function SyncIntent() {
  this.outgoingRepositories = new Set();
}
SyncIntent.prototype = {
  /**
   * Mark a repository as having outgoing changes.
   */
  addOutgoingRepository: function addOutgoingRepository(name) {
    this.outgoingRepositories.add(name);
  },
};
Object.freeze(SyncIntent.prototype);
