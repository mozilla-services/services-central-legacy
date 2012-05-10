function run_test() {
  _("Check that a Notification Service is created during import.");
  Cu.import("resource://services-notifications/service.js");

  Service.prefs.set("serverURL", "http://foo.bar.com/");
  do_check_eq(Service.serverURL, "http://foo.bar.com");
}
