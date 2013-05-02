var events = require('events');
var cluster = require('cluster');
var util = require("util");
var fs = require('fs');
var _ = require('underscore');
var logger = require('tracer').dailyfile({root:'./logs'});
var common = require('./common.js');
var Router = require("./router.js");
var socket = require('./socket.js');

function Updater(options) {
  events.EventEmitter.call(this);
  var self = this;

  var defaultOptions = new function() {
    var self = this;
    self.pubPort = 7071; // Default public port. This is used to connect with clients.
    self.log = false; // Log or not
    self.defFile = './updateinfo.js';
  };

  if (_.isUndefined(options)) {
    var options = {};
  }
  self.options = _.defaults(options, defaultOptions);

  // TODO: dynamic change version info and download url, etc
  // self.ConfWatcher = fs.watch(self.defFile, 
  //   {persistent: false}, 
  //   function(curr, prev) {
  //   //
  // });
  
  self.currentVersion = {
    version: '0.3',
    changelog: '',
    level: 1,
    url: {
      'windows': 'http://mrspaint.oss.aliyuncs.com/%E8%8C%B6%E7%BB%98%E5%90%9B_Alpha_x86.zip',
      'mac': 'http://mrspaint.oss.aliyuncs.com/%E8%8C%B6%E7%BB%98%E5%90%9B.app.zip'
    }
  };

  self.router = new Router();

  self.router.reg('request', 'check', function(cli, obj) {
    var platform = _.isString(obj['platform']) ? obj['platform'].toLowerCase() : 'windows';
    var ret = {
      version: self.currentVersion['version'],
      changelog: self.currentVersion['changelog'],
      level: self.currentVersion['level'],
      url: self.currentVersion['url']['windows']
    };

    if (platform == 'windows x86' || platform == 'windows x64') {
      ret['url'] = self.currentVersion['url']['windows'];
    }else if (platform == 'mac') {
      ret['url'] = self.currentVersion['url']['mac'];
    };

    var jsString = JSON.stringify(ret);
    self.pubServer.sendData(cli, new Buffer(jsString));
  });

  self.pubServer = new socket.SocketServer({
    autoBroadcast: false,
    useAlternativeParser: function(cli, data) {
      var obj = JSON.parse(data);
      logger.log(obj);
      self.router.message(cli, obj);
    }
  });

}

util.inherits(Updater, events.EventEmitter);

// module.exports = Updater;

Updater.prototype.start = function() {
  //
};
