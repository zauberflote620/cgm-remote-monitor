'use strict';
require('should');

describe('alarmStorage', function () {
  var alarmStorage;

  beforeEach(function () {
    delete require.cache[require.resolve('../lib/storage/alarmStorage')];
    alarmStorage = require('../lib/storage/alarmStorage');
  });

  it('exports a factory function', function () {
    alarmStorage.should.be.a.Function();
  });

  it('factory returns an object with getSnooze, setSnooze, ensureIndexes methods', function () {
    var storage = alarmStorage({});
    storage.getSnooze.should.be.a.Function();
    storage.setSnooze.should.be.a.Function();
    storage.ensureIndexes.should.be.a.Function();
  });

  describe('getSnooze', function () {
    it('resolves to null when store is unavailable', async function () {
      var storage = alarmStorage({ store: null });
      var doc = await storage.getSnooze(2, 'default');
      (doc === null).should.equal(true);
    });

    it('returns the unexpired doc for level+group with expiresAt filter', async function () {
      var future = Date.now() + 60000;
      var fakeDoc = {
        _id: '2-default', level: 2, group: 'default',
        lastAckTime: 1000, silenceTime: 30 * 60 * 1000,
        expiresAt: new Date(future)
      };
      var captured = null;
      var fakeCollection = {
        findOne: function (q) {
          captured = q;
          return Promise.resolve(fakeDoc);
        }
      };
      var storage = alarmStorage({ store: { collection: function () { return fakeCollection; } } });
      var doc = await storage.getSnooze(2, 'default');
      captured._id.should.equal('2-default');
      captured.expiresAt.$gt.should.be.an.instanceOf(Date);
      doc.should.deepEqual(fakeDoc);
    });

    it('normalizes undefined group to "default"', async function () {
      var captured = null;
      var fakeCollection = {
        findOne: function (q) { captured = q; return Promise.resolve(null); }
      };
      var storage = alarmStorage({ store: { collection: function () { return fakeCollection; } } });
      await storage.getSnooze(2, undefined);
      captured._id.should.equal('2-default');
    });
  });
});
