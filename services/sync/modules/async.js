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
 * The Original Code is Firefox Sync.
 *
 * The Initial Developer of the Original Code is Mozilla.
 * Portions created by the Initial Developer are Copyright (C) 2007
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
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

const EXPORTED_SYMBOLS = ['Async'];

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cr = Components.results;
const Cu = Components.utils;

// Constants for makeSyncCallback, waitForSyncCallback
const CB_READY = {};
const CB_COMPLETE = {};
const CB_FAIL = {};

const REASON_ERROR = Ci.mozIStorageStatementCallback.REASON_ERROR;

Cu.import("resource://services-sync/util.js");

/*
 * Helpers for various async operations.
 */
let Async = {

  /**
   * Helpers for making asynchronous calls within a synchronous API possible.
   *
   * If you value your sanity, do not look closely at the following functions.
   */

  /**
   * Create a sync callback that remembers state like whether it's been called
   */
  makeSyncCallback: function makeSyncCallback() {
    // The main callback remembers the value it's passed and that it got data
    let onComplete = function onComplete(data) {
      onComplete.state = CB_COMPLETE;
      onComplete.value = data;
    };

    // Initialize private callback data to prepare to be called
    onComplete.state = CB_READY;
    onComplete.value = null;

    // Allow an alternate callback to trigger an exception to be thrown
    onComplete.throw = function onComplete_throw(data) {
      onComplete.state = CB_FAIL;
      onComplete.value = data;

      // Cause the caller to get an exception and stop execution
      throw data;
    };

    return onComplete;
  },

  /**
   * Wait for a sync callback to finish
   */
  waitForSyncCallback: function waitForSyncCallback(callback) {
    // Grab the current thread so we can make it give up priority
    let thread = Cc["@mozilla.org/thread-manager;1"].getService().currentThread;

    // Keep waiting until our callback is triggered unless the app is quitting
    while (Utils.checkAppReady() && callback.state == CB_READY) {
      thread.processNextEvent(true);
    }

    // Reset the state of the callback to prepare for another call
    let state = callback.state;
    callback.state = CB_READY;

    // Throw the value the callback decided to fail with
    if (state == CB_FAIL) {
      throw callback.value;
    }

    // Return the value passed to the callback
    return callback.value;
  },

  // Return the two things you need to make an asynchronous call synchronous.
  synchronously: function synchronously() {
    let cb = Async.makeSyncCallback();
    function callback(error, ret) {
      if (error)
        cb.throw(error);
      cb(ret);
    }
    callback.wait = function() Async.waitForSyncCallback(cb);
    return callback;
  },

  // Synchronously invoke a method that takes only a `callback` argument.
  callSynchronously: function callSynchronously(self, method) {
    let callback = this.synchronously();
    method.call(self, callback);
    return callback.wait();
  },

  /*
   * Produce a sequence of callbacks which -- when all have been executed
   * successfully *or* any have failed -- invoke the output callback.
   *
   * Each input callback should have the signature (error, result), and should
   * return a truthy value if the computation should be considered to have
   * failed.
   *
   * The contents of ".data" on each input callback are copied to the
   * resultant callback items. This can save some effort on the caller's side.
   *
   * These callbacks are assumed to be single-valued, which covers the common
   * cases without the expense of `arguments`.
   */
  barrieredCallbacks: function (callbacks, output) {
    let counter = 0;
    function makeCb(input) {
      let cb = function(error, result) {
        if (!output)
          return;

        let err = input(error, result);
        if ((0 == --counter) || err) {
          output(err);
          output = undefined;
        }
      };
      cb.data = input.data;
      return cb;
    }
    return callbacks.map(function (input) {
                           counter++;
                           return makeCb(input);
                         });
  },

  /*
   * Exactly like barrieredCallbacks, but with the same callback each time.
   */
  countedCallback: function (componentCb, count, output) {
    let counter = count;
    return function (error, result) {
      if (!output)
        return;

      let err = componentCb(error, result);
      if ((0 == --counter) || err) {
        output(err);
        output = undefined;      // Abandon!
      }
    };
  },

  /*
   * Return a callback which executes `f` then `callback`, regardless of
   * whether it was invoked with an error. If an exception is thrown during the
   * evaluation of `f`, it takes precedence over an error provided to the
   * callback.
   *
   * This behaves similarly to a try..finally block in plain JavaScript.
   */
  finallyCallback: function (callback, f) {
    return function(err) {
      try {
        f();
        callback(err);
      } catch (ex) {
        callback(ex);
      }
    };
  },

  // Prototype for mozIStorageCallback, used in queryAsync below.
  // This allows us to define the handle* functions just once rather
  // than on every queryAsync invocation.
  _storageCallbackPrototype: {
    results: null,

    // These are set by queryAsync.
    names: null,
    syncCb: null,

    handleResult: function handleResult(results) {
      if (!this.names) {
        return;
      }
      if (!this.results) {
        this.results = [];
      }
      let row;
      while ((row = results.getNextRow()) != null) {
        let item = {};
        for each (name in this.names) {
          item[name] = row.getResultByName(name);
        }
        this.results.push(item);
      }
    },
    handleError: function handleError(error) {
      this.syncCb.throw(error);
    },
    handleCompletion: function handleCompletion(reason) {

      // If we got an error, handleError will also have been called, so don't
      // call the callback! We never cancel statements, so we don't need to
      // address that quandary.
      if (reason == REASON_ERROR)
        return;

      // If we were called with column names but didn't find any results,
      // the calling code probably still expects an array as a return value.
      if (this.names && !this.results) {
        this.results = [];
      }
      this.syncCb(this.results);
    }
  },

  querySynchronously: function(query, names) {
    // Synchronously asyncExecute fetching all results by name
    let storageCallback = {names: names,
                           syncCb: Async.makeSyncCallback()};
    storageCallback.__proto__ = Async._storageCallbackPrototype;
    query.executeAsync(storageCallback);
    return Async.waitForSyncCallback(storageCallback.syncCb);
  },
};
