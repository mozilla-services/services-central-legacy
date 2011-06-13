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
 * The Initial Developer of the Original Code is Mozilla.
 * Portions created by the Initial Developer are Copyright (C) 2007
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *  Dan Mills <thunder@mozilla.com>
 *  Anant Narayanan <anant@kix.in>
 *  Philipp von Weitershausen <philipp@weitershausen.de>
 *  Richard Newman <rnewman@mozilla.com>
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

const EXPORTED_SYMBOLS = ["Resource", "AsyncResource", "IncrementalResource",
                          "Auth", "BrokenBasicAuthenticator",
                          "BasicAuthenticator", "NoOpAuthenticator"];

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cr = Components.results;
const Cu = Components.utils;

Cu.import("resource://services-sync/async.js");
Cu.import("resource://services-sync/constants.js");
Cu.import("resource://services-sync/ext/Observers.js");
Cu.import("resource://services-sync/ext/Preferences.js");
Cu.import("resource://services-sync/log4moz.js");
Cu.import("resource://services-sync/util.js");
Cu.import("resource://services-sync/async.js");

XPCOMUtils.defineLazyGetter(this, "Auth", function () {
  return new AuthMgr();
});

// XXX: the authenticator api will probably need to be changed to support
// other methods (digest, oauth, etc)

function NoOpAuthenticator() {}
NoOpAuthenticator.prototype = {
  onRequest: function NoOpAuth_onRequest(headers) {
    return headers;
  }
};

// Warning: This will drop the high unicode bytes from passwords.
// Use BasicAuthenticator to send non-ASCII passwords UTF8-encoded.
function BrokenBasicAuthenticator(identity) {
  this._id = identity;
}
BrokenBasicAuthenticator.prototype = {
  onRequest: function BasicAuth_onRequest(headers) {
    headers['authorization'] = 'Basic ' +
      btoa(this._id.username + ':' + this._id.password);
    return headers;
  }
};

function BasicAuthenticator(identity) {
  this._id = identity;
}
BasicAuthenticator.prototype = {
  onRequest: function onRequest(headers) {
    headers['authorization'] = 'Basic ' +
      btoa(this._id.username + ':' + this._id.passwordUTF8);
    return headers;
  }
};

function AuthMgr() {
  this._authenticators = {};
  this.defaultAuthenticator = new NoOpAuthenticator();
}
AuthMgr.prototype = {
  defaultAuthenticator: null,

  registerAuthenticator: function AuthMgr_register(match, authenticator) {
    this._authenticators[match] = authenticator;
  },

  lookupAuthenticator: function AuthMgr_lookup(uri) {
    for (let match in this._authenticators) {
      if (uri.match(match))
        return this._authenticators[match];
    }
    return this.defaultAuthenticator;
  }
};


/*
 * AsyncResource represents a remote network resource, identified by a URI.
 * Create an instance like so:
 *
 *   let resource = new AsyncResource("http://foobar.com/path/to/resource");
 *
 * The 'resource' object has the following methods to issue HTTP requests
 * of the corresponding HTTP methods:
 *
 *   get(callback)
 *   put(data, callback)
 *   post(data, callback)
 *   delete(callback)
 *
 * 'callback' is a function with the following signature:
 *
 *   function callback(error, result, resource) {...}
 *
 * 'error' will be null on successful requests. Likewise, result will not be
 * passed (=undefined) when an error occurs. Note that this is independent of
 * the status of the HTTP response.
 */
