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
 * The Original Code is Bookmarks Sync.
 *
 * The Initial Developer of the Original Code is
 * the Mozilla Foundation.
 * Portions created by the Initial Developer are Copyright (C) 2007
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *   Dan Mills <thunder@mozilla.com>
 *   Jono DiCarlo <jdicarlo@mozilla.org>
 *   Anant Narayanan <anant@kix.in>
 *   Philipp von Weitershausen <philipp@weitershausen.de>
 *   Richard Newman <rnewman@mozilla.com>
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

const EXPORTED_SYMBOLS = ['BookmarksEngine', "PlacesItem", "Bookmark",
                          "BookmarkFolder", "BookmarkQuery",
                          "Livemark", "BookmarkSeparator"];

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cu = Components.utils;

const ALLBOOKMARKS_ANNO    = "AllBookmarks";
const DESCRIPTION_ANNO     = "bookmarkProperties/description";
const SIDEBAR_ANNO         = "bookmarkProperties/loadInSidebar";
const FEEDURI_ANNO         = "livemark/feedURI";
const SITEURI_ANNO         = "livemark/siteURI";
const MOBILEROOT_ANNO      = "mobile/bookmarksRoot";
const MOBILE_ANNO          = "MobileBookmarks";
const EXCLUDEBACKUP_ANNO   = "places/excludeFromBackup";
const SMART_BOOKMARKS_ANNO = "Places/SmartBookmark";
const PARENT_ANNO          = "sync/parent";
const ORGANIZERQUERY_ANNO  = "PlacesOrganizer/OrganizerQuery";
const ANNOS_TO_TRACK = [DESCRIPTION_ANNO, SIDEBAR_ANNO,
                        FEEDURI_ANNO, SITEURI_ANNO];

const SERVICE_NOT_SUPPORTED = "Service not supported on this platform";
const FOLDER_SORTINDEX = 1000000;

Cu.import("resource://gre/modules/PlacesUtils.jsm");
Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://services-sync/engines.js");
Cu.import("resource://services-sync/record.js");
Cu.import("resource://services-sync/async.js");
Cu.import("resource://services-sync/util.js");

Cu.import("resource://services-sync/main.js");      // For access to Service.

function PlacesItem(collection, id, type) {
  CryptoWrapper.call(this, collection, id);
  this.type = type || "item";
}
PlacesItem.prototype = {
  decrypt: function PlacesItem_decrypt(keyBundle) {
    // Do the normal CryptoWrapper decrypt, but change types before returning
    let clear = CryptoWrapper.prototype.decrypt.call(this, keyBundle);

    // Convert the abstract places item to the actual object type
    if (!this.deleted)
      this.__proto__ = this.getTypeObject(this.type).prototype;

    return clear;
  },

  getTypeObject: function PlacesItem_getTypeObject(type) {
    switch (type) {
      case "bookmark":
      case "microsummary":
        return Bookmark;
      case "query":
        return BookmarkQuery;
      case "folder":
        return BookmarkFolder;
      case "livemark":
        return Livemark;
      case "separator":
        return BookmarkSeparator;
      case "item":
        return PlacesItem;
    }
    throw "Unknown places item object type: " + type;
  },

  __proto__: CryptoWrapper.prototype,
  _logName: "Record.PlacesItem",
};

Utils.deferGetSet(PlacesItem, "cleartext", ["hasDupe", "parentid", "parentName",
                                            "type"]);

function Bookmark(collection, id, type) {
  PlacesItem.call(this, collection, id, type || "bookmark");
}
Bookmark.prototype = {
  __proto__: PlacesItem.prototype,
  _logName: "Record.Bookmark",
};

Utils.deferGetSet(Bookmark, "cleartext", ["title", "bmkUri", "description",
  "loadInSidebar", "tags", "keyword"]);

function BookmarkQuery(collection, id) {
  Bookmark.call(this, collection, id, "query");
}
BookmarkQuery.prototype = {
  __proto__: Bookmark.prototype,
  _logName: "Record.BookmarkQuery",
};

Utils.deferGetSet(BookmarkQuery, "cleartext", ["folderName",
                                               "queryId"]);

function BookmarkFolder(collection, id, type) {
  PlacesItem.call(this, collection, id, type || "folder");
}
BookmarkFolder.prototype = {
  __proto__: PlacesItem.prototype,
  _logName: "Record.Folder",
};

Utils.deferGetSet(BookmarkFolder, "cleartext", ["description", "title",
                                                "children"]);

function Livemark(collection, id) {
  BookmarkFolder.call(this, collection, id, "livemark");
}
Livemark.prototype = {
  __proto__: BookmarkFolder.prototype,
  _logName: "Record.Livemark",
};

Utils.deferGetSet(Livemark, "cleartext", ["siteUri", "feedUri"]);

function BookmarkSeparator(collection, id) {
  PlacesItem.call(this, collection, id, "separator");
}
BookmarkSeparator.prototype = {
  __proto__: PlacesItem.prototype,
  _logName: "Record.Separator",
};

Utils.deferGetSet(BookmarkSeparator, "cleartext", "pos");


function archiveBookmarks() {
  // Some nightly builds of 3.7 don't have this function
  try {
    PlacesUtils.archiveBookmarksFile(null, true);
  }
  catch(ex) {}
}

