const EXPORTED_SYMBOLS = ["Service"];

const {classes: Cc, interfaces: Ci, results: Cr, utils: Cu} = Components;

Cu.import("resource://services-common/log4moz.js");
Cu.import("resource://services-common/preferences.js");
Cu.import("resource://services-common/rest.js");
Cu.import("resource://services-common/utils.js");

const PREFS_BRANCH = "services.notifications.";

function NotificationSvc() {
  this.prefs = new Preferences(PREFS_BRANCH);
  this.DB = {};

  this._log = Log4Moz.repository.getLogger("Notifications.Service");
  this._log.level = Log4Moz.Level[this.prefs.get("logger.level")];
}
NotificationSvc.prototype = {

  /**
   * Path in the profile dir where we save our state.
   */
  filePath: "notifications/notifications",

  /**
   * Get the serverURL pref without a trailing slash.
   */
  get serverURL() {
    let url = this.prefs.get("serverURL");
    let last = url.length - 1;
    return url[last] == "/" ? url.substring(0, last) : url;
  },

  init: function init() {
    this.loadState();
  },

  /**
   * Load database state from a file.
   */
  loadState: function loadState(cb) {
    CommonUtils.jsonLoad(this.filePath, this, function(json) {
      if (json) {
        this._log.info("Loading state from " + this.filePath);
        this.DB = json;
      }
      if (cb) cb(null, json);
    });
  },

  /**
   * Save the current state to a file.
   */
  saveState: function saveState(cb) {
    this._log.info("Saving state to " + this.filePath);
    CommonUtils.jsonSave(this.filePath, this, this.DB, cb);
  },

  /**
   * Get an authentication token from the local DB or the push server.
   */
  getToken: function getToken(cb) {
    if (this.DB.token) {
      this._log.debug("getToken from database");
      return cb(null, this.DB.token);
    }

    let self = this;
    let url = this.serverURL + "/token/";
    new RESTRequest(url).get(function onResponse(error) {
      if (error) {
        return cb(error.message);
      }
      if (!this.response.success) {
        return cb("Service error: " + this.response.status);
      }
      try {
        self.DB.token = JSON.parse(this.response.body).token;
        self.saveState();
      } catch (e) {
        return cb("bad json");
      }

      this._log.debug("getToken from server");
      cb(null, self.DB.token);
    });
  }
};

let Service = new NotificationSvc();
Service.init();
