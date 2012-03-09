/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * This file contains APIs for interacting with the Storage Service API.
 *
 * The specification for the service is available at.
 * http://docs.services.mozilla.com/storage/index.html
 *
 * Nothing about the spec or the service is Sync-specific. And, that is how
 * these APIs are implemented. Instead, it is expected that consumers will
 * create a new type inheriting or wrapping those provided by this file.
 *
 * STORAGE SERVICE OVERVIEW
 *
 * The storage service is effectively a key-value store where each value is a
 * well-defined envelope that stores specific metadata along with a payload.
 * These values are called Basic Storage Objects, or BSOs. BSOs are organized
 * into named groups called collections.
 *
 * The service also provides ancillary APIs not related to storage, such as
 * looking up the set of stored collections, current quota usage, etc.
 */

"use strict";

const EXPORTED_SYMBOLS = [
  "BasicStorageObject",
  "StorageServiceClient",
];

const {classes: Cc, interfaces: Ci, results: Cr, utils: Cu} = Components;

Cu.import("resource://services-sync/async.js");
Cu.import("resource://services-sync/constants.js");
Cu.import("resource://services-sync/log4moz.js");
Cu.import("resource://services-sync/rest.js");
Cu.import("resource://services-sync/util.js");

/**
 * The data type stored in the storage service.
 *
 * A Basic Storage Object (BSO) is the primitive type stored in the storage
 * service. BSO's are simply maps with a well-defined set of keys.
 *
 * BSOs belong to named collections.
 *
 * A single BSO consists of the following fields:
 *
 *   id - An identifying string. This is how a BSO is uniquely identified within
 *     a single collection.
 *   modified - Integer milliseconds since Unix epoch BSO was modified.
 *   payload - String contents of BSO. The format of the string is undefined
 *     (although JSON is typically used).
 *   ttl - The number of seconds to keep this record.
 *   sortindex - Integer indicating relative importance of record within the
 *     collection.
 *
 * The constructor simply creates an empty BSO having the specified ID (which
 * can be null or undefined). It also takes an optional collection. This is
 * purely for convenience.
 *
 * This type is meant to be a dumb container and little more.
 *
 * @param id
 *        (string) ID of BSO. Can be null.
 *        (string) Collection BSO belongs to. Can be null;
 */
function BasicStorageObject(id, collection) {
  this.data = {};
  this.id = id;
  this.collection = collection;
}
BasicStorageObject.prototype = {
  id: null,
  collection: null,
  data: null,

  _validKeys: {id: 0, payload: 0, modified: 0, sortindex: 0, ttl: 0},

  /**
   * Get the string payload as-is.
   */
  get payload() {
    return this.data.payload;
  },

  /**
   * Set the string payload to a new value.
   */
  set payload(value) {
    this.data.payload = value;
  },

  /**
   * Get the modified time of the BSO in milliseconds since Unix epoch.
   *
   * You can convert this to a native JS Date instance easily:
   *
   *   let date = new Date(bso.modified);
   */
  get modified() {
    return this.data.modified;
  },

  /**
   * Sets the modified time of the BSO in milliseconds since Unix epoch.
   *
   * Please note that if this value is sent to the server it will be ignored.
   * The server will use its time at the time of the operation when storing the
   * BSO.
   */
  set modified(value) {
    this.data.modified = value;
  },

  get sortindex() {
    if (this.data.sortindex) {
      return this.data.sortindex;
    }

    return 0;
  },

  set sortindex(value) {
    if (!value && value !== 0) {
      delete this.data.sortindex;
      return;
    }

    this.data.sortindex = value;
  },

  get ttl() {
    return this.data.ttl;
  },

  set ttl(value) {
    if (!value && value !== 0) {
      delete this.data.ttl;
      return;
    }

    this.data.ttl = value;
  },

  /**
   * Deserialize JSON or another object into this instance.
   *
   * The argument can be a string containing serialized JSON or an object.
   *
   * If the JSON is invalid or if the object contains unknown fields, an
   * exception will be thrown.
   *
   * @param json
   *        (string|object) Value to construct BSO from.
   */
  deserialize: function deserialize(input) {
    let data;

    if (typeof(input) == "string") {
      data = JSON.parse(input);
      if (typeof(data) != "object") {
        throw new Error("Supplied JSON is valid but is not a JS-Object.");
      }
    }
    else if (typeof(input) == "object") {
      data = input;
    } else {
      throw new Error("Argument must be a JSON string or object: " +
                      typeof(input));
    }

    for each (let key in Object.keys(data)) {
      if (key == "id") {
        this.id = data.id;
        continue;
      }

      if (!(key in this._validKeys)) {
        throw new Error("Invalid key in object: " + key);
      }

      this.data[key] = data[key];
    }
  },

  /**
   * Serialize the current BSO to JSON.
   *
   * @return string
   *         The JSON representation of this BSO.
   */
  toJSON: function toJSON() {
    let obj = {};

    for (let [k, v] in Iterator(this.data)) {
      obj[k] = v;
    }

    if (this.id) {
      obj.id = this.id;
    }

    return JSON.stringify(obj);
  },

  toString: function toString() {
    return "{ " +
      "id: "       + this.id        + " " +
      "modified: " + this.modified  + " " +
      "ttl: "      + this.ttl       + " " +
      "index: "    + this.sortindex + " " +
      "payload: "  + this.payload   +
      " }";
  },
};

