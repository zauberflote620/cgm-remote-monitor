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
});
