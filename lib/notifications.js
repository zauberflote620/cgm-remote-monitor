'use strict';

var _ = require('lodash');
var THIRTY_MINUTES = 30 * 60 * 1000;
var DEFAULT_GROUPS = ['default'];

var Alarm = function(level, group, label) {
  this.level = level;
  this.group = group;
  this.label = label;
  this.silenceTime = THIRTY_MINUTES;
  this.lastAckTime = 0;
};

// list of alarms with their thresholds
var alarms = {};

function init (env, ctx) {

  var REFRESH_TIMEOUT_MS = 5000;

  // Rate-limited warn: at most one log per (key) per 60s window.
  // Used to avoid log floods during a sustained Mongo outage when users repeatedly
  // tap ack buttons or alarms re-evaluate every cycle.
  var lastWarnAt = {};
  function rateLimitedWarn (key, message) {
    var now = Date.now();
    if (!lastWarnAt[key] || now - lastWarnAt[key] > 60000) {
      lastWarnAt[key] = now;
      console.warn(message);
    }
  }

  function notifications () {
    return notifications;
  }

  function getAlarm (level, group) {
    group = group || 'default';
    var key = level + '-' + group;
    var alarm = alarms[key];
    if (!alarm) {
      var display = group === 'default' ? ctx.levels.toDisplay(level) : group + ':' + level;
      alarm = new Alarm(level, group, display);
      alarms[key] = alarm;
      // Gate first emission for this (level, group) on this process until storage
      // refresh resolves OR the deadline passes. Closes the cold-start race where
      // a fresh process emits an alarm that another instance already snoozed.
      if (ctx.alarmStorage && typeof ctx.alarmStorage.getSnooze === 'function') {
        alarm.refreshPending = true;
        alarm.refreshDeadline = Date.now() + REFRESH_TIMEOUT_MS;
        ctx.alarmStorage.getSnooze(level, group).then(function (doc) {
          if (!alarm.refreshPending) return;
          if (doc && doc.lastAckTime > alarm.lastAckTime) {
            alarm.lastAckTime = doc.lastAckTime;
            alarm.silenceTime = doc.silenceTime;
          }
          alarm.refreshPending = false;
        }).catch(function (err) {
          rateLimitedWarn('getSnooze:' + level + '-' + group,
            'alarmStorage.getSnooze failed for ' + level + '-' + group + ': ' + err.message);
          alarm.refreshPending = false;
        });
      }
    }

    return alarm;
  }

  //should only be used when auto acking the alarms after going back in range or when an error corrects
  //setting the silence time to 1ms so the alarm will be re-triggered as soon as the condition changes
  //since this wasn't ack'd by a user action
  function autoAckAlarms (group) {

    var sendClear = false;

    for (var level = 1; level <= 2; level++) {
      var alarm = getAlarm(level, group);
      if (alarm.lastEmitTime) {
        console.info('auto acking ' + alarm.level, ' - ', group);
        notifications.ack(alarm.level, group, 1);
        sendClear = true;
      }
    }

    if (sendClear) {
      var notify = { clear: true, title: 'All Clear', message: 'Auto ack\'d alarm(s)', group: group };
      ctx.bus.emit('notification', notify);
      logEmitEvent(notify);
    }
  }

  function emitNotification (notify) {
    var alarm = getAlarm(notify.level, notify.group);
    // Defer emission while storage refresh is pending and within the timeout window.
    // After the deadline, fall through and emit based on whatever in-memory state holds.
    if (alarm.refreshPending) {
      if (Date.now() < alarm.refreshDeadline) {
        console.log(alarm.label + ' alarm deferred — awaiting storage refresh');
        return;
      }
      alarm.refreshPending = false;
    }
    if (ctx.ddata.lastUpdated > alarm.lastAckTime + alarm.silenceTime) {
      ctx.bus.emit('notification', notify);
      alarm.lastEmitTime = ctx.ddata.lastUpdated;
      logEmitEvent(notify);
    } else {
      console.log(alarm.label + ' alarm is silenced for ' + Math.floor((alarm.silenceTime - (ctx.ddata.lastUpdated - alarm.lastAckTime)) / 60000) + ' minutes more');
    }
  }

  var requests = {};

  notifications.initRequests = function initRequests () {
    requests = { notifies: [], snoozes: [] };
  };

  notifications.initRequests();

  /**
   * Find the first URGENT or first WARN
   * @returns a notification or undefined
   */
  notifications.findHighestAlarm = function findHighestAlarm (group) {
    group = group || 'default';
    var filtered = _.filter(requests.notifies, { group: group });
    return _.find(filtered, { level: ctx.levels.URGENT }) || _.find(filtered, { level: ctx.levels.WARN });
  };

  notifications.findUnSnoozeable = function findUnSnoozeable () {
    return _.filter(requests.notifies, function(notify) {
      return notify.level <= ctx.levels.INFO || notify.isAnnouncement;
    });
  };

  notifications.snoozedBy = function snoozedBy (notify) {
    if (notify.isAnnouncement) { return false; }

    var filtered = _.filter(requests.snoozes, { group: notify.group });

    if (_.isEmpty(filtered)) { return false; }

    var byLevel = _.filter(filtered, function checkSnooze (snooze) {
      return snooze.level >= notify.level;
    });
    var sorted = _.sortBy(byLevel, 'lengthMills');

    return _.last(sorted);
  };

  notifications.requestNotify = function requestNotify (notify) {
    if (!Object.prototype.hasOwnProperty.call(notify, 'level') || !notify.title || !notify.message || !notify.plugin) {
      console.error(new Error('Unable to request notification, since the notify isn\'t complete: ' + JSON.stringify(notify)));
      return;
    }

    notify.group = notify.group || 'default';

    requests.notifies.push(notify);
  };

  notifications.requestSnooze = function requestSnooze (snooze) {
    if (!snooze.level || !snooze.title || !snooze.message || !snooze.lengthMills) {
      console.error(new Error('Unable to request snooze, since the snooze isn\'t complete: ' + JSON.stringify(snooze)));
      return;
    }

    snooze.group = snooze.group || 'default';

    requests.snoozes.push(snooze);
  };

  notifications.process = function process () {

    var notifyGroups = _.map(requests.notifies, function eachNotify (notify) {
      return notify.group;
    });

    var alarmGroups = _.map(_.values(alarms), function eachAlarm (alarm) {
      return alarm.group;
    });

    var groups = _.uniq(notifyGroups.concat(alarmGroups));

    if (_.isEmpty(groups)) {
      groups = DEFAULT_GROUPS.slice();
    }

    _.each(groups, function eachGroup (group) {
      var highestAlarm = notifications.findHighestAlarm(group);

      if (highestAlarm) {
        var snoozedBy = notifications.snoozedBy(highestAlarm, group);
        if (snoozedBy) {
          logSnoozingEvent(highestAlarm, snoozedBy);
          notifications.ack(snoozedBy.level, group, snoozedBy.lengthMills, true);
        } else {
          emitNotification(highestAlarm);
        }
      } else {
        autoAckAlarms(group);
      }
    });

    notifications.findUnSnoozeable().forEach(function eachInfo (notify) {
      emitNotification(notify);
    });
  };

  notifications.ack = function ack (level, group, time, sendClear) {
    group = group || 'default';
    var alarm = getAlarm(level, group);
    if (!alarm) {
      console.warn('Got an ack for an unknown alarm time, level:', level, ', group:', group);
      return;
    }

    var now = Date.now();
    var newSilenceTime = time ? time : THIRTY_MINUTES;
    var newExpiresAt = now + newSilenceTime;
    var existingExpiresAt = alarm.lastAckTime + alarm.silenceTime;

    // Allow extension of an active snooze; reject only when the new ack would
    // shorten or match the existing window. This preserves the original "don't
    // re-snooze pointlessly" guard while letting users extend snoozes from a
    // different instance after a cross-instance refresh.
    if (now < existingExpiresAt && newExpiresAt <= existingExpiresAt) {
      console.warn('Alarm has already been snoozed past the requested time, ignoring, level:', level, ', group:', group);
      return;
    }

    alarm.lastAckTime = now;
    alarm.silenceTime = newSilenceTime;
    delete alarm.lastEmitTime;
    // User explicitly ack'd — refresh window no longer relevant for this alarm
    alarm.refreshPending = false;

    // Cascade URGENT ack to WARN. Share the timestamp so cross-instance reads
    // of (1, group) and (2, group) agree on a single ack moment.
    var levelsToWrite = (level === 2) ? [2, 1] : [level];

    if (ctx.alarmStorage && typeof ctx.alarmStorage.setSnooze === 'function') {
      levelsToWrite.forEach(function (l) {
        if (l !== level) {
          // Mirror in-memory state on the cascaded WARN alarm so this instance
          // honors the cascade immediately, without waiting for a storage round-trip.
          var warnAlarm = getAlarm(l, group);
          if (newExpiresAt > warnAlarm.lastAckTime + warnAlarm.silenceTime) {
            warnAlarm.lastAckTime = now;
            warnAlarm.silenceTime = newSilenceTime;
            delete warnAlarm.lastEmitTime;
            warnAlarm.refreshPending = false;
          }
        }
        ctx.alarmStorage.setSnooze(l, group, now, newSilenceTime).catch(function (err) {
          rateLimitedWarn('setSnooze:' + l + '-' + group,
            'alarmStorage.setSnooze failed for ' + l + '-' + group + ': ' + err.message);
        });
      });
    } else if (level === 2) {
      // No storage — preserve original cascade-via-recursion semantics in-memory only.
      var warnAlarm = getAlarm(1, group);
      if (newExpiresAt > warnAlarm.lastAckTime + warnAlarm.silenceTime) {
        warnAlarm.lastAckTime = now;
        warnAlarm.silenceTime = newSilenceTime;
        delete warnAlarm.lastEmitTime;
      }
    }

    /*
    * TODO: modify with a local clear, this will clear all connected clients,
    * globally
    */
    if (sendClear) {
      var notify = {
        clear: true
        , title: 'All Clear'
        , message: group + ' - ' + ctx.levels.toDisplay(level) + ' was ack\'d'
        , group: group
      };
      // When web client sends ack, this translates the websocket message into
      // an event on our internal bus.
      ctx.bus.emit('notification', notify);
      logEmitEvent(notify);
    }

  };

  function ifTestModeThen (callback) {
    if (env.testMode) {
      return callback();
    } else {
      throw 'Test only function was called = while not in test mode';
    }
  }

  notifications.resetStateForTests = function resetStateForTests () {
    ifTestModeThen(function doResetStateForTests () {
      console.info('resetting notifications state for tests');
      alarms = {};
    });
  };

  notifications.getAlarmForTests = function getAlarmForTests (level, group) {
    return ifTestModeThen(function doResetStateForTests () {
      group = group || 'default';
      var alarm = getAlarm(level, group);
      console.info('got alarm for tests: ', alarm);
      return alarm;
    });
  };

  notifications.setRefreshTimeoutForTests = function setRefreshTimeoutForTests (ms) {
    ifTestModeThen(function () { REFRESH_TIMEOUT_MS = ms; });
  };

  function notifyToView (notify) {
    return {
      level: ctx.levels.toDisplay(notify.level)
      , title: notify.title
      , message: notify.message
      , group: notify.group
      , plugin: notify.plugin ? notify.plugin.name : '<none>'
      , debug: notify.debug
    };
  }

  function snoozeToView (snooze) {
    return {
      level: ctx.levels.toDisplay(snooze.level)
      , title: snooze.title
      , message: snooze.message
      , group: snooze.group
    };
  }

  function logEmitEvent (notify) {
    var type = notify.level >= ctx.levels.WARN ? 'ALARM' : (notify.clear ? 'ALL CLEAR' : 'NOTIFICATION');
    console.info([
      logTimestamp() + '\tEMITTING ' + type + ':'
      , '  ' + JSON.stringify(notifyToView(notify))
    ].join('\n'));
  }

  function logSnoozingEvent (highestAlarm, snoozedBy) {
    console.info([
      logTimestamp() + '\tSNOOZING ALARM:'
      , '  ' + JSON.stringify(notifyToView(highestAlarm))
      , '  BECAUSE:'
      , '    ' + JSON.stringify(snoozeToView(snoozedBy))
    ].join('\n'));
  }

  //TODO: we need a common logger, but until then...
  function logTimestamp () {
    return (new Date).toISOString();
  }

  return notifications();
}

module.exports = init;
