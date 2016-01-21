'use strict';

var http = require('http');
var https = require('https');
var fs = require('fs');
var path = require('path');

var xml2js = require('xml2js');
var nodemailer = require('nodemailer');
var levelup = require('levelup');

var storage = levelup('./mailed.db');
var exports = {};
var config;

exports.loadConfig = function loadConfig() {
  return new Promise(function(resolve, reject) {
    fs.readFile(path.resolve(__dirname, './config.json'), function(err, data) {
      if (err) {
        return reject(err);
      }
      try {
        config = JSON.parse(data);
      } catch(e) {
        return reject(err);
      }
      resolve(config);
    });
  });
};

exports.getHttpClient = function getHttpClient(url) {
  var isHttps = url.match(/^https/);
  var isHttp = url.match(/^http/);
  var currentHttp;
  if (isHttps) {
    currentHttp = https;
  } else if (isHttp) {
    currentHttp = http;
  }
  return currentHttp;
};

exports.getFeed = function getFeed(url) {
  console.log('Checking url: ' + url);
  return new Promise(function(resolve, reject) {
    var currentHttp = exports.getHttpClient(url);
    if (!currentHttp) {
      return reject(new Error('Non-http based URL'));
    }
    currentHttp.get(url, function(res) {

      var buffer = [];
      if (res.statusCode !== 200) {
        return reject(new Error('Non-200 HTTP status code'));
      }

      res.on('data', function(data) {
        buffer = buffer.concat(data);
      });

      res.on('end', function() {
        var options = {
          trim: true,
          normalizeTags: true,
          strict: false
        };
        xml2js.parseString(buffer.toString(), options, function(err, feed) {
          if (err) {
            return reject(err);
          }
          resolve(feed);
        });
      });

    }).on('error', reject);

  });
};

exports.getFeeds = function getFeeds() {
  var feeds = [];
  for (var i = 0; i < config.sources.length; i++) {
    feeds.push(exports.getFeed(config.sources[i].url));
  }
  return Promise.all(feeds);
};

exports.locateItems = function locateItems(feed) {
  var format = Object.keys(feed)[0];
  var items = feed[format].item;
  if (!items && feed[format].channel) {
    items = feed[format].channel[0].item;
  }
  return items;
};

exports.searchItem = function searchItem(item) {
  var matchedItems = [];
  if (!item.description) {
    return matchedItems;
  }
  var description = item.description[0];
  for (var j = 0; j < config.keywords.length; j++) {
    var keyword = config.keywords[j];
    if (description.match && description.match(new RegExp(keyword, 'i'))) {
      matchedItems.push({
        keyword: keyword,
        item: item
      });
    }
  }
  return matchedItems;
};

exports.searchFeed = function searchFeed(feed) {
  var items = exports.locateItems(feed);
  if (!items) {
    return Promise.reject(new Error('Unable to read items for feed.'));
  }
  var matchedItems = [];
  for (var i = 0; i < items.length; i++) {
    matchedItems = matchedItems.concat(exports.searchItem(items[i]));
  }
  return Promise.resolve(matchedItems);
};

exports.searchFeeds = function searchFeeds(feeds) {
  var searches = [];
  for(var i = 0; i < feeds.length; i++) {
    searches.push(exports.searchFeed(feeds[i]));
  }
  return Promise.all(searches);
};

exports.notificationKey = function notificationKey(subscriber, match) {
  return subscriber.email + match.item.link[0] + match.keyword;
};

exports.notifySubscriber = function notifySubscriber(smtpTransporter, match, subscriber) {
  var mail = {
    to: subscriber.email,
    subject: config.title + ' [' + match.keyword + ']: ' + match.item.title,
    text: match.item.link[0]
  };
  return new Promise(function(resolve, reject) {
    var key = exports.notificationKey(subscriber, match);
    var result = {
      match: match,
      subscriber: subscriber
    };
    storage.get(key, function(err) {
      if (err instanceof levelup.errors.NotFoundError) {
        smtpTransporter.sendMail(mail, function(err, response) {
          if (err) {
            return reject(err);
          }
          result.message = response;
          resolve(result);
        });
      } else if (err)  {
        reject(err);
      } else {
        resolve(result);
      }
    });
  });
};

exports.getSmtpTransporter = function getSmtpTransporter() {
  var smtpTransporter = nodemailer.createTransport({
    host: config.emailer.host,
    port: config.emailer.port,
    secure: config.emailer.secure,
    auth: {
      user: config.emailer.auth.user,
      pass: config.emailer.auth.password
    }
  }, {
    from: config.emailer.from
  });
  return smtpTransporter;
};

exports.notifySubscribers = function notifySubscribers(matchedFeeds) {
  var smtpTransporter = exports.getSmtpTransporter();

  var emails = [];
  for (var i = 0; i < matchedFeeds.length; i++) {
    var matchedItems = matchedFeeds[i];
    for (var j = 0; j < matchedItems.length; j++) {
      for (var h = 0; h < config.subscribers.length; h++) {
        var subscriber = config.subscribers[h];
        var match = matchedItems[j];
        emails.push(exports.notifySubscriber(smtpTransporter, match, subscriber));
      }
    }
  }
  return Promise.all(emails);
};

exports.markAsNotified = function markAsNotified(results) {
  for (var i = 0; i < results.length; i++) {
    var result = results[i];
    if (result.message && result.message.accepted.length) {
      var key = exports.notificationKey(result.subscriber, result.match);
      storage.put(key, true);
    }
  }
  return Promise.resolve(results);
};

exports.main = function main() {
  exports.loadConfig()
    .then(exports.getFeeds)
    .then(exports.searchFeeds)
    .then(exports.notifySubscribers)
    .then(exports.markAsNotified)
    .catch(function(err) {
      console.error(err.stack);
    });
};

exports.forever = function forever() {
  exports.main();
  setTimeout(function() {
    exports.forever();
  }, config.pollMinutes * 60 * 1000);
};

if (require.main === module) {
  exports.loadConfig().then(exports.forever);
}

module.exports = exports;
