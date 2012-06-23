/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const {classes: Cc, interfaces: Ci, results: Cr, utils: Cu} = Components;

const EXPORTED_SYMBOLS = [
  "SecurityManager",
];

Cu.import("resource://services-common/log4moz.js");
Cu.import("resource://services-common/tokenserverclient.js");
Cu.import("resource://services-aitc/browserid.js");

/**
 * Manages the aspects of security as they relate to Sync.
 *
 * In essence, this type is an interface which must provide a set of callbacks
 * which are used to configure the Sync client. These are defined together
 * at the top of the prototype.
 *
 * The rest of this type provides the implementation we officially support
 * in Mozilla applications.
 *
 * Extensions, etc are free to define their own types which conform to the
 * SecurityManager interface.
 */
function SecurityManager() {
  this.allowServerRootKeyStorage = true;
  this.requireStrongKeyWrapping = false;

  this.httpAuthMode = "token";
}
SecurityManager.prototype = {

  // CORE INTERFACE CALLBACKS.

  /**
   * Callback invoked when a sync is about to begin.
   *
   * This callback essentially looks at the world and ensures we are ready to
   * perform a sync by gathering required authentication data, etc.
   *
   * Our default implementation supports the built-in security modes. If you
   * wish to do something else, you would provide your own function.
   */
  onSyncStart: function onSyncStart(sync, cb) {
    if (this.httpAuthMode == "token") {
      this._onSyncStartToken(sync, cb);
    } else if (this.httpAuthMode == "basic") {
      this._onSyncStartBasic(sync, cb);
    } else {
      cb(new Error("Unknown httpAuthMode. Misconfigured SecurityManager!"));
    }
  },

  /**
   * Called by the GlobalSession to obtain a root key bundle.
   *
   * The callback receives the following arguments:
   *
   *   (Error) Error that occurred when obtaining the key. null if no error
   *     occurred.
   *   (KeyBundle) The root key bundle the client should use. This must be
   *     defined if no error was encountered. If this is not defined, the
   *     client will error.
   */
  onObtainRootKey: function onObtainRootKey(sync, cb) {

  },

  /**
   * Callback invoked whenever the credentials for the storage server failed.
   *
   * If this happens, a sync is in the process of aborting because communication
   * with the server could not be established. This function should make
   * whatever state changes are necessary (typically wiping out cached
   * credentials or prompting the user for new credentials) to put the client
   * in a position such that the next sync should work properly.
   *
   * TODO does this need a callback?
   */
  onStorageServerCredentialsFailed: onStorageServerCredentialsFailed() {
    if (this.httpAuthMode == "token") {
      this.storageToken = null;
    } else if (this.httpAuthMode == "basic") {
      this.basicUsername = null;
      this.basicPassword = null;
    }
  },

  // END OF CORE INTERFACE CALLBACKS.

  /**
   * Choice for HTTP authentication with Storage Server.
   *
   * Values can be "token" or "basic".
   */
  httpAuthMode: null,

  /**
   * String URL to use to obtain an access token.
   *
   * Only used if httpAuthMode is "token".
   */
  tokenServerURL: null,

  /**
   * Whether we are allowed to store an encrypted root key on a remote server.
   */
  allowServerRootKeyStorage: null,

  /**
   * Whether to require cryptographically secure wrapping of the root key.
   *
   * If set to false, Sync will allow the root key to be wrapped with keys
   * that may be derived from less secure sources, such as passwords.
   */
  requireStrongKeyWrapping: null,

  /**
   * The token used to access the storage service.
   *
   * This has the same structure as the map returned by TokenServerClient.
   * e.g. it must have the fields {id, key, endpoint, uid}.
   */
  storageToken: null,

  /**
   * If authenticating with HTTP basic credentials, the username and password
   * to use.
   */
  basicUsername: null,
  basicPassword: null,

  _onSyncStartBasic: function _onSyncStartBasic(sync, cb) {
    if (!this.basicUsername || !this.basicPassword) {
      if (!this._loadBasicCredentials()) {
        cb(new Error("No basic credentials found."));
        return;
      }
    }

    cb(null);
  },

  _onSyncStartToken: function _onSyncStartToken(sync, cb) {
    if (!this.storageToken) {
      // TODO obtain tokens from local cache.

      if (!this.tokenServerURL) {
        cb(new Error("No token server URL defined."));
        return;
      }

      // We exchange a BrowserID assertion for a token.
      // This currently uses AITC's BrowserID module. A new Identity.jsm module
      // is being written.
      // TODO switch to that when it is ready.
      BrowserID.getAssertion(function onAssertion(error, assertion) {
        if (error) {
          this._log.info("Unable to obtain BrowserID assertion: " + error);
          cb(error);
          return;
        }

        let client = new TokenServerClient();
        client.getTokenFromBrowserIDAssertion(this.tokenServerURL, assertion,
                                 this._okTokenResponse.bind(this, sync, cb));
      }, {audience: "sync.services.mozilla.org"});
    }
  },

  _onTokenResponse: function _onTokenResponse(sync, cb, error, result) {
    if (error) {
      this._log.warn("Error fetching token from token server: " + error);
      cb(error);
      return;
    }

    this.storageToken = result;
    sync.state.storageServerURL = result.endpoint;
    cb(null);
  },

  /**
   * Loads basic credentials from the password manager.
   *
   * Side effect is basicUsername and basicPassword are populated if
   * credentials are available.
   *
   * This may throw if the password manager is locked by the master password.
   *
   * @return boolean
   *         Whether credentials were found.
   */
  _loadBasicCredentials: function _loadBasicCredentials() {
    this.basicUsername = PREFS.get("username", null);
    this.basicPassword = null;

    if (!this.basicUsername) {
      return false;
    }

    let logins = Services.logins.findLogins({}, PWDMGR_HOST, null,
                                            PWDMGR_PASSWORD_REALM);

    for each (let login in logins) {
      if (login.username.toLowerCase() != this.basicUsername) {
        continue;
      }

      this.basicPassword = Utils.encodeUTF8(login.password);
    }

    return !!this.basicPassword;
  },
};