/**
 * Represents an error encountered during a StorageServiceRequest request.
 *
 * This is effectively a glorified wrapper type. Inside each type is the
 * underlying Error object available at a specific property.
 */
function StorageServiceRequestError() {
  this._network = null;
  this._authentication = null;
  this._client = null;
}
StorageServiceRequestError.prototype = {
  /**
   * The underlying network error.
   *
   * If set, this will be an error thrown by the Gecko network stack. It
   * represents the lowest-level error possible. If this is set, it likely
   * means the request could not be performed or that an error occurred when
   * the request was in-flight and before it had finished.
   */
  get network() {
    return this._network;
  },

  /**
   * The underlying authentication error.
   *
   * If an authentication error occurred (likely a 401 Not Authorized), this
   * will be set to an Error instance.
   */
  get authentication() {
    return this._authentication;
  },

  /**
   * The underlying client error.
   */
  get client() {
    return this._client;
  },
};

/**
 * Represents a request to the storage service.
 *
 * Instances of this type are returned by the APIs on StorageServiceClient.
 * They should not be created outside of StorageServiceClient.
 *
 * This type encapsulates common storage API request and response handling.
 * Metadata required to perform the request is stored inside each instance and
 * should be treated as invisible by consumers.
 *
 * A number of "public" properties are exposed to allow clients to further
 * customize behavior. These are documented below.
 *
 * Some APIs in StorageServiceClient define their own types which inherit from
 * this one. Read the API documentation to see which types those are and when
 * they apply.
 *
 * This type wraps RESTRequest rather than extending it. The reason is mainly
 * to avoid the fragile base class problem. We implement considerable extra
 * functionality on top of RESTRequest and don't want this to accidentally
 * trample on RESTRequest's members.
 *
 * If this were a C++ class, it and StorageServiceClient would be friend
 * classes. Each touches "protected" APIs of the other. Thus, each should be
 * considered when making changes to the other.
 *
 * USAGE
 *
 * When you obtain a request instance, it is waiting to be dispatched. It may
 * have additional variables available for tuning. See the documentation in
 * StorageServiceClient for more.
 *
 * There are essentially two types of requests: "basic" and "streaming."
 * "Basic" requests encapsulate the traditional request-response paradigm:
 * a request is issued and we get a response later once the full response
 * is available. Most of the APIs in StorageServiceClient issue these "basic"
 * requests.
 *
 * For basic requests, the general flow looks something like:
 *
 *   // Obtain the request instance.
 *   let request = client.getCollectionInfo();
 *
 *   // Install an onComplete handler to be executed when response is ready:
 *   request.onComplete = function() { ... };
 *
 *   // Send the request.
 *   request.dispatch();
 *
 *
 * All of the complexity is in your onComplete handler. But, it's not too bad.
 * For basic requests, the first thing you do in your onComplete handler is
 * check the success of the request. Actually, the implementation forces you to
 * do this before you can access the response!
 *
 *   function onComplete() {
 *     // "this" inside the handler is the StorageServiceRequest instance.
 *
 *   }
 *
 */