let kSpecialIds = {

  // Special IDs. Note that mobile can attempt to create a record on
  // dereference; special accessors are provided to prevent recursion within
  // observers.
  guids: ["menu", "places", "tags", "toolbar", "unfiled", "mobile"],

  // Create the special mobile folder to store mobile bookmarks.
  createMobileRoot: function createMobileRoot() {
    let root = PlacesUtils.placesRootId;
    let mRoot = PlacesUtils.bookmarks.createFolder(root, "mobile", -1);
    PlacesUtils.annotations.setItemAnnotation(
      mRoot, MOBILEROOT_ANNO, 1, 0, PlacesUtils.annotations.EXPIRE_NEVER);
    PlacesUtils.annotations.setItemAnnotation(
      mRoot, EXCLUDEBACKUP_ANNO, 1, 0, PlacesUtils.annotations.EXPIRE_NEVER);
    return mRoot;
  },

  findMobileRoot: function findMobileRoot(create) {
    // Use the (one) mobile root if it already exists.
    let root = PlacesUtils.annotations.getItemsWithAnnotation(MOBILEROOT_ANNO, {});
    if (root.length != 0)
      return root[0];

    if (create)
      return this.createMobileRoot();

    return null;
  },

  // Accessors for IDs.
  isSpecialGUID: function isSpecialGUID(g) {
    return this.guids.indexOf(g) != -1;
  },

  specialIdForGUID: function specialIdForGUID(guid, create) {
    if (guid == "mobile") {
      return this.findMobileRoot(create);
    }
    return this[guid];
  },

  // Don't bother creating mobile: if it doesn't exist, this ID can't be it!
  specialGUIDForId: function specialGUIDForId(id) {
    for each (let guid in this.guids)
      if (this.specialIdForGUID(guid, false) == id)
        return guid;
    return null;
  },

  get menu()    PlacesUtils.bookmarksMenuFolderId,
  get places()  PlacesUtils.placesRootId,
  get tags()    PlacesUtils.tagsFolderId,
  get toolbar() PlacesUtils.toolbarFolderId,
  get unfiled() PlacesUtils.unfiledBookmarksFolderId,
  get mobile()  this.findMobileRoot(true),
};

function BookmarksEngine() {
  SyncEngine.call(this, "Bookmarks");
}
BookmarksEngine.prototype = {
  __proto__: SyncEngine.prototype,
  _recordObj: PlacesItem,
  _storeObj: BookmarksStore,
  _trackerObj: BookmarksTracker,
  version: 2,

  _sync: function _sync() {
    let engine = this;
    let batchEx = null;

    // Try running sync in batch mode
    PlacesUtils.bookmarks.runInBatchMode({
      runBatched: function wrappedSync() {
        try {
          SyncEngine.prototype._sync.call(engine);
        }
        catch(ex) {
          batchEx = ex;
        }
      }
    }, null);

    // Expose the exception if something inside the batch failed
    if (batchEx!= null) {
      throw batchEx;
    }
  },

  _syncStartup: function _syncStart() {
    SyncEngine.prototype._syncStartup.call(this);

    // For first-syncs, make a backup for the user to restore
    if (this.lastSync == 0)
      archiveBookmarks();

    // Lazily create a mapping of folder titles and separator positions to GUID
    this.__defineGetter__("_lazyMap", function() {
      delete this._lazyMap;

      let lazyMap = {};
      for (let guid in this._store.getAllIDs()) {
        // Figure out what key to store the mapping
        let key;
        let id = this._store.idForGUID(guid);
        switch (PlacesUtils.bookmarks.getItemType(id)) {
          case PlacesUtils.bookmarks.TYPE_BOOKMARK:

            // Smart bookmarks map to their annotation value.
            let queryId;
            try {
              queryId = PlacesUtils.annotations.getItemAnnotation(
                id, SMART_BOOKMARKS_ANNO);
            } catch(ex) {}
            
            if (queryId)
              key = "q" + queryId;
            else
              key = "b" + PlacesUtils.bookmarks.getBookmarkURI(id).spec + ":" +
                    PlacesUtils.bookmarks.getItemTitle(id);
            break;
          case PlacesUtils.bookmarks.TYPE_FOLDER:
            key = "f" + PlacesUtils.bookmarks.getItemTitle(id);
            break;
          case PlacesUtils.bookmarks.TYPE_SEPARATOR:
            key = "s" + PlacesUtils.bookmarks.getItemIndex(id);
            break;
          default:
            continue;
        }

        // The mapping is on a per parent-folder-name basis
        let parent = PlacesUtils.bookmarks.getFolderIdForItem(id);
        if (parent <= 0)
          continue;

        let parentName = PlacesUtils.bookmarks.getItemTitle(parent);
        if (lazyMap[parentName] == null)
          lazyMap[parentName] = {};

        // If the entry already exists, remember that there are explicit dupes
        let entry = new String(guid);
        entry.hasDupe = lazyMap[parentName][key] != null;

        // Remember this item's guid for its parent-name/key pair
        lazyMap[parentName][key] = entry;
        this._log.trace("Mapped: " + [parentName, key, entry, entry.hasDupe]);
      }

      // Expose a helper function to get a dupe guid for an item
      return this._lazyMap = function(item) {
        // Figure out if we have something to key with
        let key;
        let altKey;
        switch (item.type) {
          case "query":
            // Prior to Bug 610501, records didn't carry their Smart Bookmark
            // anno, so we won't be able to dupe them correctly. This altKey
            // hack should get them to dupe correctly.
            if (item.queryId) {
              key = "q" + item.queryId;
              altKey = "b" + item.bmkUri + ":" + item.title;
              break;
            }
            // No queryID? Fall through to the regular bookmark case.
          case "bookmark":
          case "microsummary":
            key = "b" + item.bmkUri + ":" + item.title;
            break;
          case "folder":
          case "livemark":
            key = "f" + item.title;
            break;
          case "separator":
            key = "s" + item.pos;
            break;
          default:
            return;
        }

        // Give the guid if we have the matching pair
        this._log.trace("Finding mapping: " + item.parentName + ", " + key);
        let parent = lazyMap[item.parentName];
        
        if (!parent) {
          this._log.trace("No parent => no dupe.");
          return undefined;
        }
          
        let dupe = parent[key];
        
        if (dupe) {
          this._log.trace("Mapped dupe: " + dupe);
          return dupe;
        }
        
        if (altKey) {
          dupe = parent[altKey];
          if (dupe) {
            this._log.trace("Mapped dupe using altKey " + altKey + ": " + dupe);
            return dupe;
          }
        }
        
        this._log.trace("No dupe found for key " + key + "/" + altKey + ".");
        return undefined;
      };
    });

    this._store._childrenToOrder = {};
  },

  _processIncoming: function _processIncoming() {
    try {
      SyncEngine.prototype._processIncoming.call(this);
    } finally {
      // Reorder children.
      this._tracker.ignoreAll = true;
      this._store._orderChildren();
      this._tracker.ignoreAll = false;
      delete this._store._childrenToOrder;
    }
  },

  _syncFinish: function _syncFinish() {
    SyncEngine.prototype._syncFinish.call(this);
    delete this._lazyMap;
    this._tracker._ensureMobileQuery();
  },

  _createRecord: function _createRecord(id) {
    // Create the record like normal but mark it as having dupes if necessary
    let record = SyncEngine.prototype._createRecord.call(this, id);
    let entry = this._lazyMap(record);
    if (entry != null && entry.hasDupe)
      record.hasDupe = true;
    return record;
  },

  _findDupe: function _findDupe(item) {
    // Don't bother finding a dupe if the incoming item has duplicates
    if (item.hasDupe)
      return;
    return this._lazyMap(item);
  },

  _handleDupe: function _handleDupe(item, dupeId) {
    // Always change the local GUID to the incoming one.
    this._store.changeItemID(dupeId, item.id);
    this._deleteId(dupeId);
    this._tracker.addChangedID(item.id, 0);
    if (item.parentid) {
      this._tracker.addChangedID(item.parentid, 0);
    }
  }
};

