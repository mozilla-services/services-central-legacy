// Check that everything is getting hooked together properly.
function run_test() {
  _("When imported, Service.onStartup is called.");
  Cu.import("resource://services-notifications/service.js");

  do_check_eq(Service.serverURL, "http://push.jbalogh.me/");
  do_check_eq(Service.ready, true);
}