function StorageServiceRequest() {
  this._log = Log4Moz.repository.getLogger("Sync.StorageService.Request");
  this._log.level = Log4Moz.Level[Svc.Prefs.get("log.logger.storageserviceclient")];

  this._client = null;
  this._request = null;
  this._method = null;
  this._data = null;
  this._completeParser = null;
  this._resultObj = null;
}
StorageServiceRequest.prototype = {
  /**
   * The StorageServiceClient this request came from.
   */
  get client() {
    return this._client;
  },

  /**
   * The underlying RESTRequest instance.
   *
   * This should be treated as read only and should not be modified
   * directly by external callers. While modification would probably work, this
   * would defeat the purpose of the API and the abstractions it is meant to
   * provide.
   *
   * If a consumer needs to modify the underlying request object, it is
   * recommended for them to implement a new type that inherits from
   * StorageServiceClient and override the necessary APIs to modify the request
   * there.
   *
   * This accessor may disappear in future versions.
   */
  get request() {
    return this._request;
  },

  /**
   * The RESTResponse that resulted from the RESTRequest.
   */
  get response() {
    return this._request.response;
  },

  /**
   * HTTP status code from response.
   */
  get statusCode() {
    let response = this.response;
    return response ? response.status : null;
  },

  /**
   * Holds any error that has occurred.
   *
   * If a network error occurred, that will be returned. If no network error
   * occurred, the client error will be returned. If no error occurred (yet),
   * null will be returned.
   */
  get error() {
    return this._networkError ? this._networkError : this._clientError;
  },

  get networkError() {
    return this._networkError;
  },

  get clientError() {
    return this._clientError;
  },

  /**
   * The result from the request.
   *
   * This stores the object returned from the server. The type of object depends
   * on the request type. See the per-API documentation in StorageServiceClient
   * for details.
   */
  get resultObj() {
    return this._resultObj;
  },

  /**
   * Whether the response is an HTTP 404 Not Found.
   */
  get notFound() {
    return this.statusCode == 404;
  },

  //------------------------------------------------------------
  // Event Handlers                                            |
  //                                                           |
  // Define these to receive events during request processing. |
  //------------------------------------------------------------

  /**
   * Function called immediately before request dispatch.
   *
   * The function receives the following arguments:
   *
   *   (StorageServiceClient) The client issuing the request.
   *   (StorageServiceRequest) The request being issued (this request).
   *
   * This hook can be used to inject authentication information into the
   * outgoing request. e.g.
   *
   *   let request = client.getCollectionInfo();
   *   request.onDispatch = function(req) {
   *     req.request.setHeader("authorization", "foo;bar");
   *   }
   *   request.onComplete = function() {
   *     ...
   *   }
   *   request.dispatch();
   *
   * See also the onDispatch listener in StorageServiceClient.addListener().
   */
  onDispatch: null,

  /**
   * Function to be invoked on request completion.
   *
   * The function receives no arguments. Instead, state is captured in the
   * request object, which is available as "this" to the installed
   * function.
   *
   * For requests that have responses, the decoded response object is typically
   * available as a property on the request instance. Read the documentation
   * for the specific client API for more.
   *
   * Every client almost certainly wants to install this handler.
   */
  onComplete: null,

  //---------------
  // General APIs |
  //---------------

  /**
   * Start the request.
   *
   * The request is dispatched asynchronously. One of the various callbacks
   * on this instance will be invoked upon completion.
   */
  dispatch: function dispatch() {
    // Installing the dummy callback makes implementation easier in _onComplete
    // because we can then blindly call.
    let self = this;
    this._dispatch(function(error) {
      self._onComplete(error);
      self.completed = true;
    });
  },

  /**
   * This is a synchronous version of dispatch().
   *
   * THIS IS AN EVIL FUNCTION AND SHOULD NOT BE CALLED. It is provided for
   * legacy reasons to support evil, synchronous clients.
   *
   * Please note that onComplete callbacks are executed from this JS thread.
   * We dispatch the request, spin the event loop until it comes back. Then,
   * we execute callbacks ourselves then return. In other words, there is no
   * potential for spinning between callback execution and this function
   * returning.
   */
  dispatchSynchronous: function dispatchSynchronous() {
    let cb = Async.makeSyncCallback();
    this._dispatch(cb);
    let error = Async.waitForSyncCallback(cb);

    this._onComplete(error);
    this.completed = true;
  },

  //-------------------------------------------------------------------------
  // HIDDEN APIS. DO NOT CHANGE ANYTHING UNDER HERE FROM OUTSIDE THIS TYPE. |
  //-------------------------------------------------------------------------

  _log: null,
  _client: null,
  _request: null,
  _method: null,

  /**
   * Data to include in HTTP request body.
   */
  _data: null,

  /**
   * Handler to parse response body into another object.
   *
   * This is installed by the client API. It should return the value the body
   * parses to on success. If a failure is encountered, an exception should be
   * thrown.
   */
  _completeParser: null,

  /**
   * Network error that was encountered during request, if any.
   *
   * This is the object that is passed to the RESTRequest.onComplete callback.
   */
  _networkError: null,

  /**
   * Non-network error encountered during request, if any.
   *
   * If the error was a result of the client being misconfigured or the server
   * sending an unexpected response, this should be set.
   */
  _clientError: null,

  /**
   * Dispatch the request.
   *
   * This contains common functionality for dispatching requests. It should
   * ideally be part of dispatch, but since dispatchSynchronous exists, we
   * factor out common code.
   */
  _dispatch: function _dispatch(onComplete) {
    // RESTRequest throws if the request has already been dispatched, so we
    // need not bother.

    if (this._onDispatch) {
      this._onDispatch();
    }

    if (this.onDispatch) {
      this.onDispatch(this);
    }

    this._client.runListeners("onDispatch", this._client, this);

    // Add reference to ourselves in the RESTRequest instance.
    this._request._serviceRequest = this;

    this._log.info("Dispatching request: " + this._method + " " +
                   this._request.uri.asciiSpec);

    let self = this;
    if (!this.onComplete) {
      this.onComplete = function() {
        self.completed = true;
      };
    }

    this._request.dispatch(this._method, this._data, onComplete);
  },

  /**
   * RESTRequest onComplete handler for all requests.
   *
   * This provides common logic for all response handling.
   */
  _onComplete: function(error) {
    let onCompleteCalled = false;

    let callOnComplete = function callOnComplete() {
      onCompleteCalled = true;
      try {
        this.onComplete();
      } catch (ex) {
        this._log.warn("Exception when calling onComplete: " + ex);
        throw ex;
      } finally {
        this.onComplete = null;
      }
    }.bind(this);

    try {
      if (error) {
        this.success = false;
        this._networkError = error;
        this._log.info("Network error during request: " + error);
        this._client.runListeners("onNetworkError", this._client, this, error);
        callOnComplete();
        return;
      }

      let response = this._request.response;
      this._log.info(response.status + " " + this._request.uri.asciiSpec);

      this._processHeaders();

      if (response.status == 200) {
        this._resultObj = this._completeParser(response);
        this.success = true;
        callOnComplete();
        return;
      }

      if (response.status == 204) {
        this.success = true;
        callOnComplete();
        return;
      }

      if (response.status == 304) {
        this.success = true;
        this.notModified = true;
        callOnComplete();
        return;
      }

      // TODO handle numeric response code from server.
      if (response.status == 400) {
        this._clientError = new Error("Client error!");
        callOnComplete();
        return;
      }

      if (response.status == 401) {
        this._clientError = new Error("401 Received.");
        this._client.runListeners("onAuthFailure", this._client, this);
        callOnComplete();
        return;
      }

      if (response.status == 503) {
        this._clientError = new Error("503 Received.");
      }

      callOnComplete();

    } catch (ex) {
      this._clientError = ex;
      this._log.info("Exception when processing _onComplete: " + ex);

      if (this.onComplete) {
        try {
          callOnComplete();
        } catch (ex) {}
      }
    }
  },

  _processHeaders: function _processHeaders() {
    let headers = this._request.response.headers;

    if (headers["x-timestamp"]) {
      this.serverTime = parseFloat(headers["x-timestamp"]);
    }

    if (headers["x-backoff"]) {
      this.backoffInterval = 1000 * parseInt(headers["x-backoff"], 10);
    }

    if (headers["retry-after"]) {
      this.backoffInterval = 1000 * parseInt(headers["retry-after"], 10);
    }

    if (this.backoffInterval) {
      let failure = this._request.response.status == 503;
      this._client.runListeners("onBackoffReceived", this._client, this,
                               this.backoffInterval, !failure);
    }

    if (headers["x-quota-remaining"]) {
      this.quotaRemaining = parseInt(headers["x-quota-remaining"], 10);
      this._client.runListeners("onQuotaRemaining", this._client, this,
                               this.quotaRemaining);
    }
  },
};