function AsyncResource(uri) {
  this._log = Log4Moz.repository.getLogger(this._logName);
  this._log.level =
    Log4Moz.Level[Svc.Prefs.get("log.logger.network.resources")];
  this.uri = uri;
  this._headers = {};
  this._onComplete = Utils.bind2(this, this._onComplete);
}
AsyncResource.prototype = {
  _logName: "Net.Resource",

  // ** {{{ AsyncResource.serverTime }}} **
  //
  // Caches the latest server timestamp (X-Weave-Timestamp header).
  serverTime: null,

  // The string to use as the base User-Agent in Sync requests.
  // These strings will look something like
  //
  //   Firefox/4.0 FxSync/1.8.0.20100101.mobile
  //
  // or
  //
  //   Firefox Aurora/5.0a1 FxSync/1.9.0.20110409.desktop
  //
  _userAgent:
    Services.appinfo.name + "/" + Services.appinfo.version +  // Product.
    " FxSync/" + WEAVE_VERSION + "." +                        // Sync.
    Services.appinfo.appBuildID + ".",                        // Build.

  // Wait 5 minutes before killing a request.
  ABORT_TIMEOUT: 300000,

  // ** {{{ AsyncResource.authenticator }}} **
  //
  // Getter and setter for the authenticator module
  // responsible for this particular resource. The authenticator
  // module may modify the headers to perform authentication
  // while performing a request for the resource, for example.
  get authenticator() {
    if (this._authenticator)
      return this._authenticator;
    else
      return Auth.lookupAuthenticator(this.spec);
  },
  set authenticator(value) {
    this._authenticator = value;
  },

  // ** {{{ AsyncResource.headers }}} **
  //
  // Headers to be included when making a request for the resource.
  // Note: Header names should be all lower case, there's no explicit
  // check for duplicates due to case!
  get headers() {
    return this.authenticator.onRequest(this._headers);
  },
  set headers(value) {
    this._headers = value;
  },
  setHeader: function Res_setHeader(header, value) {
    this._headers[header.toLowerCase()] = value;
  },

  // ** {{{ AsyncResource.uri }}} **
  //
  // URI representing this resource.
  get uri() {
    return this._uri;
  },
  set uri(value) {
    if (typeof value == 'string')
      this._uri = Utils.makeURI(value);
    else
      this._uri = value;
  },

  // ** {{{ AsyncResource.spec }}} **
  //
  // Get the string representation of the URI.
  get spec() {
    if (this._uri)
      return this._uri.spec;
    return null;
  },

  // ** {{{ AsyncResource.data }}} **
  //
  // Get and set the data encapulated in the resource.
  _data: null,
  get data() this._data,
  set data(value) {
    this._data = value;
  },

  // ** {{{ AsyncResource._createRequest }}} **
  //
  // This method returns a new IO Channel for requests to be made
  // through. It is never called directly, only {{{_doRequest}}} uses it
  // to obtain a request channel.
  //
  _createRequest: function Res__createRequest() {
    let channel = Services.io.newChannel(this.spec, null, null)
                          .QueryInterface(Ci.nsIRequest)
                          .QueryInterface(Ci.nsIHttpChannel);

    // Always validate the cache:
    channel.loadFlags |= Ci.nsIRequest.LOAD_BYPASS_CACHE;
    channel.loadFlags |= Ci.nsIRequest.INHIBIT_CACHING;

    // Setup a callback to handle bad HTTPS certificates.
    channel.notificationCallbacks = new BadCertListener();

    // Compose a UA string fragment from the various available identifiers.
    if (Svc.Prefs.get("sendVersionInfo", true)) {
      let ua = this._userAgent + Svc.Prefs.get("client.type", "desktop");
      channel.setRequestHeader("user-agent", ua, false);
    }

    // Avoid calling the authorizer more than once.
    let headers = this.headers;
    for (let key in headers) {
      if (key == 'authorization')
        this._log.trace("HTTP Header " + key + ": ***** (suppressed)");
      else
        this._log.trace("HTTP Header " + key + ": " + headers[key]);
      channel.setRequestHeader(key, headers[key], false);
    }
    return channel;
  },

  _onProgress: function Res__onProgress(channel) {},

  extendResponse: function extendResponse(ret) {
  },

  _doRequest: function _doRequest(action, data, callback) {
    this._log.trace("In _doRequest.");
    this._callback = callback;
    let channel = this._channel = this._createRequest();

    if ("undefined" != typeof(data))
      this._data = data;

    // PUT and POST are treated differently because they have payload data.
    if ("PUT" == action || "POST" == action) {
      // Convert non-string bodies into JSON
      if (this._data.constructor.toString() != String)
        this._data = JSON.stringify(this._data);

      this._log.debug(action + " Length: " + this._data.length);
      this._log.trace(action + " Body: " + this._data);

      let type = ('content-type' in this._headers) ?
        this._headers['content-type'] : 'text/plain';

      let stream = Cc["@mozilla.org/io/string-input-stream;1"].
        createInstance(Ci.nsIStringInputStream);
      stream.setData(this._data, this._data.length);

      channel.QueryInterface(Ci.nsIUploadChannel);
      channel.setUploadStream(stream, type, this._data.length);
    }

    // Setup a channel listener so that the actual network operation
    // is performed asynchronously.
    let listener = new ChannelListener(this._onComplete, this._onProgress,
                                       this._log, this.ABORT_TIMEOUT);
    channel.requestMethod = action;
    channel.asyncOpen(listener, null);
  },

  _onComplete: function _onComplete(error, data) {
    this._log.trace("In _onComplete. Error is " + error + ".");

    if (error) {
      this._callback(error, null, this);
      return;
    }

    this._data = data;
    let channel = this._channel;
    let action = channel.requestMethod;

    this._log.trace("Channel: " + channel);
    this._log.trace("Action: "  + action);

    // Process status and success first. This way a problem with headers
    // doesn't fail to include accurate status information.
    let status = 0;
    let success = false;

    try {
      status  = channel.responseStatus;
      success = channel.requestSucceeded;    // HTTP status.

      this._log.trace("Status: " + status);
      this._log.trace("Success: " + success);

      // Log the status of the request.
      let mesg = [action, success ? "success" : "fail", status,
                  channel.URI.spec].join(" ");
      this._log.debug("mesg: " + mesg);

      if (mesg.length > 200)
        mesg = mesg.substr(0, 200) + "…";
      this._log.debug(mesg);

      // Additionally give the full response body when Trace logging.
      if (this._log.level <= Log4Moz.Level.Trace)
        this._log.trace(action + " body: " + data);

    } catch(ex) {
      // Got a response, but an exception occurred during processing.
      // This shouldn't occur.
      this._log.warn("Caught unexpected exception " + Utils.exceptionStr(ex) +
                     " in _onComplete.");
      this._log.debug(Utils.stackTrace(ex));
    }

    // Process headers. They can be empty, or the call can otherwise fail, so
    // put this in its own try block.
    let headers = {};
    try {
      this._log.trace("Processing response headers.");

      // Read out the response headers if available.
      channel.visitResponseHeaders({
        visitHeader: function visitHeader(header, value) {
          headers[header.toLowerCase()] = value;
        }
      });

      // This is a server-side safety valve to allow slowing down
      // clients without hurting performance.
      if (headers["x-weave-backoff"])
        Observers.notify("weave:service:backoff:interval",
                         parseInt(headers["x-weave-backoff"], 10));

      if (success && headers["x-weave-quota-remaining"])
        Observers.notify("weave:service:quota:remaining",
                         parseInt(headers["x-weave-quota-remaining"], 10));
    } catch (ex) {
      this._log.debug("Caught exception " + Utils.exceptionStr(ex) +
                      " visiting headers in _onComplete.");
      this._log.debug(Utils.stackTrace(ex));
    }

    let ret     = new String(data);
    ret.status  = status;
    ret.success = success;
    ret.headers = headers;

    // Allow subclasses to do neat things like attach the IDs they were trying
    // to fetch.
    this.extendResponse(ret);

    // Make a lazy getter to convert the json response into an object.
    // Note that this can cause a parse error to be thrown far away from the
    // actual fetch, so be warned!
    XPCOMUtils.defineLazyGetter(ret, "obj", function() JSON.parse(ret));

    // Notify if we get a 401 to maybe try again with a new URI.
    // TODO: more retry logic.
    if (status == 401) {
      // Create an object to allow observers to decide if we should try again.
      let subject = {
        newUri: "",
        resource: this,
        response: ret
      }
      Observers.notify("weave:resource:status:401", subject);

      // Do the same type of request but with the new URI.
      if (subject.newUri != "") {
        this.uri = subject.newUri;
        this._doRequest(action, this._data, this._callback);
        return;
      }
    }
    this._callback(null, ret, this);
  },

  get: function get(callback) {
    this._doRequest("GET", undefined, callback);
  },

  put: function put(data, callback) {
    if (typeof data == "function")
      [data, callback] = [undefined, data];
    this._doRequest("PUT", data, callback);
  },

  post: function post(data, callback) {
    if (typeof data == "function")
      [data, callback] = [undefined, data];
    this._doRequest("POST", data, callback);
  },

  delete: function delete(callback) {
    this._doRequest("DELETE", undefined, callback);
  }
};

