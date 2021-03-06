﻿var events = require('events');
var cluster = require('cluster');
var util = require("util");
var crypto = require('crypto');
var _ = require('underscore');
var toobusy = require('toobusy');
var async = require('async');
var mongoose = require('mongoose');
var common = require('./libs/common.js');
var Router = require("./libs/router.js");
var socket = require('./libs/streamedsocket.js');
var TypeChecker = require("./libs/types.js");
var Room = require('./room.js');
var MongoSchema = require('./schema.js');
var RoomModel = MongoSchema.Model.Room;
var db = mongoose.connection;
var logger = common.logger;
var globalConf = common.globalConf;


function RoomManager(options) {
  events.EventEmitter.call(this);

  var self = this;

  var defaultOptions = new
  function() {
    var self = this;
    self.name = ''; // Name of RoomManager
    self.localId = 0; // Id to recover died rooms
    self.maxRoom = 50; // Limits the rooms
    self.pubPort = globalConf['manager']['publicPort']; // Default public port. This is used to connect with clients or master.
    self.log = false; // Log or not, not really used
    self.roomInfoRefreshCycle = 10*1000; // Refresh cycle for checking whether a room is died, in ms
  };

  if (TypeChecker.isUndefined(options)) {
    var options = {};
  }
  self.op = _.defaults(options, defaultOptions);

  self.roomObjs = {}; // store Room object
  self.roomInfos = {};// store Room Info, only for broadcast within local machine
  
  self._ispubServerConnected = false;
  self._isRegSocketConnected = false;

  async.auto({
    'init_db': function(callback) {
      db.on('error', function(er) {
        logger.error('connection error:', er);
        callback(er);
      });
      db.once('open', callback);
      mongoose.connect(globalConf['database']['connectionString'],
        globalConf['database']['options']);
    },
    'init_router': function(callback) {
      self.router = new Router();
      self.router.reg('request', 'roomlist', proc_roomlist, self)
      .reg('request', 'join', proc_join, self)
      .reg('request', 'newroom', proc_newroom, self);
      callback();
    },
    'start_server': ['init_router', 'init_db', function(callback) {

      self.pubServer = new socket.SocketServer();

      self.pubServer.once('listening', function() {
        self._ispubServerConnected = true;
        self.emit('listening');
      }).on('newclient', function(client) {
        logger.info(client['ip']);
        
        client.on('manager', function(data) {
          var obj = common.stringToJson(data);
          logger.log(obj);
          self.router.message(client, obj);
        });
      }).once('ready', function(){
        self.pubServer.listen(self.op.pubPort, '::');
      });

      if (cluster.isWorker) {
        cluster.worker.on('message', function(msg) {
          // logger.log('cluster msg: ', msg);
          if (msg['message'] == 'newroom') {
            self.roomInfos[msg['info']['name']] = msg['info'];
          }else if (msg['message'] == 'roominfo') {
            self.roomInfos[msg['info']['name']] = msg['info'];
          }else if (msg['message'] == 'roomclose') {
            if (self.roomInfos[msg['info']['name']]) {
              delete self.roomInfos[msg['info']['name']];
            }
          }else if(msg['message'] == 'broadcast') {
            self.localcast(msg['content']);
          }
        });

        function roomInfoRefresh() {
          var now = (new Date()).getTime();
          _.each(self.roomInfos, function(ele, ind, list) {
            if( now - parseInt(ele['timestamp'], 10) > 2 * self.op.roomInfoRefreshCycle) {
              if(list[ele['name']]){
                logger.warn(ele['name'], 'is timeout and deleted.');
                delete list[ele['name']];
              } 
            }
          });
        }

        self.roomInfoRefreshTimer = setInterval(roomInfoRefresh, self.op.roomInfoRefreshCycle);
      };
      callback();
    }],
    'recover_rooms': ['start_server', function(callback) {
      RoomModel.find({ 'localId': self.op.localId }, function (err, r_rooms) {
        if (err) {
          logger.error('Error when query room from db: ', err);
          callback(err);
        }else{
          r_rooms.forEach(function(element, index) {
            var n_room = new Room({
              'name': element.name,
              'maxLoad': element.maxLoad,
              'welcomemsg': element.welcomemsg,
              'emptyclose': element.emptyclose,
              'password': element.password,
              'canvasSize': element.canvasSize,
              'key': element.key,
              'expiration': element.expiration, // 48 hours to close itself
              'permanent': element.permanent,
              'lastCheckoutTimestamp': element.checkoutTimestamp,
              'archive': element.archive,
              'archiveSign': element.archiveSign,
              'port': element.port,
              'recovery': true
            });

            n_room.once('create', function(info) {
              self.roomObjs[info['name']] = n_room;
              var infoBlock = {
                port: info['port'],
                name: info['name'],
                maxLoad: info['maxLoad'],
                'private': info['private'],
                'timestamp': (new Date()).getTime(),
                currentLoad: 0
              };
              self.roomInfos[info['name']] = infoBlock;
              if (cluster.isWorker) {
                cluster.worker.send({
                  'message': 'newroom',
                  'info': infoBlock
                });
              };
              infoBlock = null;
            }).once('close', function() {
              delete self.roomObjs[n_room.options.name];
              delete self.roomInfos[n_room.options.name];
            }).on('checkout', function() {
              RoomModel.update(
                {'name': n_room.options.name}, 
                {'checkoutTimestamp': n_room.options.lastCheckoutTimestamp},
                function(err) {
                  if (err) {
                    logger.error(err);
                  };
              });
            }).once('destroyed', function(r_name) {
              RoomModel.remove({ 'name': r_name }, function (err) {
                if (err) {
                  logger.error('Error when removing room from db:', err);
                  return;
                }
                logger.log('Room ', r_name, 'removed from db.');
              });
            }).on('newarchivesign', function(new_sign){
              RoomModel.update(
                {'name': n_room.options.name}, 
                {'archiveSign': new_sign},
                function(err) {
                  if (err) {
                    logger.error(err);
                  };
              });
            });
          });
          callback();
        }
      });
    }]
  }, function(er){
    if (er) {
      logger.error('Error while creating RoomManager: ', er);
    }else{
      process.nextTick(function(){self.emit('ready');});
    }
  });
}

