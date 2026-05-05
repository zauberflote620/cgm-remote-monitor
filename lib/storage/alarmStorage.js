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
    setSnooze: async function () { return null; },
    ensureIndexes: async function () { return null; }
  };
}

module.exports = init;