/*
 * An async resource which calls an onRecord callback on a handler object as
 * lines are retrieved. Each line will be delivered as text.
 */
function IncrementalResource(uri, lineHandler) {
  AsyncResource.call(this, uri);
  if (lineHandler) {
    this.lineHandler = lineHandler;
  }
}
IncrementalResource.prototype = {
  __proto__: AsyncResource.prototype,
  _logName: "Net.IncrementalResource",

  set lineHandler(handler) {
    let resource = this;
    this._onProgress = function () {
      let newline;
      while ((newline = this._data.indexOf("\n")) > 0) {
        // Split the JSON record from the rest of the data.
        let json = this._data.slice(0, newline);
        this._data = this._data.slice(newline + 1);

        // Give the JSON to the callback.
        handler(json, resource);
      }
    };
  },

  get: function (callback) {
    this.setHeader("Accept", "application/newlines");
    AsyncResource.prototype.get.call(this, callback);
  }
};

/*
 * Represent a remote network resource, identified by a URI, with a
 * synchronous API.
 *
 * 'Resource' is not recommended for new code. Use the asynchronous API of
 * 'AsyncResource' instead.
 */
function Resource(uri) {
  AsyncResource.call(this, uri);
}
Resource.prototype = {

  __proto__: AsyncResource.prototype,

  // ** {{{ Resource._request }}} **
  //
  // Perform a particular HTTP request on the resource. This method
  // is never called directly, but is used by the high-level
  // {{{get}}}, {{{put}}}, {{{post}}} and {{delete}} methods.
  _request: function Res__request(action, data) {
    let cb = Async.makeSyncCallback();
    function callback(error, ret) {
      if (error)
        cb.throw(error);
      cb(ret);
    }

    // The channel listener might get a failure code
    try {
      this._doRequest(action, data, callback);
      return Async.waitForSyncCallback(cb);
    } catch(ex) {
      // Combine the channel stack with this request stack.  Need to create
      // a new error object for that.
      let error = Error(ex.message);
      error.result = ex.result;
      let chanStack = [];
      if (ex.stack)
        chanStack = ex.stack.trim().split(/\n/).slice(1);
      let requestStack = error.stack.split(/\n/).slice(1);

      // Strip out the args for the last 2 frames because they're usually HUGE!
      for (let i = 0; i <= 1; i++)
        requestStack[i] = requestStack[i].replace(/\(".*"\)@/, "(...)@");

      error.stack = chanStack.concat(requestStack).join("\n");
      throw error;
    }
  },

  // ** {{{ Resource.get }}} **
  //
  // Perform an asynchronous HTTP GET for this resource.
  get: function Res_get() {
    return this._request("GET");
  },

  // ** {{{ Resource.put }}} **
  //
  // Perform a HTTP PUT for this resource.
  put: function Res_put(data) {
    return this._request("PUT", data);
  },

  // ** {{{ Resource.post }}} **
  //
  // Perform a HTTP POST for this resource.
  post: function Res_post(data) {
    return this._request("POST", data);
  },

  // ** {{{ Resource.delete }}} **
  //
  // Perform a HTTP DELETE for this resource.
  delete: function Res_delete() {
    return this._request("DELETE");
  }
};