util.inherits(RoomManager, events.EventEmitter);

function proc_roomlist(cli, obj)
{
  var r_self = this;
  var ret = {};
  var list = [];
  _.each(r_self.roomInfos, function(item) {
    if (TypeChecker.isUndefined(item)) return;
    var r = {
      port: item.port,
      serveraddress: r_self.pubServer.address().address,
      maxload: item.maxLoad,
      currentload: item.currentLoad,
      name: item.name,
      'private': item['private']
    };
    // logger.log(r);
    list.push(r);
  });
  ret['response'] = 'roomlist';
  ret['roomlist'] = list;
  ret['result'] = true;
  logger.log(ret);
  var jsString = common.jsonToString(ret);
  cli.sendManagerPack(new Buffer(jsString));
}

function proc_join(cli, obj)
{
  //
}

function proc_newroom(cli, obj)
{
  var r_self = this;
  var infoObj = obj['info'];
  if (!infoObj) {
    var ret = {
      response: 'newroom',
      result: false,
      errcode: 200
    };
    logger.log(ret);
    var jsString = common.jsonToString(ret);
    cli.sendManagerPack(new Buffer(jsString));
    return;
  }

  // amount of room limit begin
  if (r_self.op.maxRoom) {
    if (_.size(r_self.roomInfos) > r_self.op.maxRoom) {
      var ret = {
        response: 'newroom',
        result: false,
        errcode: 210
      };
      logger.log(ret);
      var jsString = common.jsonToString(ret);
      cli.sendManagerPack(new Buffer(jsString));
      return;
    }
  }
  // amount of room limit end
  // name check begin
  if (!infoObj['name']) {
    var ret = {
      response: 'newroom',
      result: false,
      errcode: 203
    };
    logger.log(ret);
    var jsString = common.jsonToString(ret);
    cli.sendManagerPack(new Buffer(jsString));
    return;
  }
  var name = TypeChecker.isString(infoObj['name']) ? infoObj['name'] : false;
  if (!name) {
    var ret = {
      response: 'newroom',
      result: false,
      errcode: 203
    };
    logger.log(ret);
    var jsString = common.jsonToString(ret);
    cli.sendManagerPack(new Buffer(jsString));
    return;
  }
  if (r_self.roomInfos[name]) {
    var ret = {
      response: 'newroom',
      result: false,
      errcode: 202
    };
    logger.log(ret);
    var jsString = common.jsonToString(ret);
    cli.sendManagerPack(new Buffer(jsString));
    return;
  }
  // name check end
  // maxLoad check begin
  if (infoObj['maxload']) {
    var maxLoad = parseInt(infoObj['maxload'], 10);
    if (maxLoad < 0 || maxLoad > 17) {
      var ret = {
        response: 'newroom',
        result: false,
        errcode: 204
      };
      logger.log(ret);
      var jsString = common.jsonToString(ret);
      cli.sendManagerPack(new Buffer(jsString));
      return;
    }
  } else {
    var ret = {
      response: 'newroom',
      result: false,
      errcode: 204
    };
    logger.log(ret);
    var jsString = common.jsonToString(ret);
    cli.sendManagerPack(new Buffer(jsString));
    return;
  }
  // maxLoad check end
  // welcomemsg check begin
  if (infoObj['welcomemsg']) {
    if (!TypeChecker.isString(infoObj['welcomemsg'])) {
      var ret = {
        response: 'newroom',
        result: false,
        errcode: 205
      };
      logger.log(ret);
      var jsString = common.jsonToString(ret);
      cli.sendManagerPack(new Buffer(jsString));
      return;
    }
    var welcomemsg = infoObj['welcomemsg'];
    if (welcomemsg.length > 40) {
      var ret = {
        response: 'newroom',
        result: false,
        errcode: 205
      };
      logger.log(ret);
      var jsString = common.jsonToString(ret);
      cli.sendManagerPack(new Buffer(jsString));
      return;
    }
  } else {
    var welcomemsg = '';
  }
  // welcomemsg check end
  // password check begin
  if (infoObj['password']) {
    if (!TypeChecker.isString(infoObj['password'])) {
      var ret = {
        response: 'newroom',
        result: false,
        errcode: 207
      };
      logger.log(ret);
      var jsString = common.jsonToString(ret);
      cli.sendManagerPack(new Buffer(jsString));
      return;
    }
    var password = infoObj['password'];
    if (password.length > 16) {
      var ret = {
        response: 'newroom',
        result: false,
        errcode: 207
      };
      logger.log(ret);
      var jsString = common.jsonToString(ret);
      cli.sendManagerPack(new Buffer(jsString));
      return;
    }
  } else {
    var password = '';
  }
  // password check end
  // emptyclose check begin
  if (infoObj['emptyclose']) {
    if (!TypeChecker.isBoolean(infoObj['emptyclose'])) {
      var ret = {
        response: 'newroom',
        result: false,
        errcode: 207
      };
      logger.log(ret);
      var jsString = common.jsonToString(ret);
      cli.sendManagerPack(new Buffer(jsString));
      return;
    }
    var emptyclose = infoObj['emptyclose'];
  } else {
    var emptyclose = false;
  }
  // emptyclose check end
  // canvasSize check begin
  if (infoObj['size']) {
    if (!TypeChecker.isObject(infoObj['size'])) {
      var ret = {
        response: 'newroom',
        result: false,
        errcode: 211
      };
      logger.log(ret);
      var jsString = common.jsonToString(ret);
      cli.sendManagerPack(new Buffer(jsString));
      return;
    }
    var canvasWidth = parseInt(infoObj['size']['width'], 10);
    var canvasHeight = parseInt(infoObj['size']['height'], 10);
    // constrain canvas.
    canvasWidth = ( canvasWidth > 0 && canvasHeight > 0 ) ? canvasWidth : 0;
    if (!canvasWidth || !canvasHeight) {
      var ret = {
        response: 'newroom',
        result: false,
        errcode: 211
      };
      logger.log(ret);
      var jsString = common.jsonToString(ret);
      cli.sendManagerPack(new Buffer(jsString));
      return;
    }
    var canvasSize = {
      width: canvasWidth,
      height: canvasHeight
    };
  } else {
    var ret = {
      response: 'newroom',
      result: false,
      errcode: 211
    };
    logger.log(ret);
    var jsString = common.jsonToString(ret);
    cli.sendManagerPack(new Buffer(jsString));
    return;
  }
  // canvasSize check end

  // if server is too busy
  if(toobusy()) {
    var ret = {
      response: 'newroom',
      result: false,
      errcode: 201
    };
    logger.log(ret);
    var jsString = common.jsonToString(ret);
    cli.sendManagerPack(new Buffer(jsString));
    return;
  }
  // end of busy check


  var room = new Room({
    'name': name,
    'maxLoad': maxLoad,
    'welcomemsg': welcomemsg,
    'emptyclose': emptyclose,
    'password': password,
    'canvasSize': canvasSize,
    'expiration': 48 // 48 hours to close itself
  });

  room.on('create', function(info) {
    var ret = {
      response: 'newroom',
      result: true,
      'info': {
        port: info['port'],
        key: info['key']
      }
    };
    logger.log(ret);
    var jsString = common.jsonToString(ret);
    cli.sendManagerPack(new Buffer(jsString));
    r_self.roomObjs[infoObj['name']] = room;
    var infoBlock = {
      port: info['port'],
      name: info['name'],
      maxLoad: info['maxLoad'],
      'private': info['private'],
      'timestamp': (new Date()).getTime(),
      currentLoad: 0
    };
    r_self.roomInfos[infoObj['name']] = infoBlock;
    if (cluster.isWorker) {
      cluster.worker.send({
        'message': 'newroom',
        'info': infoBlock
      });
    };

    var roomToSaveDb = {
       'name': info['name'],
       'canvasSize': room['options']['canvasSize'],
       'password': room['options']['password'],
       'maxLoad': room['options']['maxLoad'],
       'welcomemsg': room['options']['welcomemsg'],
       'emptyclose': room['options']['emptyclose'],
       'expiration': room['options']['expiration'],
       'permanent': room['options']['permanent'],
       'checkoutTimestamp': room['options']['lastCheckoutTimestamp'],
       'key': info['key'],
       'archive': room['archive'],
       'archiveSign': room['options']['archiveSign'],
       'port': room.port(),
       'localId': r_self.op.localId
    };

    RoomModel.findOneAndUpdate(
      {'name': info['name']}, 
      roomToSaveDb,
      {
        'upsert': true
      }, function (err, small) {
        if (err) {
          logger.error('Error when upsert new room: ', err, roomToSaveDb);
          return;
        }
        // saved!
        logger.log('Room saved to db: ', roomToSaveDb);
    });
  }).on('close', function() {
    delete r_self.roomObjs[room.options.name];
    delete r_self.roomInfos[room.options.name];
  }).on('destroyed', function() {
    RoomModel.remove({ 'name': room.options.name }, function (err) {
      if (err) {
        logger.error('Error when removing room from db:', err);
        return;
      }
      logger.log('Room ', room.options.name, 'removed from db.');
    });
  }).on('checkout', function() {
    RoomModel.update(
      {'name': room.options.name}, 
      {'checkoutTimestamp': room.options.lastCheckoutTimestamp},
      function(err) {
        if (err) {
          logger.error(err);
        };
      });
  }).on('newarchivesign', function(new_sign){
    RoomModel.update(
      {'name': room.options.name}, 
      {'archiveSign': new_sign},
      function(err) {
        if (err) {
          logger.error(err);
        };
    });
  });
}

RoomManager.prototype.stop = function() {
  var self = this;
  clearInterval(self.roomInfoRefreshTimer);
  _.each(self.roomObjs, function(item) {
    item.close();
  });
  db.close();
  return this;
};

RoomManager.prototype.localcast = function(msg) {
  var self = this;
  _.each(self.roomObjs, function(item) {
    item.bradcastMessage(msg);
  });
  return this;
};

module.exports = RoomManager;