/**
 * Represents a request to fetch from a collection.
 *
 * These requests are highly configurable so they are given their own type.
 * This type inherits from StorageServiceRequest and provides additional
 * controllable parameters.
 *
 * By default, requests are issued in "streaming" mode. As the client receives
 * data from the server, it will invoke the caller-supplied onBSORecord
 * callback for each record as it is ready. When all records have been received,
 * it will invoke onComplete like normal. To change this behavior, modify the
 * "streaming" property before the request is dispatched.
 */
function StorageCollectionGetRequest() {}
StorageCollectionGetRequest.prototype = {
  __proto__: StorageServiceRequest.prototype,

  _namedArgs: {},

  _streaming: true,

  /**
   * Control whether streaming mode is in effect.
   *
   * Read the type documentation above for more details.
   */
  set streaming(value) {
    this._streaming = !!value;
  },

  /**
   * Define the set of IDs to fetch from the server.
   */
  set ids(value) {
    this._namedArgs.ids = value.join(",");
  },

  set older(value) {
    this._namedArgs.older = value;
  },

  set newer(value) {
    this._namedArgs.newer = value;
  },

  set full(value) {
    if (value) {
      this._namedArgs.full = "1";
    } else {
      delete this._namedArgs["full"];
    }
  },

  set index_above(value) {
    this._namedArgs.index_above = value;
  },

  set index_below(value) {
    this._namedArgs.index_below = value;
  },

  set limit(value) {
    this._namedArgs.limit = value;
  },

  set offset(value) {
    this._namedArgs.offset = value;
  },

  set sortOldest(value) {
    this._namedArgs.sort = "oldest";
  },

  set sortNewest(value) {
    this._namedArgs.sort = "newest";
  },

  set sortIndex(value) {
    this._namedArgs.sort = "index";
  },

  /**
   * Callback to be invoked for each record received from the server.
   *
   * This is only invoked when in "streaming" mode, which is the default
   * behavior.
   */
  onBSORecord: null,

  _onDispatch: function _onDispatch() {
    // TODO intelligent URI rewriting.
    this._request.uri += "?" + this._getQueryString();
  },

  _getQueryString: function _getQueryString() {
    let args = [];
    for (let [k, v] in Iterator(this._namedArgs)) {
      // TODO URI encode.
      args.push(k + "=" + value);
    }

    return args.join("&");
  },

};