// = ChannelListener =
//
// This object implements the {{{nsIStreamListener}}} interface
// and is called as the network operation proceeds.
function ChannelListener(onComplete, onProgress, logger, timeout) {
  this._onComplete = onComplete;
  this._onProgress = onProgress;
  this._log = logger;
  this._timeout = timeout;
  this.delayAbort();
}
ChannelListener.prototype = {

  onStartRequest: function Channel_onStartRequest(channel) {
    this._log.trace("onStartRequest called for channel " + channel + ".");
    channel.QueryInterface(Ci.nsIHttpChannel);

    // Save the latest server timestamp when possible.
    try {
      AsyncResource.serverTime = channel.getResponseHeader("X-Weave-Timestamp") - 0;
    }
    catch(ex) {}

    this._log.trace("onStartRequest: " + channel.requestMethod + " " +
                    channel.URI.spec);
    this._data = '';
    this.delayAbort();
  },

  onStopRequest: function Channel_onStopRequest(channel, context, status) {
    // Clear the abort timer now that the channel is done.
    this.abortTimer.clear();

    let success = Components.isSuccessCode(status);
    let uri = channel && channel.URI && channel.URI.spec || "<unknown>";
    this._log.trace("Channel for " + channel.requestMethod + " " +
                    uri + ": isSuccessCode(" + status + ")? " +
                    success);

    if (this._data == '')
      this._data = null;

    // Throw the failure code and stop execution.  Use Components.Exception()
    // instead of Error() so the exception is QI-able and can be passed across
    // XPCOM borders while preserving the status code.
    if (!success) {
      let message = Components.Exception("", status).name;
      let error = Components.Exception(message, status);
      this._onComplete(error);
      return;
    }

    this._log.trace("Channel: flags = " + channel.loadFlags +
                    ", URI = " + uri +
                    ", HTTP success? " + channel.requestSucceeded);
    this._onComplete(null, this._data);
  },

  onDataAvailable: function Channel_onDataAvail(req, cb, stream, off, count) {
    let siStream = Cc["@mozilla.org/scriptableinputstream;1"].
      createInstance(Ci.nsIScriptableInputStream);
    siStream.init(stream);
    try {
      this._data += siStream.read(count);
    } catch (ex) {
      this._log.warn("Exception thrown reading " + count +
                     " bytes from " + siStream + ".");
      throw ex;
    }

    try {
      this._onProgress();
    } catch (ex) {
      this._log.warn("Got exception calling onProgress handler during fetch of "
                     + req.URI.spec);
      this._log.debug(Utils.exceptionStr(ex));
      this._log.trace("Rethrowing; expect a failure code from the HTTP channel.");
      throw ex;
    }

    this.delayAbort();
  },

  /**
   * Create or push back the abort timer that kills this request
   */
  delayAbort: function delayAbort() {
    Utils.namedTimer(this.abortRequest, this._timeout, this, "abortTimer");
  },

  abortRequest: function abortRequest() {
    // Ignore any callbacks if we happen to get any now
    this.onStopRequest = function() {};
    let error = Components.Exception("Aborting due to channel inactivity.",
                                     Cr.NS_ERROR_NET_TIMEOUT);
    this._onComplete(error);
  }
};

// = BadCertListener =
//
// We use this listener to ignore bad HTTPS
// certificates and continue a request on a network
// channel. Probably not a very smart thing to do,
// but greatly simplifies debugging and is just very
// convenient.
function BadCertListener() {
}
BadCertListener.prototype = {
  getInterface: function(aIID) {
    return this.QueryInterface(aIID);
  },

  QueryInterface: function(aIID) {
    if (aIID.equals(Components.interfaces.nsIBadCertListener2) ||
        aIID.equals(Components.interfaces.nsIInterfaceRequestor) ||
        aIID.equals(Components.interfaces.nsISupports))
      return this;

    throw Components.results.NS_ERROR_NO_INTERFACE;
  },

  notifyCertProblem: function certProblem(socketInfo, sslStatus, targetHost) {
    // Silently ignore?
    let log = Log4Moz.repository.getLogger("Service.CertListener");
    log.level =
      Log4Moz.Level[Svc.Prefs.get("log.logger.network.resources")];
    log.debug("Invalid HTTPS certificate encountered, ignoring!");

    return true;
  }
};
