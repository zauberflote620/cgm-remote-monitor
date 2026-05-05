'use strict';

var ALARM_COLLECTION = 'alarmsnooze';

function init (ctx) {

  function getCollection () {
    if (!ctx || !ctx.store || typeof ctx.store.collection !== 'function') return null;
    return ctx.store.collection(ALARM_COLLECTION);
  }

  function makeKey (level, group) {
    return level + '-' + (group || 'default');
  }

  return {
    getSnooze: async function getSnooze (level, group) {
      var coll = getCollection();
      if (!coll) return null;
      // Filter expiresAt > now to ignore TTL-lag stale docs
      return await coll.findOne({ _id: makeKey(level, group), expiresAt: { $gt: new Date() } });
    },
    setSnooze: async function setSnooze (level, group, lastAckTime, silenceTime) {
      var coll = getCollection();
      if (!coll) return null;
      var normalizedGroup = group || 'default';
      var newExpiresAt = new Date(lastAckTime + silenceTime);
      // Aggregation-pipeline $set with $cond: only overwrite when new expiresAt
      // is later than the existing one (or when no doc exists yet, via $ifNull).
      // This prevents a shorter snooze from clobbering a longer one across instances.
      var winner = { $gt: [newExpiresAt, { $ifNull: ['$expiresAt', new Date(0)] }] };
      return await coll.updateOne(
        { _id: makeKey(level, normalizedGroup) },
        [{
          $set: {
            level: level,
            group: normalizedGroup,
            lastAckTime: { $cond: [winner, lastAckTime, '$lastAckTime'] },
            silenceTime: { $cond: [winner, silenceTime, '$silenceTime'] },
            expiresAt:   { $cond: [winner, newExpiresAt, '$expiresAt'] }
          }
        }],
        { upsert: true }
      );
    },
    ensureIndexes: async function () { return null; }
  };
}

module.exports = init;
