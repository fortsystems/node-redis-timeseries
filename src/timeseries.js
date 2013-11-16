
var TimeSeries = module.exports = function(redis, keyBase, granularities) {
  this.redis = redis;
  this.keyBase = keyBase || 'stats';
  this.pendingMulti = redis.multi();
  this.granularities = granularities || {
    '1second'  : { ttl: this.minutes(5), duration: 1 },
    '1minute'  : { ttl: this.hours(1)  , duration: this.minutes(1) },
    '5minutes' : { ttl: this.days(1)   , duration: this.minutes(5) },
    '10minutes': { ttl: this.days(1)   , duration: this.minutes(10) },
    '1hour'    : { ttl: this.days(7)   , duration: this.hours(1) },
    '1day'     : { ttl: this.weeks(52) , duration: this.days(1) }
  };
};

/** Helper functions that compute various durations in secs */
TimeSeries.prototype.seconds = function(i) { return i; };
TimeSeries.prototype.minutes = function(i) { return i*60; };
TimeSeries.prototype.hours   = function(i) { return i*this.minutes(60); };
TimeSeries.prototype.days    = function(i) { return i*this.hours(24); };
TimeSeries.prototype.weeks   = function(i) { return i*this.days(7); };

/**
 * Record a hit for the specified stats key
 * This method is chainable:
 * --> var ts = new TimeSeries(redis)
 *              .recordHit("messages")
 *              .recordHit("purchases", ts)
 *              ...
 *              .exec([callback]);
 *
 * `timestamp` should be in seconds, and defaults to
 * current time.
 */
TimeSeries.prototype.recordHit = function(key, timestamp) {
  var self = this;

  Object.keys(this.granularities).forEach(function(gran) {
    var properties = self.granularities[gran],
        keyTimestamp = getRoundedTime(properties.ttl, timestamp),
        tmpKey = [self.keyBase, key, gran, keyTimestamp].join(':'),
        hitTimestamp = getRoundedTime(properties.duration, timestamp);

   self.pendingMulti.hincrby(tmpKey, hitTimestamp, 1);
   self.pendingMulti.expireat(tmpKey, keyTimestamp + 2 * properties.ttl);
  });

  return this;
};

/**
 * Execute the current pending redis multi
 */
TimeSeries.prototype.exec = function(callback) {
  var self = this;

  if (this.pendingMulti) {
    this.pendingMulti.exec(function(err, result) {
      self.pendingMulti = self.redis.multi();
      if (typeof callback === "function") callback(err, result);
    });
  }
};

/** 
 * getHits("messages", "10minutes", 3, cb)
 *   --> "messages" hits during the last 3 '10minutes' chunks
 */
TimeSeries.prototype.getHits = function(key, gran, count, callback) {
  var properties = this.granularities[gran],
      currentTime = getCurrentTime();

  if (typeof properties === "undefined") {
    return callback(new Error("Unsupported granularity: "+gran));
  }

  if (count > properties.ttl / properties.duration) {
    return callback(new Error("Count: "+count+" exceeds the maximum stored slots for granularity: "+gran));
  }

  var from = getRoundedTime(properties.duration, currentTime - count*properties.duration),
      to = getRoundedTime(properties.duration, currentTime);

  for(var ts=from, multi=this.redis.multi(); ts<=to; ts+=properties.duration) {
    var keyTimestamp = getRoundedTime(properties.ttl, ts),
        tmpKey = [this.keyBase, key, gran, keyTimestamp].join(':');

    multi.hget(tmpKey, ts);
  }

  multi.exec(function(err, results) {
    if (err) {
      return callback(err);
    }

    for(var ts=from, i=0, data=[]; ts<=to; ts+=properties.duration, i+=1) {
      data.push([ts, results[i] ? parseInt(results[i], 10) : 0]);
    }

    return callback(null, data.slice(Math.max(data.length - count, 0)));
  });
};

// Get current timestamp in seconds
var getCurrentTime = function() {
  return Math.floor(Date.now() / 1000);
};

// Round timestamp to the 'precision' interval (in seconds)
var getRoundedTime = function(precision, time) {
  time = time || getCurrentTime();
  return Math.floor(time / precision) * precision;
};

