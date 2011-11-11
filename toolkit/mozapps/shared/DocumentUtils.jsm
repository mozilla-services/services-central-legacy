/* -*- Mode: Javascript; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
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
 * The Original Code is nsSessionStore component.
 *
 * The Initial Developer of the Original Code is
 * Simon Bünzli <zeniko@gmail.com>
 * Portions created by the Initial Developer are Copyright (C) 2006
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *  Dietrich Ayala <dietrich@mozilla.com>
 *  Ehsan Akhgari <ehsan.akhgari@gmail.com>
 *  Michael Kraft <morac99-firefox2@yahoo.com>
 *  Paul O'Shannessy <paul@oshannessy.com>
 *  Nils Maier <maierman@web.de>
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

let EXPORTED_SYMBOLS = ["DocumentUtils"];

Components.utils.import("resource://gre/modules/XPCOMUtils.jsm");

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cr = Components.results;

let DocumentUtils = {
  /**
   * Obtain form data for a DOMDocument instance.
   *
   * The returned object has 2 keys, "id" and "xpath". Each key holds an object
   * which further defines form data.
   *
   * The "id" object maps element IDs to values. The "xpath" object maps the
   * XPath of an element to its value.
   *
   * @param  document
   *         DOMDocument instance to obtain form data for.
   * @return object
   *         Form data encoded in an object.
   */
  getFormData: function getFormData(document) {
   let formNodes = document.evaluate(
      XPathHelper.restorableFormNodes,
      document,
      XPathHelper.resolveNS,
      Ci.nsIDOMXPathResult.UNORDERED_NODE_ITERATOR_TYPE, null
    );

    let ret = {id: {}, xpath: {}};

    let node = formNodes.iterateNext();
    if (!node) {
      return ret;
    }

    // Limit the number of XPath expressions for performance reasons. See
    // bug 477564.
    const MAX_TRAVERSED_XPATHS = 100;

    let generatedCount = 0;

    do {
      let nId = node.id;
      let hasDefaultValue = true;
      let value;

      // Only generate a limited number of XPath expressions for perf reasons
      // (cf. bug 477564)
      if (!nId && generatedCount > MAX_TRAVERSED_XPATHS) {
        continue;
      }

      if (node instanceof Ci.nsIDOMHTMLInputElement ||
          node instanceof Ci.nsIDOMHTMLTextAreaElement) {
        switch (node.type) {
          case "checkbox":
          case "radio":
            value = node.checked;
            hasDefaultValue = value == node.defaultChecked;
            break;
          case "file":
            value = { type: "file", fileList: node.mozGetFileNameArray() };
            hasDefaultValue = !value.fileList.length;
            break;
          default: // text, textarea
            value = node.value;
            hasDefaultValue = value == node.defaultValue;
            break;
        }
      } else if (!node.multiple) {
        // <select>s without the multiple attribute are hard to determine the
        // default value, so assume we don't have the default.
        hasDefaultValue = false;
        value = node.selectedIndex;
      } else {
        // <select>s with the multiple attribute are easier to determine the
        // default value since each <option> has a defaultSelected
        let options = Array.map(node.options, function(aOpt, aIx) {
          let oSelected = aOpt.selected;
          hasDefaultValue = hasDefaultValue && (oSelected == aOpt.defaultSelected);
          return oSelected ? aIx : -1;
        });
        value = options.filter(function(aIx) aIx >= 0);
      }

      // In order to reduce XPath generation (which is slow), we only save data
      // for form fields that have been changed. (cf. bug 537289)
      if (!hasDefaultValue) {
        if (nId) {
          ret.id[nId] = value;
        } else {
          generatedCount++;
          ret.xpath[XPathHelper.generate(node)] = value;
        }
      }

    } while ((node = formNodes.iterateNext()));

    return ret;
  },

  /**
   * Merges form data on a document from previously obtained data.
   *
   * This is the inverse of getFormData(). The data argument is the same object
   * type which is returned by getFormData(): an object containing the keys
   * "id" and "xpath" which are each objects mapping element identifiers to
   * form values.
   *
   * Where the document has existing form data for an element, the value
   * will be replaced. Where the document has a form element but no matching
   * data in the passed object, the element is untouched.
   *
   * @param  document
   *         DOMDocument instance to which to restore form data.
   * @param  data
   *         Object defining form data.
   */
  mergeFormData: function setFormData(document, data) {
    for each (let [xpath, value] in Iterator(data.xpath)) {
      let node = XPathHelper.resolve(document, xpath);
      if (!node) {
        continue;
      }

      this.restoreFormValue(node, value, document);
    }

    for each (let [id, value] in Iterator(data.id)) {
      let node = document.getElementById(id);
      if (!node) {
        continue;
      }

      this.restoreFormValue(node, value, document);
    }
  },

  /**
   * Low-level function to restore a form value to a DOMNode.
   *
   * If you want a higher-level interface, see mergeFormData().
   *
   * When the value is changed, the function will fire the appropriate DOM
   * events.
   *
   * @param  node
   *         DOMNode to set form value on.
   * @param  value
   *         Value to set form element to.
   * @param  document [optional]
   *         DOMDocument node belongs to. If not defined, node.ownerDocument
   *         is used.
   */
  restoreFormValue: function restoreFormValue(node, value, document) {
    document = document || node.ownerDocument;

    let eventType;

    if (typeof value == "string" && node.type != "file") {
      // Don't dispatch an input event if there is no change.
      if (node.value == value) {
        return;
      }

      node.value = value;
      eventType = "input";
    }
    else if (typeof value == "boolean") {
      // Don't dispatch an input event for no change.
      if (node.checked == value) {
        return;
      }

      node.checked = value;
      eventType = "change";
    }
    else if (typeof value == "number") {
      // We saved the value blindly since selects take more work to determine
      // default values. So now we should check to avoid unnecessary events.
      if (node.selectedIndex == value) {
        return;
      }
      try {
        node.selectedIndex = value;
        eventType = "change";
      } catch (ex) { /* throws for invalid indices */ }
    }
    else if (value && value.fileList && value.type == "file" && node.type == "file") {
      node.mozSetFileNameArray(value.fileList, value.fileList.length);
      eventType = "input";
    }
    else if (value && typeof value.indexOf == "function" && node.options) {
      Array.forEach(node.options, function(opt, index) {
        opt.selected = value.indexOf(index) > -1;

        // Only fire the event here if this wasn't selected by default.
        if (!opt.defaultSelected) {
          eventType = "change";
        }
      });
    }

    // Fire events for this node if application.
    if (eventType) {
      let event = document.createEvent("UIEvents");
      event.initUIEvent(eventType, true, true, document.defaultView, 0);
      node.dispatchEvent(event);
    }
  }
};

