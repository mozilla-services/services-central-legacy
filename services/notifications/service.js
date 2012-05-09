const EXPORTED_SYMBOLS = ["Service"];

const {classes: Cc, interfaces: Ci, results: Cr, utils: Cu} = Components;

Cu.import("resource://services-common/preferences.js");

const PREFS_BRANCH = "services.notifications.";


function NotificationSvc() {
  this.ready = false;
  this.prefs = new Preferences(PREFS_BRANCH);
}
NotificationSvc.prototype = {

  get serverURL() this.prefs.get("serverURL"),

  onStartup: function onStartup() {
    this.ready = true;
  }
};

let Service = new NotificationSvc();
Service.onStartup();