function BookmarksStore(name) {
  Store.call(this, name);

  // Explicitly nullify our references to our cached services so we don't leak
  Svc.Obs.add("places-shutdown", function() {
    for each ([query, stmt] in Iterator(this._stmts))
      stmt.finalize();
  }, this);
}
BookmarksStore.prototype = {
  __proto__: Store.prototype,

  itemExists: function BStore_itemExists(id) {
    return this.idForGUID(id, true) > 0;
  },
  
  /*
   * If the record is a tag query, rewrite it to refer to the local tag ID.
   * 
   * Otherwise, just return.
   */
  preprocessTagQuery: function preprocessTagQuery(record) {
    if (record.type != "query" ||
        record.bmkUri == null ||
        record.folderName == null)
      return;
    
    // Yes, this works without chopping off the "place:" prefix.
    let uri           = record.bmkUri
    let queriesRef    = {};
    let queryCountRef = {};
    let optionsRef    = {};
    PlacesUtils.history.queryStringToQueries(uri, queriesRef, queryCountRef,
                                             optionsRef);
    
    // We only process tag URIs.
    if (optionsRef.value.resultType != optionsRef.value.RESULTS_AS_TAG_CONTENTS)
      return;
    
    // Tag something to ensure that the tag exists.
    let tag = record.folderName;
    let dummyURI = Utils.makeURI("about:weave#BStore_preprocess");
    PlacesUtils.tagging.tagURI(dummyURI, [tag]);

    // Look for the id of the tag, which might just have been added.
    let tags = this._getNode(PlacesUtils.tagsFolderId);
    if (!(tags instanceof Ci.nsINavHistoryQueryResultNode)) {
      this._log.debug("tags isn't an nsINavHistoryQueryResultNode; aborting.");
      return;
    }

    tags.containerOpen = true;
    try {
      for (let i = 0; i < tags.childCount; i++) {
        let child = tags.getChild(i);
        if (child.title == tag) {
          // Found the tag, so fix up the query to use the right id.
          this._log.debug("Tag query folder: " + tag + " = " + child.itemId);
          
          this._log.trace("Replacing folders in: " + uri);
          for each (let q in queriesRef.value)
            q.setFolders([child.itemId], 1);
          
          record.bmkUri = PlacesUtils.history.queriesToQueryString(
            queriesRef.value, queryCountRef.value, optionsRef.value);
          return;
        }
      }
    }
    finally {
      tags.containerOpen = false;
    }
  },
  
  applyIncoming: function BStore_applyIncoming(record) {
    // Don't bother with pre and post-processing for deletions.
    if (record.deleted) {
      Store.prototype.applyIncoming.call(this, record);
      return;
    }

    // For special folders we're only interested in child ordering.
    if ((record.id in kSpecialIds) && record.children) {
      this._log.debug("Processing special node: " + record.id);
      // Reorder children later
      this._childrenToOrder[record.id] = record.children;
      return;
    }

    // Preprocess the record before doing the normal apply.
    this.preprocessTagQuery(record);

    // Figure out the local id of the parent GUID if available
    let parentGUID = record.parentid;
    if (!parentGUID) {
      throw "Record " + record.id + " has invalid parentid: " + parentGUID;
    }

    let parentId = this.idForGUID(parentGUID);
    if (parentId > 0) {
      // Save the parent id for modifying the bookmark later
      record._parent = parentId;
      record._orphan = false;
    } else {
      this._log.trace("Record " + record.id +
                      " is an orphan: could not find parent " + parentGUID);
      record._orphan = true;
    }

    // Do the normal processing of incoming records
    Store.prototype.applyIncoming.call(this, record);

    // Do some post-processing if we have an item
    let itemId = this.idForGUID(record.id);
    if (itemId > 0) {
      // Move any children that are looking for this folder as a parent
      if (record.type == "folder") {
        this._reparentOrphans(itemId);
        // Reorder children later
        if (record.children)
          this._childrenToOrder[record.id] = record.children;
      }

      // Create an annotation to remember that it needs reparenting.
      if (record._orphan) {
        PlacesUtils.annotations.setItemAnnotation(
          itemId, PARENT_ANNO, parentGUID, 0,
          PlacesUtils.annotations.EXPIRE_NEVER);
      }
    }
  },

  /**
   * Find all ids of items that have a given value for an annotation
   */
  _findAnnoItems: function BStore__findAnnoItems(anno, val) {
    return PlacesUtils.annotations.getItemsWithAnnotation(anno, {})
                      .filter(function(id) {
      return PlacesUtils.annotations.getItemAnnotation(id, anno) == val;
    });
  },

  /**
   * For the provided parent item, attach its children to it
   */
  _reparentOrphans: function _reparentOrphans(parentId) {
    // Find orphans and reunite with this folder parent
    let parentGUID = this.GUIDForId(parentId);
    let orphans = this._findAnnoItems(PARENT_ANNO, parentGUID);

    this._log.debug("Reparenting orphans " + orphans + " to " + parentId);
    orphans.forEach(function(orphan) {
      // Move the orphan to the parent and drop the missing parent annotation
      if (this._reparentItem(orphan, parentId)) {
        PlacesUtils.annotations.removeItemAnnotation(orphan, PARENT_ANNO);
      }
    }, this);
  },

  _reparentItem: function _reparentItem(itemId, parentId) {
    this._log.trace("Attempting to move item " + itemId + " to new parent " +
                    parentId);
    try {
      if (parentId > 0) {
        PlacesUtils.bookmarks.moveItem(itemId, parentId,
                                       PlacesUtils.bookmarks.DEFAULT_INDEX);
        return true;
      }
    } catch(ex) {
      this._log.debug("Failed to reparent item. " + Utils.exceptionStr(ex));
    }
    return false;
  },

  // Turn a record's nsINavBookmarksService constant and other attributes into
  // a granular type for comparison.
  _recordType: function _recordType(itemId) {
    let bms  = PlacesUtils.bookmarks;
    let type = bms.getItemType(itemId);

    switch (type) {
      case bms.TYPE_FOLDER:
        if (PlacesUtils.itemIsLivemark(itemId))
          return "livemark";
        return "folder";

      case bms.TYPE_BOOKMARK:
        let bmkUri = bms.getBookmarkURI(itemId).spec;
        if (bmkUri.search(/^place:/) == 0)
          return "query";
        return "bookmark";

      case bms.TYPE_SEPARATOR:
        return "separator";

      default:
        return null;
    }
  },

  create: function BStore_create(record) {
    // Default to unfiled if we don't have the parent yet.
    
    // Valid parent IDs are all positive integers. Other values -- undefined,
    // null, -1 -- all compare false for > 0, so this catches them all. We
    // don't just use <= without the !, because undefined and null compare
    // false for that, too!
    if (!(record._parent > 0)) {
      this._log.debug("Parent is " + record._parent + "; reparenting to unfiled.");
      record._parent = kSpecialIds.unfiled;
    }

    let newId;
    switch (record.type) {
    case "bookmark":
    case "query":
    case "microsummary": {
      let uri = Utils.makeURI(record.bmkUri);
      newId = PlacesUtils.bookmarks.insertBookmark(
        record._parent, uri, PlacesUtils.bookmarks.DEFAULT_INDEX, record.title);
      this._log.debug("created bookmark " + newId + " under " + record._parent
                      + " as " + record.title + " " + record.bmkUri);

      // Smart bookmark annotations are strings.
      if (record.queryId) {
        PlacesUtils.annotations.setItemAnnotation(
          newId, SMART_BOOKMARKS_ANNO, record.queryId, 0,
          PlacesUtils.annotations.EXPIRE_NEVER);
      }

      if (Utils.isArray(record.tags)) {
        this._tagURI(uri, record.tags);
      }
      PlacesUtils.bookmarks.setKeywordForBookmark(newId, record.keyword);
      if (record.description) {
        PlacesUtils.annotations.setItemAnnotation(
          newId, DESCRIPTION_ANNO, record.description, 0,
          PlacesUtils.annotations.EXPIRE_NEVER);
      }

      if (record.loadInSidebar) {
        PlacesUtils.annotations.setItemAnnotation(
          newId, SIDEBAR_ANNO, true, 0,
          PlacesUtils.annotations.EXPIRE_NEVER);
      }

    } break;
    case "folder":
      newId = PlacesUtils.bookmarks.createFolder(
        record._parent, record.title, PlacesUtils.bookmarks.DEFAULT_INDEX);
      this._log.debug("created folder " + newId + " under " + record._parent
                      + " as " + record.title);

      if (record.description) {
        PlacesUtils.annotations.setItemAnnotation(
          newId, DESCRIPTION_ANNO, record.description, 0,
          PlacesUtils.annotations.EXPIRE_NEVER);
      }

      // record.children will be dealt with in _orderChildren.
      break;
    case "livemark":
      let siteURI = null;
      if (!record.feedUri) {
        this._log.debug("No feed URI: skipping livemark record " + record.id);
        return;
      }
      if (PlacesUtils.itemIsLivemark(record._parent)) {
        this._log.debug("Invalid parent: skipping livemark record " + record.id);
        return;
      }

      if (record.siteUri != null)
        siteURI = Utils.makeURI(record.siteUri);

      // Use createLivemarkFolderOnly, not createLivemark, to avoid it
      // automatically updating during a sync.
      newId = PlacesUtils.livemarks.createLivemarkFolderOnly(
        record._parent, record.title, siteURI, Utils.makeURI(record.feedUri),
        PlacesUtils.bookmarks.DEFAULT_INDEX);
      this._log.debug("Created livemark " + newId + " under " + record._parent +
                      " as " + record.title + ", " + record.siteUri + ", " + 
                      record.feedUri + ", GUID " + record.id);
      break;
    case "separator":
      newId = PlacesUtils.bookmarks.insertSeparator(
        record._parent, PlacesUtils.bookmarks.DEFAULT_INDEX);
      this._log.debug("created separator " + newId + " under " + record._parent);
      break;
    case "item":
      this._log.debug(" -> got a generic places item.. do nothing?");
      return;
    default:
      this._log.error("_create: Unknown item type: " + record.type);
      return;
    }

    this._log.trace("Setting GUID of new item " + newId + " to " + record.id);
    this._setGUID(newId, record.id);
  },

  // Factored out of `remove` to avoid redundant DB queries when the Places ID
  // is already known.
  removeById: function removeById(itemId, guid) {
    let type = PlacesUtils.bookmarks.getItemType(itemId);

    switch (type) {
    case PlacesUtils.bookmarks.TYPE_BOOKMARK:
      this._log.debug("  -> removing bookmark " + guid);
      PlacesUtils.bookmarks.removeItem(itemId);
      break;
    case PlacesUtils.bookmarks.TYPE_FOLDER:
      this._log.debug("  -> removing folder " + guid);
      PlacesUtils.bookmarks.removeItem(itemId);
      break;
    case PlacesUtils.bookmarks.TYPE_SEPARATOR:
      this._log.debug("  -> removing separator " + guid);
      PlacesUtils.bookmarks.removeItem(itemId);
      break;
    default:
      this._log.error("remove: Unknown item type: " + type);
      break;
    }
  },

  remove: function BStore_remove(record) {
    let itemId = this.idForGUID(record.id);
    if (itemId <= 0) {
      this._log.debug("Item " + record.id + " already removed");
      return;
    }
    this.removeById(itemId, record.id);
  },

  update: function BStore_update(record) {
    let itemId = this.idForGUID(record.id);

    if (itemId <= 0) {
      this._log.debug("Skipping update for unknown item: " + record.id);
      return;
    }

    // Two items are the same type if they have the same ItemType in Places,
    // and also share some key characteristics (e.g., both being livemarks).
    // We figure this out by examining the item to find the equivalent granular
    // (string) type.
    // If they're not the same type, we can't just update attributes. Delete
    // then recreate the record instead.
    let localItemType    = this._recordType(itemId);
    let remoteRecordType = record.type;
    this._log.trace("Local type: " + localItemType + ". " +
                    "Remote type: " + remoteRecordType + ".");

    if (localItemType != remoteRecordType) {
      this._log.debug("Local record and remote record differ in type. " +
                      "Deleting and recreating.");
      this.removeById(itemId, record.id);
      this.create(record);
      return;
    }

    this._log.trace("Updating " + record.id + " (" + itemId + ")");

    // Move the bookmark to a new parent or new position if necessary
    if (record._parent > 0 &&
        PlacesUtils.bookmarks.getFolderIdForItem(itemId) != record._parent) {
      this._reparentItem(itemId, record._parent);
    }

    for (let [key, val] in Iterator(record.cleartext)) {
      switch (key) {
      case "title":
        PlacesUtils.bookmarks.setItemTitle(itemId, val);
        break;
      case "bmkUri":
        PlacesUtils.bookmarks.changeBookmarkURI(itemId, Utils.makeURI(val));
        break;
      case "tags":
        if (Utils.isArray(val)) {
          this._tagURI(PlacesUtils.bookmarks.getBookmarkURI(itemId), val);
        }
        break;
      case "keyword":
        PlacesUtils.bookmarks.setKeywordForBookmark(itemId, val);
        break;
      case "description":
        if (val) {
          PlacesUtils.annotations.setItemAnnotation(
            itemId, DESCRIPTION_ANNO, val, 0,
            PlacesUtils.annotations.EXPIRE_NEVER);
        } else {
          PlacesUtils.annotations.removeItemAnnotation(itemId, DESCRIPTION_ANNO);
        }
        break;
      case "loadInSidebar":
        if (val) {
          PlacesUtils.annotations.setItemAnnotation(
            itemId, SIDEBAR_ANNO, true, 0,
            PlacesUtils.annotations.EXPIRE_NEVER);
        } else {
          PlacesUtils.annotations.removeItemAnnotation(itemId, SIDEBAR_ANNO);
        }
        break;
      case "queryId":
        PlacesUtils.annotations.setItemAnnotation(
          itemId, SMART_BOOKMARKS_ANNO, val, 0,
          PlacesUtils.annotations.EXPIRE_NEVER);
        break;
      case "siteUri":
        PlacesUtils.livemarks.setSiteURI(itemId, Utils.makeURI(val));
        break;
      case "feedUri":
        PlacesUtils.livemarks.setFeedURI(itemId, Utils.makeURI(val));
        break;
      }
    }
  },

  _orderChildren: function _orderChildren() {
    for (let [guid, children] in Iterator(this._childrenToOrder)) {
      // Reorder children according to the GUID list. Gracefully deal
      // with missing items, e.g. locally deleted.
      let delta = 0;
      let parent = null;
      for (let idx = 0; idx < children.length; idx++) {
        let itemid = this.idForGUID(children[idx]);
        if (itemid == -1) {
          delta += 1;
          this._log.trace("Could not locate record " + children[idx]);
          continue;
        }
        try {
          // This code path could be optimized by caching the parent earlier.
          // Doing so should take in count any edge case due to reparenting
          // or parent invalidations though.
          if (!parent) {
            parent = PlacesUtils.bookmarks.getFolderIdForItem(itemid);
          }
          PlacesUtils.bookmarks.moveItem(itemid, parent, idx - delta);
        } catch (ex) {
          this._log.debug("Could not move item " + children[idx] + ": " + ex);
        }
      }
    }
  },

  changeItemID: function BStore_changeItemID(oldID, newID) {
    this._log.debug("Changing GUID " + oldID + " to " + newID);

    // Make sure there's an item to change GUIDs
    let itemId = this.idForGUID(oldID);
    if (itemId <= 0)
      return;

    this._setGUID(itemId, newID);
  },

  _getNode: function BStore__getNode(folder) {
    let query = PlacesUtils.history.getNewQuery();
    query.setFolders([folder], 1);
    return PlacesUtils.history.executeQuery(
      query, PlacesUtils.history.getNewQueryOptions()).root;
  },

  _getTags: function BStore__getTags(uri) {
    try {
      if (typeof(uri) == "string")
        uri = Utils.makeURI(uri);
    } catch(e) {
      this._log.warn("Could not parse URI \"" + uri + "\": " + e);
    }
    return PlacesUtils.tagging.getTagsForURI(uri, {});
  },

  _getDescription: function BStore__getDescription(id) {
    try {
      return PlacesUtils.annotations.getItemAnnotation(id, DESCRIPTION_ANNO);
    } catch (e) {
      return null;
    }
  },

  _isLoadInSidebar: function BStore__isLoadInSidebar(id) {
    return PlacesUtils.annotations.itemHasAnnotation(id, SIDEBAR_ANNO);
  },

  get _childGUIDsStm() {
    return this._getStmt(
      "SELECT id AS item_id, guid " +
      "FROM moz_bookmarks " +
      "WHERE parent = :parent " +
      "ORDER BY position");
  },
  _childGUIDsCols: ["item_id", "guid"],

  _getChildGUIDsForId: function _getChildGUIDsForId(itemid) {
    let stmt = this._childGUIDsStm;
    stmt.params.parent = itemid;
    let rows = Async.querySpinningly(stmt, this._childGUIDsCols);
    return rows.map(function (row) {
      if (row.guid) {
        return row.guid;
      }
      // A GUID hasn't been assigned to this item yet, do this now.
      return this.GUIDForId(row.item_id);
    }, this);
  },

  // Create a record starting from the weave id (places guid)
  createRecord: function createRecord(id, collection) {
    let placeId = this.idForGUID(id);
    let record;
    if (placeId <= 0) { // deleted item
      record = new PlacesItem(collection, id);
      record.deleted = true;
      return record;
    }

    let parent = PlacesUtils.bookmarks.getFolderIdForItem(placeId);
    switch (PlacesUtils.bookmarks.getItemType(placeId)) {
    case PlacesUtils.bookmarks.TYPE_BOOKMARK:
      let bmkUri = PlacesUtils.bookmarks.getBookmarkURI(placeId).spec;
      if (bmkUri.search(/^place:/) == 0) {
        record = new BookmarkQuery(collection, id);

        // Get the actual tag name instead of the local itemId
        let folder = bmkUri.match(/[:&]folder=(\d+)/);
        try {
          // There might not be the tag yet when creating on a new client
          if (folder != null) {
            folder = folder[1];
            record.folderName = PlacesUtils.bookmarks.getItemTitle(folder);
            this._log.trace("query id: " + folder + " = " + record.folderName);
          }
        }
        catch(ex) {}
        
        // Persist the Smart Bookmark anno, if found.
        try {
          let anno = PlacesUtils.annotations.getItemAnnotation(placeId, SMART_BOOKMARKS_ANNO);
          if (anno != null) {
            this._log.trace("query anno: " + SMART_BOOKMARKS_ANNO +
                            " = " + anno);
            record.queryId = anno;
          }
        }
        catch(ex) {}
      }
      else {
        record = new Bookmark(collection, id);
      }
      record.title = PlacesUtils.bookmarks.getItemTitle(placeId);

      record.parentName = PlacesUtils.bookmarks.getItemTitle(parent);
      record.bmkUri = bmkUri;
      record.tags = this._getTags(record.bmkUri);
      record.keyword = PlacesUtils.bookmarks.getKeywordForBookmark(placeId);
      record.description = this._getDescription(placeId);
      record.loadInSidebar = this._isLoadInSidebar(placeId);
      break;

    case PlacesUtils.bookmarks.TYPE_FOLDER:
      if (PlacesUtils.itemIsLivemark(placeId)) {
        record = new Livemark(collection, id);

        let siteURI = PlacesUtils.livemarks.getSiteURI(placeId);
        if (siteURI != null)
          record.siteUri = siteURI.spec;
        record.feedUri = PlacesUtils.livemarks.getFeedURI(placeId).spec;

      } else {
        record = new BookmarkFolder(collection, id);
      }

      if (parent > 0)
        record.parentName = PlacesUtils.bookmarks.getItemTitle(parent);
      record.title = PlacesUtils.bookmarks.getItemTitle(placeId);
      record.description = this._getDescription(placeId);
      record.children = this._getChildGUIDsForId(placeId);
      break;

    case PlacesUtils.bookmarks.TYPE_SEPARATOR:
      record = new BookmarkSeparator(collection, id);
      if (parent > 0)
        record.parentName = PlacesUtils.bookmarks.getItemTitle(parent);
      // Create a positioning identifier for the separator, used by _lazyMap
      record.pos = PlacesUtils.bookmarks.getItemIndex(placeId);
      break;

    case PlacesUtils.bookmarks.TYPE_DYNAMIC_CONTAINER:
      record = new PlacesItem(collection, id);
      this._log.warn("Don't know how to serialize dynamic containers yet");
      break;

    default:
      record = new PlacesItem(collection, id);
      this._log.warn("Unknown item type, cannot serialize: " +
                     PlacesUtils.bookmarks.getItemType(placeId));
    }

    record.parentid = this.GUIDForId(parent);
    record.sortindex = this._calculateIndex(record);

    return record;
  },

  _stmts: {},
  _getStmt: function(query) {
    if (query in this._stmts)
      return this._stmts[query];

    this._log.trace("Creating SQL statement: " + query);
    let db = PlacesUtils.history.QueryInterface(Ci.nsPIPlacesDatabase)
                        .DBConnection;
    return this._stmts[query] = db.createAsyncStatement(query);
  },

  get _frecencyStm() {
    return this._getStmt(
        "SELECT frecency " +
        "FROM moz_places " +
        "WHERE url = :url " +
        "LIMIT 1");
  },
  _frecencyCols: ["frecency"],

  get _setGUIDStm() {
    return this._getStmt(
      "UPDATE moz_bookmarks " +
      "SET guid = :guid " +
      "WHERE id = :item_id");
  },

  // Some helper functions to handle GUIDs
  _setGUID: function _setGUID(id, guid) {
    if (!guid)
      guid = Utils.makeGUID();

    let stmt = this._setGUIDStm;
    stmt.params.guid = guid;
    stmt.params.item_id = id;
    Async.querySpinningly(stmt);
    return guid;
  },

  get _guidForIdStm() {
    return this._getStmt(
      "SELECT guid " +
      "FROM moz_bookmarks " +
      "WHERE id = :item_id");
  },
  _guidForIdCols: ["guid"],

  GUIDForId: function GUIDForId(id) {
    let special = kSpecialIds.specialGUIDForId(id);
    if (special)
      return special;

    let stmt = this._guidForIdStm;
    stmt.params.item_id = id;

    // Use the existing GUID if it exists
    let result = Async.querySpinningly(stmt, this._guidForIdCols)[0];
    if (result && result.guid)
      return result.guid;

    // Give the uri a GUID if it doesn't have one
    return this._setGUID(id);
  },

  get _idForGUIDStm() {
    return this._getStmt(
      "SELECT id AS item_id " +
      "FROM moz_bookmarks " +
      "WHERE guid = :guid");
  },
  _idForGUIDCols: ["item_id"],

  // noCreate is provided as an optional argument to prevent the creation of
  // non-existent special records, such as "mobile".
  idForGUID: function idForGUID(guid, noCreate) {
    if (kSpecialIds.isSpecialGUID(guid))
      return kSpecialIds.specialIdForGUID(guid, !noCreate);

    let stmt = this._idForGUIDStm;
    // guid might be a String object rather than a string.
    stmt.params.guid = guid.toString();

    let results = Async.querySpinningly(stmt, this._idForGUIDCols);
    this._log.trace("Number of rows matching GUID " + guid + ": "
                    + results.length);
    
    // Here's the one we care about: the first.
    let result = results[0];
    
    if (!result)
      return -1;
    
    return result.item_id;
  },

  _calculateIndex: function _calculateIndex(record) {
    // Ensure folders have a very high sort index so they're not synced last.
    if (record.type == "folder")
      return FOLDER_SORTINDEX;

    // For anything directly under the toolbar, give it a boost of more than an
    // unvisited bookmark
    let index = 0;
    if (record.parentid == "toolbar")
      index += 150;

    // Add in the bookmark's frecency if we have something
    if (record.bmkUri != null) {
      this._frecencyStm.params.url = record.bmkUri;
      let result = Async.querySpinningly(this._frecencyStm, this._frecencyCols);
      if (result.length)
        index += result[0].frecency;
    }

    return index;
  },

  _getChildren: function BStore_getChildren(guid, items) {
    let node = guid; // the recursion case
    if (typeof(node) == "string") { // callers will give us the guid as the first arg
      let nodeID = this.idForGUID(guid, true);
      if (!nodeID) {
        this._log.debug("No node for GUID " + guid + "; returning no children.");
        return items;
      }
      node = this._getNode(nodeID);
    }
    
    if (node.type == node.RESULT_TYPE_FOLDER &&
        !PlacesUtils.itemIsLivemark(node.itemId)) {
      node.QueryInterface(Ci.nsINavHistoryQueryResultNode);
      node.containerOpen = true;
      try {
        // Remember all the children GUIDs and recursively get more
        for (let i = 0; i < node.childCount; i++) {
          let child = node.getChild(i);
          items[this.GUIDForId(child.itemId)] = true;
          this._getChildren(child, items);
        }
      }
      finally {
        node.containerOpen = false;
      }
    }

    return items;
  },

  _tagURI: function BStore_tagURI(bmkURI, tags) {
    // Filter out any null/undefined/empty tags
    tags = tags.filter(function(t) t);

    // Temporarily tag a dummy uri to preserve tag ids when untagging
    let dummyURI = Utils.makeURI("about:weave#BStore_tagURI");
    PlacesUtils.tagging.tagURI(dummyURI, tags);
    PlacesUtils.tagging.untagURI(bmkURI, null);
    PlacesUtils.tagging.tagURI(bmkURI, tags);
    PlacesUtils.tagging.untagURI(dummyURI, null);
  },

  getAllIDs: function BStore_getAllIDs() {
    let items = {"menu": true,
                 "toolbar": true};
    for each (let guid in kSpecialIds.guids) {
      if (guid != "places" && guid != "tags")
        this._getChildren(guid, items);
    }
    return items;
  },

  wipe: function BStore_wipe() {
    // Save a backup before clearing out all bookmarks
    archiveBookmarks();

    for each (let guid in kSpecialIds.guids)
      if (guid != "places") {
        let id = kSpecialIds.specialIdForGUID(guid);
        if (id)
          PlacesUtils.bookmarks.removeFolderChildren(id);
      }
  }
};