/**
 * XPath helper functions.
 *
 * This code was originally lifted from nsSessionStore.js.
 */
let XPathHelper = {
  // these two hashes should be kept in sync
  namespaceURIs:     { "xhtml": "http://www.w3.org/1999/xhtml" },
  namespacePrefixes: { "http://www.w3.org/1999/xhtml": "xhtml" },

  /**
   * Generates an approximate XPath query to an (X)HTML node
   */
  generate: function sss_xph_generate(aNode) {
    // have we reached the document node already?
    if (!aNode.parentNode) {
      return "";
    }

    // Access localName, namespaceURI just once per node since it's expensive.
    let nNamespaceURI = aNode.namespaceURI;
    let nLocalName    = aNode.localName;

    let prefix = this.namespacePrefixes[nNamespaceURI] || null;
    let tag = (prefix ? prefix + ":" : "") + this.escapeName(nLocalName);

    // stop once we've found a tag with an ID
    if (aNode.id) {
      return "//" + tag + "[@id=" + this.quoteArgument(aNode.id) + "]";
    }

    // count the number of previous sibling nodes of the same tag
    // (and possible also the same name)
    let count = 0;
    let nName = aNode.name || null;
    for (let n = aNode; (n = n.previousSibling); ) {
      if (n.localName == nLocalName && n.namespaceURI == nNamespaceURI &&
          (!nName || n.name == nName)) {
        count++;
      }
    }

    // recurse until hitting either the document node or an ID'd node
    return this.generate(aNode.parentNode) + "/" + tag +
           (nName ? "[@name=" + this.quoteArgument(nName) + "]" : "") +
           (count ? "[" + (count + 1) + "]" : "");
  },

  /**
   * Resolves an XPath query generated by XPathHelper.generate
   */
  resolve: function sss_xph_resolve(aDocument, aQuery) {
    let xptype = Ci.nsIDOMXPathResult.FIRST_ORDERED_NODE_TYPE;
    return aDocument.evaluate(aQuery, aDocument, this.resolveNS, xptype, null).singleNodeValue;
  },

  /**
   * Namespace resolver for the above XPath resolver
   */
  resolveNS: function sss_xph_resolveNS(aPrefix) {
    return XPathHelper.namespaceURIs[aPrefix] || null;
  },

  /**
   * @returns valid XPath for the given node (usually just the local name itself)
   */
  escapeName: function sss_xph_escapeName(aName) {
    // we can't just use the node's local name, if it contains
    // special characters (cf. bug 485482)
    return /^\w+$/.test(aName) ? aName :
           "*[local-name()=" + this.quoteArgument(aName) + "]";
  },

  /**
   * @returns a properly quoted string to insert into an XPath query
   */
  quoteArgument: function sss_xph_quoteArgument(aArg) {
    return !/'/.test(aArg) ? "'" + aArg + "'" :
           !/"/.test(aArg) ? '"' + aArg + '"' :
           "concat('" + aArg.replace(/'+/g, "',\"$&\",'") + "')";
  },

  /**
   * @returns an XPath query to all savable form field nodes
   */
  get restorableFormNodes() {
    // for a comprehensive list of all available <INPUT> types see
    // http://mxr.mozilla.org/mozilla-central/search?string=kInputTypeTable
    let ignoreTypes = ["password", "hidden", "button", "image", "submit", "reset"];
    // XXXzeniko work-around until lower-case has been implemented (bug 398389)
    let toLowerCase = '"ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"';
    let ignore = "not(translate(@type, " + toLowerCase + ")='" +
      ignoreTypes.join("' or translate(@type, " + toLowerCase + ")='") + "')";
    let formNodesXPath = "//textarea|//select|//xhtml:textarea|//xhtml:select|" +
      "//input[" + ignore + "]|//xhtml:input[" + ignore + "]";

    delete this.restorableFormNodes;
    return (this.restorableFormNodes = formNodesXPath);
  }
};