/**
 * Construct a new client for the SyncStorage API, version 2.0.
 *
 * Clients are constructed against a base URI. This URI is typically obtained
 * from the token server via the service_entry component of a successful token
 * response.
 *
 * The purpose of this type is to serve as a middleware between Sync's core
 * logic and the HTTP API. It hides the details of how the storage API is
 * implemented but exposes important events, such as when auth goes bad or the
 * server requests the client to back off.
 *
 * All APIs operate by returning a StorageServiceRequest instance. The caller
 * then installs the appropriate callbacks on each instance and then dispatches
 * the request.
 *
 * Each client instance also serves as a controller and coordinator for
 * associated requests. Callers can install listeners for common events on the
 * client and take the appropriate action whenever any associated request
 * observes them. For example, you will only need to register one listener for
 * backoff observation as opposed to one on each request.
 *
 * While not currently supported, a future goal of this type is to support
 * more advanced transport channels, such as SPDY, to allow for faster and more
 * efficient API calls. The API is thus designed to abstract transport specifics
 * away from the caller.
 *
 * Storage API consumers almost certainly have added functionality on top of the
 * storage service. It is encouraged to create a child type which adds
 * functionality to this layer.
 *
 * @param baseURI
 *        (string) Base URI for all requests.
 */
function StorageServiceClient(baseURI) {
  this._log = Log4Moz.repository.getLogger("Sync.StorageServiceClient");
  this._log.level =
    Log4Moz.Level[Svc.Prefs.get("log.logger.storageserviceclient")];

  this._baseURI = baseURI;

  if (this._baseURI[this._baseURI.length-1] != "/") {
    this._baseURI += "/";
  }

  this._log.info("Creating new StorageServiceClient under " + this._baseURI);

  this._listeners = [];
}
StorageServiceClient.prototype = {
  /**
   * The user agent sent with every request.
   *
   * You probably want to change this.
   */
  userAgent: "StorageServiceClient",

  _baseURI: null,
  _log: null,

  _listeners: null,

  //----------------------------
  // Event Listener Management |
  //----------------------------

  /**
   * Adds a listener to this client instance.
   *
   * Listeners allow other parties to react to and influence execution of the
   * client instance.
   *
   * An event listener is simply an object that exposes functions which get
   * executed during client execution. Objects can expose 0 or more of the
   * following keys:
   *
   *   onDispatch - Callback notified immediately before a request is
   *     dispatched. This gets called for every outgoing request. The function
   *     receives as its arguments the client instance and the outgoing
   *     StorageServiceRequest. This listener is useful for global
   *     authentication handlers, which can modify the request before it is
   *     sent.
   *
   *   onAuthFailure - This is called when any request has experienced an
   *     authentication failure.
   *
   *     This callback receives the following arguments:
   *
   *       (StorageServiceClient) Client that encountered the auth failure.
   *       (StorageServiceRequest) Request that encountered the auth failure.
   *
   *   onBackoffReceived - This is called when a backoff request is issued by
   *     the server. Backoffs are issued either when the service is completely
   *     unavailable (and the client should abort all activity) or if the server
   *     is under heavy load (and has completed the current request but is
   *     asking clients to be kind and stop issuing requests for a while).
   *
   *     This callback receives the following arguments:
   *
   *       (StorageServiceClient) Client that encountered the backoff.
   *       (StorageServiceRequest) Request that received the backoff.
   *       (number) Integer milliseconds the server is requesting us to back off
   *         for.
   *       (bool) Whether the request completed successfully. If false, the
   *         client should cease sending additional requests immediately, as
   *         they will likely fail. If true, the client is allowed to continue
   *         to put the server in a proper state. But, it should stop and heed
   *         the backoff as soon as possible.
   *
   *   onNetworkError - This is called for every network error that is
   *     encountered.
   *
   *     This callback receives the following arguments:
   *
   *       (StorageServiceClient) Client that encountered the network error.
   *       (StorageServiceRequest) Request that encountered the error.
   *       (Error) Error passed in to RESTRequest's onComplete handler. It has
   *         a result property, which is a Components.Results enumeration.
   *
   *   onQuotaRemaining - This is called if any request sees updated quota
   *     information from the server. This provides an update mechanism so
   *     listeners can immediately find out quota changes as soon as they
   *     are made.
   *
   *     This callback receives the following arguments:
   *
   *       (StorageServiceClient) Client that encountered the quota change.
   *       (StorageServiceRequest) Request that received the quota change.
   *       (number) Integer number of kilobytes remaining for the user.
   */
  addListener: function addListener(listener) {
    if (!listener) {
      throw new Error("listener argument must be an object.");
    }

    if (!this._listeners.some(function(i) { return i == listener; })) {
      this._listeners.push(listener);
    }
  },

  /**
   * Remove a previously-installed listener.
   */
  removeListener: function removeListener(listener) {
    this._listeners = this._listeners.filter(function(a) {
      return a != listener;
    });
  },

  /**
   * Invoke listeners for a specific event.
   *
   * @param name
   *        (string) The name of the listener to invoke.
   * @param args
   *        (array) Arguments to pass to listener functions.
   */
  runListeners: function runListeners(name) {
    let args = Array.slice(arguments, 1);

    this._listeners.forEach(function(listener) {
      try {
        if (name in listener) {
          listener[name].apply(listener, args);
        }
      } catch (ex) {
        this._log.warn("Listener threw an exception during " + name + ":" + ex);
      }
    });
  },

  //-----------------------------
  // Information/Metadata APIs  |
  //-----------------------------

  /**
   * Obtain a request that fetches collection info.
   *
   * On successful response, the result is placed in the resultObj property
   * of the request object.
   *
   * The result value is a map of strings to numbers. The string keys represent
   * collection names. The number values are integer milliseconds since Unix
   * epoch that hte collection was last modified.
   *
   * Example Usage:
   *
   *   let request = client.getCollectionInfo();
   *   request.onComplete = function() {
   *     if (!this.success) {
   *       return;
   *     }
   *
   *     for (let [collection, milliseconds] in Iterator(this.resultObj)) {
   *       // ...
   *     }
   *   };
   */
  getCollectionInfo: function getCollectionInfo() {
    return this._getJSONGETRequest("info/collections");
  },

  /**
   * Fetch quota information.
   *
   * The result in the callback upon success is a map containing quota
   * metadata. It will have the following keys:
   *
   *   usage - Number of kilobytes currently utilized.
   *   quota - Number of kilobytes available to account.
   */
  getQuota: function getQuota() {
    return this._getJSONGETRequest("info/quota");
  },

  /**
   * Fetch information on how much data each collection uses.
   *
   * The result on success is a map of strings to numbers. The string keys
   * are collection names. The values are numbers corresponding to the number
   * of kilobytes used by that collection.
   */
  getCollectionUsage: function getCollectionUsage() {
    return this._getJSONGETRequest("info/collection_usage");
  },

  /**
   * Fetch the number of records in each collection.
   *
   * The result on success is a map of strings to numbers. The string keys are
   * collection names. The values are numbers corresponding to the integer
   * number of items in that collection.
   */
  getCollectionCounts: function getCollectionCounts() {
    return this._getJSONGETRequest("info/collection_counts");
  },

  //--------------------------
  // Collection Interaction  |
  // -------------------------

  /**
   * Obtain a request to fetch collection information.
   *
   * The returned request instance is a StorageCollectionGetRequest instance.
   * This is a sub-type of StorageServiceRequest and offers a number of setters
   * to control how the request is performed.
   */
  getCollection: function getCollection(collection) {
    if (collection) {
      throw new Error("collection argument must be defined.");
    }

    let uri = this._baseURI + "storage/" + collection;

    let request = this._getRequest(uri, "GET");
    request.prototype = StorageCollectionGetRequest.prototype;

    return request;
  },

  /**
   * Fetch a single Basic Storage Object (BSO).
   *
   * On success, the BSO may be available in the resultObj property of the
   * request as a BasicStorageObject instance.
   *
   * It is possible to make the request conditional or for the server to say
   * the BSO was not found. See the documentation in StorageServiceRequest for
   * detail.
   *
   * Example usage:
   *
   *   let request = client.getBSO("meta", "global");
   *   request.onComplete = function() {
   *     if (!this.success) {
   *       return;
   *     }
   *
   *     let bso = request.bso;
   *     let payload = bso.payload;
   *
   *     ...
   *   };
   *   request.dispatch();
   *
   * @param collection
   *        (string) Collection to fetch from
   * @param id
   *        (string) ID of BSO to retrieve.
   * @param type
   *        (constructor) Constructor to call to create returned object. This
   *        is optional and defaults to BasicStorageObject.
   */
  getBSO: function fetchBSO(collection, id, type) {
    if (!collection) {
      throw new Error("collection argument must be defined.");
    }

    if (!id) {
      throw new Error("id argument must be defined.");
    }

    if (!type) {
      type = BasicStorageObject;
    }

    let uri = this._baseURI + "storage/" + collection + "/" + id;

    return this._getRequest(uri, "GET", {
      accept: "application/json",
      completeParser: function(response) {
        let record = new type(id, collection);
        record.deserialize(response.body);

        return record;
      },
    });
  },

  /**
   * Add or update a BSO in a collection.
   *
   * TODO Support If-Unmodified-Since.
   *
   * @param collection
   *        (string) Collection to add BSO to.
   * @param id
   *        (string) ID of BSO to write.
   * @param bso
   *        (BasicStorageObject) BSO to upload.
   */
  setBSO: function setBSO(collection, id, bso) {
    if (!collection) {
      throw new Error("collection argument must be defined.");
    }

    if (!id) {
      throw new Error("id argument must be defined.");
    }

    if (!bso) {
      throw new Error("bso argument must be defined.");
    }

    if (bso.id && bso.id != id) {
      throw new Error("id in passed BSO does not match id argument!");
    }

    let uri = this._baseURI + "storage/" + collection + "/" + id;
    return this._getRequest(uri, "PUT", {
      contentType: "application/json",
      data:        bso.toJSON(),
    });
  },

  /**
   * Add or update multiple BSOs.
   *
   * This is roughly equivalent to calling setBSO multiple times.
   *
   * Future improvement: support streaming of uploaded records. Currently, data
   * is buffered in the client before going over the wire. Ideally, we'd support
   * sending over the wire as soon as data is available.
   */
  setBSOs: function setBSOs(collection) {
    if (!collection) {
      throw new Error("collection argument must be defined.");
    }

    let uri = this._baseURI + "storage/" + collection;
    let request = this._getRequest(uri, "POST", {

    });

    return request;
  },

  /**
   * Deletes a single BSO from a collection.
   *
   * @param collection
   *        (string) Collection to operate on.
   * @param id
   *        (string) ID of record to delete.
   */
  deleteBSO: function deleteBSO(collection, id) {
    if (!collection) {
      throw new Error("collection argument must be defined.");
    }

    if (!id) {
      throw new Error("id argument must be defined.");
    }

    let uri = this._baseURI + "storage/" + collection + "/" + id;
    let request = this._getRequest(uri, "DELETE", {

    });

    return request;
  },

  /**
   * Deletes all collections data from the server.
   */
  deleteCollections: function deleteCollections() {
    let uri = this._baseURI + "storage";
    let request = new RESTRequest(uri);

    throw new Error("not yet implemented.");
    return this._getRequest(request, "DELETE", {
      completeParser: function(response) {

      }
    });
  },

  _getJSONGETRequest: function _startSimpleGetRequest(path) {
    let uri = this._baseURI + path;

    return this._getRequest(uri, "GET", {
      accept:         "application/json",
      completeParser: this._jsonResponseParser,
    });
  },

  /**
   * Common logic for issuing an HTTP request.
   *
   * @param uri
   *        (string) URI to request.
   * @param method
   *        (string) HTTP method to issue.
   * @param options
   *        (object) Additional options to control request and response
   *          handling. Keys influencing behavior are:
   *
   *          completeParser - Function that parses a HTTP response body into a
   *            value. This function receives the RESTResponse object and
   *            returns a value that is added to a StorageResponse instance.
   *            If the response cannot be parsed or is invalid, this function
   *            should throw an exception.
   *
   *          data - Data to be sent in HTTP request body.
   *
   *          accept - Value for Accept request header.
   *
   *          contentType - Value for Content-Type request header.
   */
  _getRequest: function _getRequest(uri, method, options) {
    let request = new RESTRequest(uri);

    if (Svc.Prefs.get("sendVersionInfo", true)) {
      let ua = this.userAgent + Svc.Prefs.get("client.type", "desktop");
      request.setHeader("user-agent", ua);
    }

    if (options.accept) {
      request.setHeader("accept", options.accept);
    }

    if (options.contentType) {
      request.setHeader("content-type", options.contentType);
    }

    let result = new StorageServiceRequest();
    result._request = request;
    result._method = method;
    result._client = this;
    result._data = options.data;
    result._completeParser = options.completeParser;

    return result;
  },

  _jsonResponseParser: function _jsonResponseParser(response) {
    let ct = response.headers["content-type"];
    if (!ct) {
      throw new Error("No Content-Type response header! Misbehaving server!");
    }

    if (ct != "application/json" && ct.indexOf("application/json;") != 0) {
      throw new Error("Non-JSON media type: " + ct);
    }

    return JSON.parse(response.body);
  },
};
