/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim: set ft=javascript ts=2 et sw=2 tw=80: */
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
 * The Original Code is the Mozilla Highlighter Module.
 *
 * The Initial Developer of the Original Code is
 * The Mozilla Foundation.
 * Portions created by the Initial Developer are Copyright (C) 2010
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *   Rob Campbell <rcampbell@mozilla.com> (original author)
 *   Mihai Șucan <mihai.sucan@gmail.com>
 *   Julian Viereck <jviereck@mozilla.com>
 *   Paul Rouget <paul@mozilla.com>
 *   Kyle Simpson <ksimpson@mozilla.com>
 *   Johan Charlez <johan.charlez@gmail.com>
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

const Cu = Components.utils;
Cu.import("resource:///modules/devtools/LayoutHelpers.jsm");

var EXPORTED_SYMBOLS = ["Highlighter"];

const INSPECTOR_INVISIBLE_ELEMENTS = {
  "head": true,
  "base": true,
  "basefont": true,
  "isindex": true,
  "link": true,
  "meta": true,
  "script": true,
  "style": true,
  "title": true,
};

/**
 * A highlighter mechanism.
 *
 * The highlighter is built dynamically into the browser element.
 * The caller is in charge of destroying the highlighter (ie, the highlighter
 * won't be destroyed if a new tab is selected for example).
 *
 * API:
 *
 *   // Constructor and destructor.
 *   // @param aWindow - browser.xul window.
 *   Highlighter(aWindow); 
 *   void destroy();
 *
 *   // Highlight a node.
 *   // @param aNode - node to highlight
 *   // @param aScroll - scroll to ensure the node is visible
 *   void highlight(aNode, aScroll);
 *
 *   // Get the selected node.
 *   DOMNode getNode();
 *
 *   // Lock and unlock the select node.
 *   void lock();
 *   void unlock();
 *
 *   // Show and hide the highlighter
 *   void show();
 *   void hide();
 *   boolean isHidden();
 *
 *   // Redraw the highlighter if the visible portion of the node has changed.
 *   void invalidateSize(aScroll);
 *
 *   // Is a node highlightable.
 *   boolean isNodeHighlightable(aNode);
 *
 *   // Add/Remove lsiteners
 *   // @param aEvent - event name
 *   // @param aListener - function callback
 *   void addListener(aEvent, aListener);
 *   void removeListener(aEvent, aListener);
 *
 * Events:
 *
 *   "closed" - Highlighter is closing
 *   "nodeselected" - A new node has been selected
 *   "highlighting" - Highlighter is highlighting
 *   "locked" - The selected node has been locked
 *   "unlocked" - The selected ndoe has been unlocked
 *
 * Structure:
 *
 *   <stack id="highlighter-container">
 *     <vbox id="highlighter-veil-container">...</vbox>
 *     <box id="highlighter-controls>...</vbox>
 *   </stack>
 *
 */


/**
 * Constructor.
 *
 * @param object aWindow
 */
function Highlighter(aWindow)
{
  this.chromeWin = aWindow;
  this.tabbrowser = aWindow.gBrowser;
  this.chromeDoc = aWindow.document;
  this.browser = aWindow.gBrowser.selectedBrowser;
  this.events = {};

  this._init();
}

