var events = require('events');
var cluster = require('cluster');
var numCPUs = require('os').cpus().length;
var util = require("util");
var fs = require('fs');
var domain = require('domain');
var express = require('express');
var async = require('async');
var _ = require('underscore');
var logger = require('tracer').dailyfile({root:'./logs/updater'});
var common = require('./common.js');
var updateConf = require('./config/updateinfo.js');
var Router = require("./router.js");

function Updater(options) {
  events.EventEmitter.call(this);
  var self = this;
  self.changelog = {};
  function changelogCache (language, done) {
    if (self.changelog[language]) {
      return done(null, self.changelog[language]);
    }

    fs.readFile(
      updateConf.changelog[language],
      {
        encoding: 'utf8',
        flag: 'r'
      },
      function (err, data) {
        if (err) {
          logger.error(err);
          done(err);
        }
        self.changelog[language] = data;
        done(null, self.changelog[language]);
      }
    );
  }


  var defaultOptions = new function() {
    var self = this;
    self.pubPort = updateConf['pubPort']; // Default public port. This is used to connect with clients.
    self.log = false; // Log or not
    self.changelog = updateConf['changelog'];
  };

  if (_.isUndefined(options)) {
    var options = {};
  }
  self.options = _.defaults(options, defaultOptions);

  // TODO: dynamic change version info and download url, etc

  self.currentVersion = {
    version: updateConf['version'],
    // TODO: use a text file for changelog
    changelog: '',
    level: updateConf['level'],
    url: updateConf['url']
  };

  self.router = new Router();

  function prepare_server() {
    self.server = express();
    self.server.use(express.compress());
    self.server.use(express.json());
    self.server.use(express.urlencoded());

    self.server.post('/', function(req, res){
      var obj = req.body;
      var changelog = '';

      async.auto({
        'read_changelog': function (done) {
          var language = _.isString(obj['language']) && _.has(self.options.changelog, obj['language']) 
            ? obj['language'].toLowerCase() : 'en';

          changelogCache(language, function (err, cl) {
            changelog = cl;
            done(null);
          });
        },
        'combine_result': ['read_changelog', function (done) {
          var platform = _.isString(obj['platform']) ? obj['platform'].toLowerCase() : 'windows';
          var info = {
            'version': self.currentVersion['version'],
            'changelog': changelog,
            'level': self.currentVersion['level'],
            'url': self.currentVersion['url']['windows']
          };

          if (platform == 'windows x86' || platform == 'windows x64') {
            info['url'] = self.currentVersion['url']['windows'];
          }else if (platform == 'mac') {
            info['url'] = self.currentVersion['url']['mac'];
          };

          var ret = {
            response: 'version',
            result: true,
            'info': info
          }

          var body = common.jsonToString(ret);
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Content-Length', body.length);
          res.end(body);
        }]
      },
      function (err) {
        if (err) {
          common.jsonToString({});
        }
      });
    });
  }

  var d = domain.create();
  d.on('error', function(er) {
    logger.error('Error in express server of Updater:', er);
  })
  .run(prepare_server);
}

util.inherits(Updater, events.EventEmitter);

Updater.prototype.start = function() {
  this.server.listen(updateConf.pubPort, '::');
};

Updater.prototype.stop = function() {
  this.server.close();
};

function run() {
  if (cluster.isMaster) {
    // Fork workers.
    function forkWorker() {
      var worker = cluster.fork();
    }

    for (var i = 0; i < numCPUs/2+1; i++) {
      forkWorker();
    }

    cluster.on('exit', function(worker, code, signal) {
      logger.error('worker ', worker.process.pid, ' died');
      forkWorker();
    });
  } else {
    var upd = new Updater();
    upd.start();
  }

}

run();
