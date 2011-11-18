// -*- Mode: js2; tab-width: 2; indent-tabs-mode: nil; js2-basic-offset: 2; js2-skip-preporcessor-directives: t; -*-
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
 * The Original Code is Mozilla Mobile Browser.
 *
 * The Initial Developer of the Original Code is
 * Mozilla Corporation..
 * Portions created by the Initial Developer are Copyright (C) 2011
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *   Gregory Szorc <gps@mozilla.com>
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

let SendTabPopup = {
  syncPerformed: false,

  get box() {
    delete this.box;
    this.box = document.getElementById("sendtab-popup");

    let self = this;
    messageManager.addMessageListener("pagehide", function(message) {
      self.hide();
    });
    return this.box;
  },

  hide: function hide() {
    this.box.hidden = true;
    BrowserUI.popPopup(this);
  },

  show: function show() {
    // A lot of this code is the same as for desktop. Consider factoring common
    // bits into a utility library.
    let list = document.getElementById("sendtab-popup-devices");
    let children = list.childNodes;
    let removeElements = [];
    for (let i = 0; i < children.length; i++) {
      let node = children[i];

      if (node.id == "sendtab-popup-nosync") continue;
      if (node.id == "sendtab-popup-syncnotready") continue;

      removeElements.push(node);
    }

    for each (let element in removeElements) {
      list.removeChild(element);
    }

    let noSyncItem = document.getElementById("sendtab-popup-nosync");
    let notAvailableItem = document.getElementById("sendtab-popup-syncnotready");

    if (!Services.prefs.prefHasUserValue("services.sync.username")) {
      noSyncItem.hidden = false;
      notAvailableItem.hidden = true;
    } else if (!WeaveGlue.syncPerformed) {
      noSyncItem.hidden = true;
      notAvailableItem.hidden = false;
    } else {
      noSyncItem.hidden = true;
      notAvailableItem.hidden = true;
    }

    let clients = Weave.Clients.remoteClients;
    for each (let [id, client] in Iterator(clients)) {
      let listItem = document.createElement("richlistitem");
      listItem.className = "action-button";

      listItem.addEventListener("TapSingle", function sendClientTabHandler() {
        try {
          Weave.TabStateUtils.sendTabToClient(Browser.selectedTab,
                                              id,
                                              {engine: Weave.Clients});
        } catch (ex) {
          dump("Received exception when sending tab to client: " + ex);
        }
      });

      let label = document.createElement("label");
      label.setAttribute("value", client.name);
      listItem.appendChild(label);

      list.appendChild(listItem);
    }

    // This code shamlessly inspired by BookmarkPopup.js. Consider refactoring
    // into common function.
    let box = this.box;
    let button = document.getElementById("tool-sendtab");
    let anchorPosition = "";

    if (getComputedStyle(button).visibility == "visible") {
      let tabsSidebar = Elements.tabs.getBoundingClientRect();
      let controlsSidebar = Elements.controls.getBoundingClientRect();

      box.setAttribute(tabsSidebar.left < controlsSidebar.left ? "right" : "left",
                            controlsSidebar.width - box.offset);
      box.top = button.getBoundingClientRect().top - box.offset;
    } else {
      anchorPosition = "after_start";
    }

    box.hidden = false;
    box.anchorTo(button, anchorPosition);

    BrowserUI.pushPopup(this, [box, button]);
  },

  toggle: function toggle() {
    if (this.box.hidden) {
      this.show();
    } else {
      this.hide();
    }
  }
};