Highlighter.prototype = {
  _init: function Highlighter__init()
  {
    let stack = this.browser.parentNode;
    this.win = this.browser.contentWindow;
    this._highlighting = false;

    this.highlighterContainer = this.chromeDoc.createElement("stack");
    this.highlighterContainer.id = "highlighter-container";

    this.veilContainer = this.chromeDoc.createElement("vbox");
    this.veilContainer.id = "highlighter-veil-container";

    // The controlsBox will host the different interactive
    // elements of the highlighter (buttons, toolbars, ...).
    let controlsBox = this.chromeDoc.createElement("box");
    controlsBox.id = "highlighter-controls";
    this.highlighterContainer.appendChild(this.veilContainer);
    this.highlighterContainer.appendChild(controlsBox);

    stack.appendChild(this.highlighterContainer);

    // The veil will make the whole page darker except
    // for the region of the selected box.
    this.buildVeil(this.veilContainer);

    this.buildInfobar(controlsBox);

    this.transitionDisabler = null;

    this.computeZoomFactor();
    this.unlock();
    this.hide();
  },

  /**
   * Destroy the nodes. Remove listeners.
   */
  destroy: function Highlighter_destroy()
  {
    this.detachKeysListeners();
    this.detachMouseListeners();
    this.detachPageListeners();

    this.chromeWin.clearTimeout(this.transitionDisabler);
    this.boundCloseEventHandler = null;
    this._contentRect = null;
    this._highlightRect = null;
    this._highlighting = false;
    this.veilTopBox = null;
    this.veilLeftBox = null;
    this.veilMiddleBox = null;
    this.veilTransparentBox = null;
    this.veilContainer = null;
    this.node = null;
    this.nodeInfo = null;
    this.highlighterContainer.parentNode.removeChild(this.highlighterContainer);
    this.highlighterContainer = null;
    this.win = null
    this.browser = null;
    this.chromeDoc = null;
    this.chromeWin = null;
    this.tabbrowser = null;

    this.emitEvent("closed");
    this.removeAllListeners();
  },

  /**
   * Show the veil, and select a node.
   * If no node is specified, the previous selected node is highlighted if any.
   * If no node was selected, the root element is selected.
   *
   * @param aNode [optional] - The node to be selected.
   * @param aScroll [optional] boolean
   *        Should we scroll to ensure that the selected node is visible.
   */
  highlight: function Highlighter_highlight(aNode, aScroll)
  {
    if (this.hidden)
      this.show();

    let oldNode = this.node;

    if (!aNode) {
      if (!this.node)
        this.node = this.win.document.documentElement;
    } else {
      this.node = aNode;
    }

    if (oldNode !== this.node) {
      this.updateInfobar();
    }

    this.invalidateSize(!!aScroll);

    if (oldNode !== this.node) {
      this.emitEvent("nodeselected");
    }
  },

  /**
   * Update the highlighter size and position.
   */
  invalidateSize: function Highlighter_invalidateSize(aScroll)
  {
    let rect = null;

    if (this.node && this.isNodeHighlightable(this.node)) {

      if (aScroll &&
          this.node.scrollIntoView) { // XUL elements don't have such method
        this.node.scrollIntoView();
      }
      let clientRect = this.node.getBoundingClientRect();
      rect = LayoutHelpers.getDirtyRect(this.node);
    }

    this.highlightRectangle(rect);

    this.moveInfobar();

    if (this._highlighting) {
      this.emitEvent("highlighting");
    }
  },

  /**
   * Returns the selected node.
   *
   * @returns node
   */
  getNode: function() {
    return this.node;
  },

  /**
   * Show the highlighter if it has been hidden.
   */
  show: function() {
    if (!this.hidden) return;
    this.veilContainer.removeAttribute("hidden");
    this.nodeInfo.container.removeAttribute("hidden");
    this.attachKeysListeners();
    this.attachPageListeners();
    this.invalidateSize();
    this.hidden = false;
  },

  /**
   * Hide the highlighter, the veil and the infobar.
   */
  hide: function() {
    if (this.hidden) return;
    this.veilContainer.setAttribute("hidden", "true");
    this.nodeInfo.container.setAttribute("hidden", "true");
    this.detachKeysListeners();
    this.detachPageListeners();
    this.hidden = true;
  },

  /**
   * Is the highlighter visible?
   *
   * @return boolean
   */
  isHidden: function() {
    return this.hidden;
  },

  /**
   * Lock a node. Stops the inspection.
   */
  lock: function() {
    if (this.locked === true) return;
    this.veilContainer.setAttribute("locked", "true");
    this.nodeInfo.container.setAttribute("locked", "true");
    this.detachMouseListeners();
    this.locked = true;
    this.emitEvent("locked");
  },

  /**
   * Start inspecting.
   * Unlock the current node (if any), and select any node being hovered.
   */
  unlock: function() {
    if (this.locked === false) return;
    this.veilContainer.removeAttribute("locked");
    this.nodeInfo.container.removeAttribute("locked");
    this.attachMouseListeners();
    this.locked = false;
    this.emitEvent("unlocked");
  },

  /**
   * Is the specified node highlightable?
   *
   * @param nsIDOMNode aNode
   *        the DOM element in question
   * @returns boolean
   *          True if the node is highlightable or false otherwise.
   */
  isNodeHighlightable: function Highlighter_isNodeHighlightable(aNode)
  {
    if (aNode.nodeType != aNode.ELEMENT_NODE) {
      return false;
    }
    let nodeName = aNode.nodeName.toLowerCase();
    return !INSPECTOR_INVISIBLE_ELEMENTS[nodeName];
  },
  /**
   * Build the veil:
   *
   * <vbox id="highlighter-veil-container">
   *   <box id="highlighter-veil-topbox" class="highlighter-veil"/>
   *   <hbox id="highlighter-veil-middlebox">
   *     <box id="highlighter-veil-leftbox" class="highlighter-veil"/>
   *     <box id="highlighter-veil-transparentbox"/>
   *     <box id="highlighter-veil-rightbox" class="highlighter-veil"/>
   *   </hbox>
   *   <box id="highlighter-veil-bottombox" class="highlighter-veil"/>
   * </vbox>
   *
   * @param nsIDOMElement aParent
   *        The container of the veil boxes.
   */

  buildVeil: function Highlighter_buildVeil(aParent)
  {
    // We will need to resize these boxes to surround a node.
    // See highlightRectangle().

    this.veilTopBox = this.chromeDoc.createElement("box");
    this.veilTopBox.id = "highlighter-veil-topbox";
    this.veilTopBox.className = "highlighter-veil";

    this.veilMiddleBox = this.chromeDoc.createElement("hbox");
    this.veilMiddleBox.id = "highlighter-veil-middlebox";

    this.veilLeftBox = this.chromeDoc.createElement("box");
    this.veilLeftBox.id = "highlighter-veil-leftbox";
    this.veilLeftBox.className = "highlighter-veil";

    this.veilTransparentBox = this.chromeDoc.createElement("box");
    this.veilTransparentBox.id = "highlighter-veil-transparentbox";

    // We don't need any references to veilRightBox and veilBottomBox.
    // These boxes are automatically resized (flex=1)

    let veilRightBox = this.chromeDoc.createElement("box");
    veilRightBox.id = "highlighter-veil-rightbox";
    veilRightBox.className = "highlighter-veil";

    let veilBottomBox = this.chromeDoc.createElement("box");
    veilBottomBox.id = "highlighter-veil-bottombox";
    veilBottomBox.className = "highlighter-veil";

    this.veilMiddleBox.appendChild(this.veilLeftBox);
    this.veilMiddleBox.appendChild(this.veilTransparentBox);
    this.veilMiddleBox.appendChild(veilRightBox);

    aParent.appendChild(this.veilTopBox);
    aParent.appendChild(this.veilMiddleBox);
    aParent.appendChild(veilBottomBox);
  },

  /**
   * Build the node Infobar.
   *
   * <box id="highlighter-nodeinfobar-container">
   *   <box id="Highlighter-nodeinfobar-arrow-top"/>
   *   <vbox id="highlighter-nodeinfobar">
   *     <label id="highlighter-nodeinfobar-tagname"/>
   *     <label id="highlighter-nodeinfobar-id"/>
   *     <vbox id="highlighter-nodeinfobar-classes"/>
   *   </vbox>
   *   <box id="Highlighter-nodeinfobar-arrow-bottom"/>
   * </box>
   *
   * @param nsIDOMElement aParent
   *        The container of the infobar.
   */
  buildInfobar: function Highlighter_buildInfobar(aParent)
  {
    let container = this.chromeDoc.createElement("box");
    container.id = "highlighter-nodeinfobar-container";
    container.setAttribute("position", "top");
    container.setAttribute("disabled", "true");

    let nodeInfobar = this.chromeDoc.createElement("hbox");
    nodeInfobar.id = "highlighter-nodeinfobar";

    let arrowBoxTop = this.chromeDoc.createElement("box");
    arrowBoxTop.className = "highlighter-nodeinfobar-arrow";
    arrowBoxTop.id = "highlighter-nodeinfobar-arrow-top";

    let arrowBoxBottom = this.chromeDoc.createElement("box");
    arrowBoxBottom.className = "highlighter-nodeinfobar-arrow";
    arrowBoxBottom.id = "highlighter-nodeinfobar-arrow-bottom";

    let tagNameLabel = this.chromeDoc.createElement("label");
    tagNameLabel.id = "highlighter-nodeinfobar-tagname";
    tagNameLabel.className = "plain";

    let idLabel = this.chromeDoc.createElement("label");
    idLabel.id = "highlighter-nodeinfobar-id";
    idLabel.className = "plain";

    let classesBox = this.chromeDoc.createElement("hbox");
    classesBox.id = "highlighter-nodeinfobar-classes";

    nodeInfobar.appendChild(tagNameLabel);
    nodeInfobar.appendChild(idLabel);
    nodeInfobar.appendChild(classesBox);
    container.appendChild(arrowBoxTop);
    container.appendChild(nodeInfobar);
    container.appendChild(arrowBoxBottom);

    aParent.appendChild(container);

    let barHeight = container.getBoundingClientRect().height;

    this.nodeInfo = {
      tagNameLabel: tagNameLabel,
      idLabel: idLabel,
      classesBox: classesBox,
      container: container,
      barHeight: barHeight,
    };
  },

  /**
   * Highlight a rectangular region.
   *
   * @param object aRect
   *        The rectangle region to highlight.
   * @returns boolean
   *          True if the rectangle was highlighted, false otherwise.
   */
  highlightRectangle: function Highlighter_highlightRectangle(aRect)
  {
    if (!aRect) {
      this.unhighlight();
      return;
    }

    let oldRect = this._contentRect;

    if (oldRect && aRect.top == oldRect.top && aRect.left == oldRect.left &&
        aRect.width == oldRect.width && aRect.height == oldRect.height) {
      return; // same rectangle
    }

    let aRectScaled = LayoutHelpers.getZoomedRect(this.win, aRect);

    if (aRectScaled.left >= 0 && aRectScaled.top >= 0 &&
        aRectScaled.width > 0 && aRectScaled.height > 0) {

      this.veilTransparentBox.style.visibility = "visible";

      // The bottom div and the right div are flexibles (flex=1).
      // We don't need to resize them.
      this.veilTopBox.style.height = aRectScaled.top + "px";
      this.veilLeftBox.style.width = aRectScaled.left + "px";
      this.veilMiddleBox.style.height = aRectScaled.height + "px";
      this.veilTransparentBox.style.width = aRectScaled.width + "px";

      this._highlighting = true;
    } else {
      this.unhighlight();
    }

    this._contentRect = aRect; // save orig (non-scaled) rect
    this._highlightRect = aRectScaled; // and save the scaled rect.

    return;
  },

  /**
   * Clear the highlighter surface.
   */
  unhighlight: function Highlighter_unhighlight()
  {
    this._highlighting = false;
    this.veilMiddleBox.style.height = 0;
    this.veilTransparentBox.style.width = 0;
    this.veilTransparentBox.style.visibility = "hidden";
  },

  /**
   * Update node information (tagName#id.class) 
   */
  updateInfobar: function Highlighter_updateInfobar()
  {
    // Tag name
    this.nodeInfo.tagNameLabel.textContent = this.node.tagName;

    // ID
    this.nodeInfo.idLabel.textContent = this.node.id ? "#" + this.node.id : "";

    // Classes
    let classes = this.nodeInfo.classesBox;
    while (classes.hasChildNodes()) {
      classes.removeChild(classes.firstChild);
    }

    if (this.node.className) {
      let fragment = this.chromeDoc.createDocumentFragment();
      for (let i = 0; i < this.node.classList.length; i++) {
        let classLabel = this.chromeDoc.createElement("label");
        classLabel.className = "highlighter-nodeinfobar-class plain";
        classLabel.textContent = "." + this.node.classList[i];
        fragment.appendChild(classLabel);
      }
      classes.appendChild(fragment);
    }
  },

  /**
   * Move the Infobar to the right place in the highlighter.
   */
  moveInfobar: function Highlighter_moveInfobar()
  {
    if (this._highlightRect) {
      let winHeight = this.win.innerHeight * this.zoom;
      let winWidth = this.win.innerWidth * this.zoom;

      let rect = {top: this._highlightRect.top,
                  left: this._highlightRect.left,
                  width: this._highlightRect.width,
                  height: this._highlightRect.height};

      rect.top = Math.max(rect.top, 0);
      rect.left = Math.max(rect.left, 0);
      rect.width = Math.max(rect.width, 0);
      rect.height = Math.max(rect.height, 0);

      rect.top = Math.min(rect.top, winHeight);
      rect.left = Math.min(rect.left, winWidth);

      this.nodeInfo.container.removeAttribute("disabled");
      // Can the bar be above the node?
      if (rect.top < this.nodeInfo.barHeight) {
        // No. Can we move the toolbar under the node?
        if (rect.top + rect.height +
            this.nodeInfo.barHeight > winHeight) {
          // No. Let's move it inside.
          this.nodeInfo.container.style.top = rect.top + "px";
          this.nodeInfo.container.setAttribute("position", "overlap");
        } else {
          // Yes. Let's move it under the node.
          this.nodeInfo.container.style.top = rect.top + rect.height + "px";
          this.nodeInfo.container.setAttribute("position", "bottom");
        }
      } else {
        // Yes. Let's move it on top of the node.
        this.nodeInfo.container.style.top =
          rect.top - this.nodeInfo.barHeight + "px";
        this.nodeInfo.container.setAttribute("position", "top");
      }

      let barWidth = this.nodeInfo.container.getBoundingClientRect().width;
      let left = rect.left + rect.width / 2 - barWidth / 2;

      // Make sure the whole infobar is visible
      if (left < 0) {
        left = 0;
        this.nodeInfo.container.setAttribute("hide-arrow", "true");
      } else {
        if (left + barWidth > winWidth) {
          left = winWidth - barWidth;
          this.nodeInfo.container.setAttribute("hide-arrow", "true");
        } else {
          this.nodeInfo.container.removeAttribute("hide-arrow");
        }
      }
      this.nodeInfo.container.style.left = left + "px";
    } else {
      this.nodeInfo.container.style.left = "0";
      this.nodeInfo.container.style.top = "0";
      this.nodeInfo.container.setAttribute("position", "top");
      this.nodeInfo.container.setAttribute("hide-arrow", "true");
    }
  },

  /**
   * Store page zoom factor.
   */
  computeZoomFactor: function Highlighter_computeZoomFactor() {
    this.zoom =
      this.win.QueryInterface(Components.interfaces.nsIInterfaceRequestor)
      .getInterface(Components.interfaces.nsIDOMWindowUtils)
      .screenPixelsPerCSSPixel;
  },

  /////////////////////////////////////////////////////////////////////////
  //// Event Emitter Mechanism

  addListener: function Highlighter_addListener(aEvent, aListener)
  {
    if (!(aEvent in this.events))
      this.events[aEvent] = [];
    this.events[aEvent].push(aListener);
  },

  removeListener: function Highlighter_removeListener(aEvent, aListener)
  {
    if (!(aEvent in this.events))
      return;
    let idx = this.events[aEvent].indexOf(aListener);
    if (idx > -1)
      this.events[aEvent].splice(idx, 1);
  },

  emitEvent: function Highlighter_emitEvent(aEvent, aArgv)
  {
    if (!(aEvent in this.events))
      return;

    let listeners = this.events[aEvent];
    let highlighter = this;
    listeners.forEach(function(aListener) {
      try {
        aListener.apply(highlighter, aArgv);
      } catch(e) {}
    });
  },

  removeAllListeners: function Highlighter_removeAllIsteners()
  {
    for (let event in this.events) {
      delete this.events[event];
    }
  },

  /////////////////////////////////////////////////////////////////////////
  //// Event Handling

  attachMouseListeners: function Highlighter_attachMouseListeners()
  {
    this.browser.addEventListener("mousemove", this, true);
    this.browser.addEventListener("click", this, true);
    this.browser.addEventListener("dblclick", this, true);
    this.browser.addEventListener("mousedown", this, true);
    this.browser.addEventListener("mouseup", this, true);
  },

  detachMouseListeners: function Highlighter_detachMouseListeners()
  {
    this.browser.removeEventListener("mousemove", this, true);
    this.browser.removeEventListener("click", this, true);
    this.browser.removeEventListener("dblclick", this, true);
    this.browser.removeEventListener("mousedown", this, true);
    this.browser.removeEventListener("mouseup", this, true);
  },

  attachPageListeners: function Highlighter_attachPageListeners()
  {
    this.browser.addEventListener("resize", this, true);
    this.browser.addEventListener("scroll", this, true);
  },

  detachPageListeners: function Highlighter_detachPageListeners()
  {
    this.browser.removeEventListener("resize", this, true);
    this.browser.removeEventListener("scroll", this, true);
  },

  attachKeysListeners: function Highlighter_attachKeysListeners()
  {
    this.browser.addEventListener("keypress", this, true);
    this.highlighterContainer.addEventListener("keypress", this, true);
  },

  detachKeysListeners: function Highlighter_detachKeysListeners()
  {
    this.browser.removeEventListener("keypress", this, true);
    this.highlighterContainer.removeEventListener("keypress", this, true);
  },

  /**
   * Generic event handler.
   *
   * @param nsIDOMEvent aEvent
   *        The DOM event object.
   */
  handleEvent: function Highlighter_handleEvent(aEvent)
  {
    switch (aEvent.type) {
      case "click":
        this.handleClick(aEvent);
        break;
      case "mousemove":
        this.handleMouseMove(aEvent);
        break;
      case "resize":
      case "scroll":
        this.computeZoomFactor();
        this.brieflyDisableTransitions();
        this.invalidateSize();
        break;
      case "dblclick":
      case "mousedown":
      case "mouseup":
        aEvent.stopPropagation();
        aEvent.preventDefault();
        break;
        break;
      case "keypress":
        switch (aEvent.keyCode) {
          case this.chromeWin.KeyEvent.DOM_VK_RETURN:
            this.locked ? this.unlock() : this.lock();
            aEvent.preventDefault();
            aEvent.stopPropagation();
            break;
          case this.chromeWin.KeyEvent.DOM_VK_LEFT:
            let node;
            if (this.node) {
              node = this.node.parentNode;
            } else {
              node = this.defaultSelection;
            }
            if (node && this.isNodeHighlightable(node)) {
              this.highlight(node);
            }
            aEvent.preventDefault();
            aEvent.stopPropagation();
            break;
          case this.chromeWin.KeyEvent.DOM_VK_RIGHT:
            if (this.node) {
              // Find the first child that is highlightable.
              for (let i = 0; i < this.node.childNodes.length; i++) {
                node = this.node.childNodes[i];
                if (node && this.isNodeHighlightable(node)) {
                  break;
                }
              }
            } else {
              node = this.defaultSelection;
            }
            if (node && this.isNodeHighlightable(node)) {
              this.highlight(node, true);
            }
            aEvent.preventDefault();
            aEvent.stopPropagation();
            break;
          case this.chromeWin.KeyEvent.DOM_VK_UP:
            if (this.node) {
              // Find a previous sibling that is highlightable.
              node = this.node.previousSibling;
              while (node && !this.isNodeHighlightable(node)) {
                node = node.previousSibling;
              }
            } else {
              node = this.defaultSelection;
            }
            if (node && this.isNodeHighlightable(node)) {
              this.highlight(node, true);
            }
            aEvent.preventDefault();
            aEvent.stopPropagation();
            break;
          case this.chromeWin.KeyEvent.DOM_VK_DOWN:
            if (this.node) {
              // Find a next sibling that is highlightable.
              node = this.node.nextSibling;
              while (node && !this.isNodeHighlightable(node)) {
                node = node.nextSibling;
              }
            } else {
              node = this.defaultSelection;
            }
            if (node && this.isNodeHighlightable(node)) {
              this.highlight(node, true);
            }
            aEvent.preventDefault();
            aEvent.stopPropagation();
            break;
        }
    }
  },

  /**
   * Disable the CSS transitions for a short time to avoid laggy animations
   * during scrolling or resizing.
   */
  brieflyDisableTransitions: function Highlighter_brieflyDisableTransitions()
  {
   if (this.transitionDisabler) {
     this.chromeWin.clearTimeout(this.transitionDisabler);
   } else {
     this.veilContainer.setAttribute("disable-transitions", "true");
     this.nodeInfo.container.setAttribute("disable-transitions", "true");
   }
   this.transitionDisabler =
     this.chromeWin.setTimeout(function() {
       this.veilContainer.removeAttribute("disable-transitions");
       this.nodeInfo.container.removeAttribute("disable-transitions");
       this.transitionDisabler = null;
     }.bind(this), 500);
  },

  /**
   * Handle clicks.
   *
   * @param nsIDOMEvent aEvent
   *        The DOM event.
   */
  handleClick: function Highlighter_handleClick(aEvent)
  {
    // Stop inspection when the user clicks on a node.
    if (aEvent.button == 0) {
      let win = aEvent.target.ownerDocument.defaultView;
      this.lock();
      win.focus();
    }
    aEvent.preventDefault();
    aEvent.stopPropagation();
  },

  /**
   * Handle mousemoves in panel.
   *
   * @param nsiDOMEvent aEvent
   *        The MouseEvent triggering the method.
   */
  handleMouseMove: function Highlighter_handleMouseMove(aEvent)
  {
    let element = LayoutHelpers.getElementFromPoint(aEvent.target.ownerDocument,
      aEvent.clientX, aEvent.clientY);
    if (element && element != this.node) {
      this.highlight(element);
    }
  },
};

///////////////////////////////////////////////////////////////////////////
