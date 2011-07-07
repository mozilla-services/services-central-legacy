Cu.import("resource://services-sync/log4moz.js");
Cu.import("resource://services-sync/record.js");

/**
 * GlobalRecord is an object wrapper for meta/global. This is a top-level class
 * for ease of testing and reuse.
 */
/*
 * Here's an example record:
  {
    data: {
      id: "global",
      modified: 1301092886.89,
      payload: {
        syncID: "aaaaaaam1Ozy",
        storageVersion: 5,
        engines: {
          clients: {version: 1, syncID: "aaaaaaab88su"},
          bookmarks: {version: 2, syncID: "aaaaaaaC3B71"},
          forms: {version: 1, syncID: "aaaaaaakuSNQ"},
          history: {version: 1, syncID: "aaaaaaa_kDiz"},
          passwords: {version: 1, syncID: "aaaaaaazhO0r"},
          prefs: {version: 2, syncID: "aaaaaaajSH-m"},
          tabs: {version: 1, syncID: "aaaaaaa0b5cr"}
        }
      }
    },
    collection: "https://phx-sync123.services.mozilla.com/1.1/username/storage/meta/global",
    isNew: undefined,
    changed: undefined
  }
*/

function GlobalRecord(url) {
  this.metaURI = url;
}
GlobalRecord.prototype = {
  metaURI: null,
  metaRecord: null,

  get record() {
    return this.metaRecord ||
           (this.metaRecord = Records.get(this.metaURI));
  },

  get syncID()          this.record.payload.syncID,
  get storageVersion()  this.record.payload.storageVersion,
  get collections()     this.record.payload.engines || {},
  get collectionNames() Object.keys(this.collections),

  collection: function collection(coll) {
    return this.collections[coll];
  },
};