function BookmarksTracker(name) {
  Tracker.call(this, name);

  Svc.Obs.add("places-shutdown", this);
  Svc.Obs.add("weave:engine:start-tracking", this);
  Svc.Obs.add("weave:engine:stop-tracking", this);
}
BookmarksTracker.prototype = {
  __proto__: Tracker.prototype,

  _enabled: false,
  observe: function observe(subject, topic, data) {
    switch (topic) {
      case "weave:engine:start-tracking":
        if (!this._enabled) {
          PlacesUtils.bookmarks.addObserver(this, true);
          Svc.Obs.add("bookmarks-restore-begin", this);
          Svc.Obs.add("bookmarks-restore-success", this);
          Svc.Obs.add("bookmarks-restore-failed", this);
          this._enabled = true;
        }
        break;
      case "weave:engine:stop-tracking":
        if (this._enabled) {
          PlacesUtils.bookmarks.removeObserver(this);
          Svc.Obs.remove("bookmarks-restore-begin", this);
          Svc.Obs.remove("bookmarks-restore-success", this);
          Svc.Obs.remove("bookmarks-restore-failed", this);
          this._enabled = false;
        }
        break;
        
      case "bookmarks-restore-begin":
        this._log.debug("Ignoring changes from importing bookmarks.");
        this.ignoreAll = true;
        break;
      case "bookmarks-restore-success":
        this._log.debug("Tracking all items on successful import.");
        this.ignoreAll = false;
        
        this._log.debug("Restore succeeded: wiping server and other clients.");
        Weave.Service.resetClient([this.name]);
        Weave.Service.wipeServer([this.name]);
        Weave.Service.prepCommand("wipeEngine", [this.name]);
        break;
      case "bookmarks-restore-failed":
        this._log.debug("Tracking all items on failed import.");
        this.ignoreAll = false;
        break;
    }
  },

  QueryInterface: XPCOMUtils.generateQI([
    Ci.nsINavBookmarkObserver,
    Ci.nsINavBookmarkObserver_MOZILLA_1_9_1_ADDITIONS,
    Ci.nsISupportsWeakReference
  ]),

  /**
   * Add a bookmark guid to be uploaded and bump up the sync score
   *
   * @param itemGuid
   *        Guid of the bookmark to upload
   */
  _add: function BMT__add(itemId, guid) {
    guid = kSpecialIds.specialGUIDForId(itemId) || guid;
    if (this.addChangedID(guid))
      this._upScore();
  },

  /* Every add/remove/change is worth 10 points */
  _upScore: function BMT__upScore() {
    this.score += 10;
  },

  /**
   * Determine if a change should be ignored: we're ignoring everything or the
   * folder is for livemarks
   *
   * @param itemId
   *        Item under consideration to ignore
   * @param folder (optional)
   *        Folder of the item being changed
   */
  _ignore: function BMT__ignore(itemId, folder, guid) {
    // Ignore unconditionally if the engine tells us to.
    if (this.ignoreAll)
      return true;

    // Get the folder id if we weren't given one.
    if (folder == null) {
      try {
        folder = PlacesUtils.bookmarks.getFolderIdForItem(itemId);
      } catch (ex) {
        this._log.debug("getFolderIdForItem(" + itemId +
                        ") threw; calling _ensureMobileQuery.");
        // I'm guessing that gFIFI can throw, and perhaps that's why
        // _ensureMobileQuery is here at all. Try not to call it.
        this._ensureMobileQuery();
        folder = PlacesUtils.bookmarks.getFolderIdForItem(itemId);
      }
    }

    // Ignore livemark children.
    if (PlacesUtils.itemIsLivemark(folder))
      return true;

    // Ignore changes to tags (folders under the tags folder).
    let tags = kSpecialIds.tags;
    if (folder == tags)
      return true;

    // Ignore tag items (the actual instance of a tag for a bookmark).
    if (PlacesUtils.bookmarks.getFolderIdForItem(folder) == tags)
      return true;

    // Make sure to remove items that have the exclude annotation.
    if (PlacesUtils.annotations.itemHasAnnotation(itemId, EXCLUDEBACKUP_ANNO)) {
      this.removeChangedID(guid);
      return true;
    }

    return false;
  },

  onItemAdded: function BMT_onItemAdded(itemId, folder, index,
                                        itemType, uri, title, dateAdded,
                                        guid, parentGuid) {
    if (this._ignore(itemId, folder, guid))
      return;

    this._log.trace("onItemAdded: " + itemId);
    this._add(itemId, guid);
    this._add(folder, parentGuid);
  },

  onItemRemoved: function BMT_onItemRemoved(itemId, parentId, index, type, uri,
                                            guid, parentGuid) {
    if (this._ignore(itemId, parentId, guid))
      return;

    this._log.trace("onBeforeItemRemoved: " + itemId);
    this._add(itemId, guid);
    this._add(parentId, parentGuid);
  },

  _ensureMobileQuery: function _ensureMobileQuery() {
    let find = function (val)
      PlacesUtils.annotations.getItemsWithAnnotation(ORGANIZERQUERY_ANNO, {}).filter(
        function (id) PlacesUtils.annotations.getItemAnnotation(id, ORGANIZERQUERY_ANNO) == val
      );

    // Don't continue if the Library isn't ready
    let all = find(ALLBOOKMARKS_ANNO);
    if (all.length == 0)
      return;

    // Disable handling of notifications while changing the mobile query
    this.ignoreAll = true;

    let mobile = find(MOBILE_ANNO);
    let queryURI = Utils.makeURI("place:folder=" + kSpecialIds.mobile);
    let title = Str.sync.get("mobile.label");

    // Don't add OR remove the mobile bookmarks if there's nothing.
    if (PlacesUtils.bookmarks.getIdForItemAt(kSpecialIds.mobile, 0) == -1) {
      if (mobile.length != 0)
        PlacesUtils.bookmarks.removeItem(mobile[0]);
    }
    // Add the mobile bookmarks query if it doesn't exist
    else if (mobile.length == 0) {
      let query = PlacesUtils.bookmarks.insertBookmark(all[0], queryURI, -1, title);
      PlacesUtils.annotations.setItemAnnotation(query, ORGANIZERQUERY_ANNO, MOBILE_ANNO, 0,
                                  PlacesUtils.annotations.EXPIRE_NEVER);
      PlacesUtils.annotations.setItemAnnotation(query, EXCLUDEBACKUP_ANNO, 1, 0,
                                  PlacesUtils.annotations.EXPIRE_NEVER);
    }
    // Make sure the existing title is correct
    else if (PlacesUtils.bookmarks.getItemTitle(mobile[0]) != title) {
      PlacesUtils.bookmarks.setItemTitle(mobile[0], title);
    }

    this.ignoreAll = false;
  },

  // This method is oddly structured, but the idea is to return as quickly as
  // possible -- this handler gets called *every time* a bookmark changes, for
  // *each change*. That's particularly bad when a bunch of livemarks are
  // updated.
  onItemChanged: function BMT_onItemChanged(itemId, property, isAnno, value,
                                            lastModified, itemType, parentId,
                                            guid, parentGuid) {
    // Quicker checks first.
    if (this.ignoreAll)
      return;

    if (isAnno && (ANNOS_TO_TRACK.indexOf(property) == -1))
      // Ignore annotations except for the ones that we sync.
      return;

    // Ignore favicon changes to avoid unnecessary churn.
    if (property == "favicon")
      return;

    if (this._ignore(itemId, parentId, guid))
      return;

    this._log.trace("onItemChanged: " + itemId +
                    (", " + property + (isAnno? " (anno)" : "")) +
                    (value ? (" = \"" + value + "\"") : ""));
    this._add(itemId, guid);
  },

  onItemMoved: function BMT_onItemMoved(itemId, oldParent, oldIndex,
                                        newParent, newIndex, itemType,
                                        guid, oldParentGuid, newParentGuid) {
    if (this._ignore(itemId, newParent, guid))
      return;

    this._log.trace("onItemMoved: " + itemId);
    this._add(oldParent, oldParentGuid);
    if (oldParent != newParent) {
      this._add(itemId, guid);
      this._add(newParent, newParentGuid);
    }

    // Remove any position annotations now that the user moved the item
    PlacesUtils.annotations.removeItemAnnotation(itemId, PARENT_ANNO);
  },

  onBeginUpdateBatch: function () {},
  onEndUpdateBatch: function () {},
  onBeforeItemRemoved: function () {},
  onItemVisited: function () {}
};
