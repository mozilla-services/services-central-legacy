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
 * The Original Code is Sync.
 *
 * The Initial Developer of the Original Code is Mozilla Foundation.
 * Portions created by the Initial Developer are Copyright (C) 2011
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *  Gregory Szorc <gps@mozilla.com>
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

const EXPORTED_SYMBOLS = ["TabStateUtils"];

const {classes: Cc, interfaces: Ci, utils: Cu} = Components;

Cu.import("resource://services-sync/log4moz.js");
Cu.import("resource://services-sync/util.js");

let TabStateUtils = {
  _log: Log4Moz.repository.getLogger("Sync.TabStateUtils"),

  /**
   * Send a tab to a remote client.
   *
   * This function assembles the tab state from the passed tab object.
   *
   * Currently, we only support a limited sub-set of tab state. While the
   * state format highly resembles information from nsISessionStore, it is
   * different. This logic may eventually make it into nsISessionStore
   * or a similar interface. However, it lives in Sync for now.
   *
   * @param  tab
   *         The tab XUL object to send.
   * @param  clientID
   *         The ID of the client that will receive the tab.
   * @param  options
   *         Additional options to control sending behavior. The following
   *         keys are recognized:
   *           ttl - The TTL of the tab state record, in seconds.
   *           engine - Clients engine to send command with. If not defined
   *                    defaults to use the global Clients instance.
   */
  sendTabToClient: function sendTabToClient(tab, clientID, options) {
    let browser;
    if (tab.linkedBrowser) {
      browser = tab.linkedBrowser;
    } else if (tab.browser) {
      browser = tab.browser;
    } else {
      throw "Unable to obtain browser from tab object";
    }

    let uri = browser.currentURI.spec;

    let outOptions = {};
    let tabState = this.getTabState(tab, browser);
    if (Object.keys(tabState).length) {
      outOptions.tabState = tabState;
    }

    if ("ttl" in options) {
      outOptions.ttl = options.ttl;
    }

    let clientsEngine = options.engine || Weave.Clients;

    clientsEngine.sendURIToClient(uri, clientID, outOptions);
  },

   /**
   * Obtain the tab state for a tab instance.
   *
   * This is a convenience API that normalizes the differences between
   * different application types (e.g. desktop and mobile). This API does not
   * live in core sync code because it is application-specific.
   *
   * @param  tab
   *         XUL tab instance to obtain state for.
   * @param  browser
   *         Browser object to obtain state for.
   * @return object Black box object defining the Sync-normalized tab state.
   */
  getTabState: function getTabState(tab, browser) {
    let tabState;

    if (Svc.Session.getTabState) {
      tabState = JSON.parse(Svc.Session.getTabState(tab));
    } else if (Svc.Session.getTabState1) {
      tabState = Svc.Session.getTabState1(browser);
    } else {
      this._log.debug("Tab state not available for specified tab");
      return {};
    }

    this._log.debug("SessionStore tab state: " + JSON.stringify(tabState));

    let entry;
    if ("index" in tabState) {
      // The stored index is 1-based, interestingly.
      entry = tabState.entries[tabState.index - 1];

      delete entry.children;
      this._log.debug("Entry: " + JSON.stringify(entry));
    }

    let state = {
      version:  1,
      cookies:  [],
      formdata: {}
    };

    if (entry && "formdata" in entry) {
      state.formdata = entry.formdata;
    }

    let cookieList;
    try {
      let host = browser.currentURI.host;
      cookieList = Services.cookies.getCookiesFromHost(host);
    } catch (ex) {
      this._log.warn("Unable to obtain cookie list for host: " + host);
    }

    while (cookieList && cookieList.hasMoreElements()) {
      let cookie = cookieList.getNext().QueryInterface(Ci.nsICookie2);

      // We purposefully limit to session cookies, since longer duration
      // cookies may result in expected behavior.
      if (!cookie.isSession) {
        continue;
      }

      let jscookie = {
        host:       cookie.host,
        value:      cookie.value,
        isSession:  true,
        isSecure:   !!cookie.isSecure,
        isHttpOnly: !!cookie.IsHttpOnly,
        expiry:     cookie.expiry,
        path:       cookie.path,
        name:       cookie.name
      };

      state.cookies.push(jscookie);
    }

    // TODO support scroll offset... somehow.

    this._log.debug("Tab state: " + JSON.stringify(state));

    return state;
  },

  /**
   * Restore tab state to a browser instance.
   *
   * This is the low-level function that takes a Sync tab state record and
   * restores it to a XUL browser instance. It is the opposite of the logic
   * in getTabState().
   *
   * Like getTabState(), this is a convenience API that is specifically
   * tailored towards specific applications. Therefore, it should not live
   * in the core Sync API.
   *
   * @param browser
   *        XUL browser instance to restore.
   * @param record
   *        Object passed to display-tab notification. Has uri, tabState, and
   *        senderID fields.
   */
  restoreTab: function restoreTab(browser, record) {
    let tab = browser.addTab(record.uri);

    if (!record.tabState) {
      return;
    }

    let tabState = record.tabState;

    if (tabState.version != 1) {
      this._log.warn("Unknown tab state version, ignoring: "
                     + tabState.version);
      return;
    }

    // We start by restoring cookies, as these impact the HTTP request issued
    // on page load.
    if (tabState.cookies) {
      let service = Services.cookies;

      let length = tabState.cookies.length;
      for (let i = 0; i < length; i++) {
        let cookie = tabState.cookies[0];

        service.add(cookie.host, cookie.path, cookie.name, cookie.value,
                    cookie.isSecure, cookie.isHttpOnly, cookie.isSession,
                    cookie.expiry);
      }
    }

    // Now we assemble a minimal record to be fed into nsISessionStore. We
    // violate the opaqueness of that API. Therefore, this is prone to breakage
    // and thus must be heavily tested for regressions when session store
    // changes.
    let sessionState = {
      index:   1,
      entries: [{
        url:      record.uri,
        formdata: tabState.formdata
      }],
      hidden: false
    };

    if (Svc.Session.setTabState) {
      Svc.Session.setTabState(tab, JSON.stringify(sessionState));
    }
    // TODO support tab state restore on mobile
  }

};
