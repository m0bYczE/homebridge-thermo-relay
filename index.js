'use strict';
var http = require('http');
var gpio = require('onoff').Gpio;
var fs = require('fs');
var path = require('path');
const Jablotron = require('./jablotron');

var OFF = false;
var ON = true;
var RELAY_ON = 0;
var RELAY_OFF = 1;

var platform, Accessory, Service, Characteristic, UUIDGen, zones;


var zones={
  "Přízemí" : {
      "relayPinTopeni" : 18,
      "relayPinKotel" : 24,
      "sensors" : {
        "Kuchyň":{
            "source" : "Jablotron",
        }
      }
  },
  "Patro" : {
      "relayPinTopeni" : 23,
      "relayPinKotel" : 24,
      "sensors" : {
        "Ložnice":{
            "source" : "Jablotron",
        }
      }
  }
};
module.exports = function(homebridge) {
  console.log("homebridge API version: " + homebridge.version);
  Accessory = homebridge.platformAccessory;
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  UUIDGen = homebridge.hap.uuid;
  homebridge.registerPlatform("homebridge-thermo", "MultiZonePlatform", MultiZonePlatform, true);
};
function MultiZonePlatform(log, config, api) {
  log("MultiZonePlatform Init");
  platform = this;
  this.log = log;
  this.config = config;
  this.accessories = [];
  this.relays = {};
  this.relayPins = config.relayPins || [12,16,18]
  this.zones = config.zones || zones;
  this.sensorCheckMilliseconds = config.sensorCheckMilliseconds || 60000;
  this.temperatureDisplayUnits = config.temperatureDisplayUnits || 1;
  this.minOnOffTime = config.minOnOffTime || 300000;
  this.startDelay = config.startDelay || 10000;
  this.serverPort = config.serverPort || 3000;
  this.alarmTemp = config.alarmTemp;
  this.alarmKey = config.alarmKey;
  this.alarmSecret = config.alarmSecret;
  this.alarmTopic = config.alarmTopic;
  this.username = config.username;
  this.password = config.password; 
  this.jablotronId = config.jablotronId;
  this.reasonableTemperatures = config.reasonableTemperatures || [
    {"units":"celsius", "low":10, "high":40 },
    {"units":"fahrenheit", "low":50, "high":104 }
  ];
  this.log = platform.getLog();
  this.jablotron = new Jablotron(this);
  this.setupGPIO();
  if (api) {
      this.api = api;
      this.api.on('didFinishLaunching', function() {
        platform.log("DidFinishLaunching");
        platform.startSensorLoops();
        platform.startControlLoop();      
      }.bind(this));
      this.api.on('shutdown', function() {
        this.vypnoutGPIO();
      }.bind(this));
  }else{
    platform.startSensorLoops();
    platform.startControlLoop();
  }
}
MultiZonePlatform.prototype.getLog = function () {
      return this.log;
};
MultiZonePlatform.prototype.setupGPIO=function() {
  for (var pin in platform.relayPins) {
    const relay = new gpio(platform.relayPins[pin], 'out');
    relay.writeSync(1);
    platform.relays[platform.relayPins[pin]] = relay;
  }
};
MultiZonePlatform.prototype.vypnoutGPIO=function() {
  for (var pin in platform.relayPins) {
    platform.relays[platform.relayPins[pin]].writeSync(1);
  }
};
MultiZonePlatform.prototype.sendSNSMessage=function(message){
  var AWS = require('aws-sdk'); 
  AWS.config.update({region: 'us-east-1'}); 
  var sns=new AWS.SNS(
    {accessKeyId:platform.alarmKey,
    secretAccessKey:platform.alarmSecret});
  var params = {
    Message: message,
    TopicArn: platform.alarmTopic
  };
  sns.publish(params, function(err, data) {
    if (err) platform.log(err, err.stack);
  });
};

MultiZonePlatform.prototype.writeGPIO=function(pin ,val){
  platform.relays[pin].writeSync(val);
};

MultiZonePlatform.prototype.checkKotel=function(zone){
  var vypnoutKotel = true;

  for(var zoneV in platform.zones) {
    if(zoneV == zone) {
      continue;
    }
    var service = platform.getThermostatForZone(zoneV);
    if(service){
      var currentState = service.getCharacteristic(Characteristic.CurrentHeatingCoolingState).value;
      
      if (currentState === Characteristic.CurrentHeatingCoolingState.HEAT || currentState === Characteristic.CurrentHeatingCoolingState.COOL) {
        vypnoutKotel = false;
      } 
    }
  }

  if(vypnoutKotel) {
    if(platform.zones[zone].relayPinKotel)platform.writeGPIO(platform.zones[zone].relayPinKotel,RELAY_OFF);
  }
};

MultiZonePlatform.prototype.updateGPIO=function(zone, HeatCoolMode ,val){
    platform.log("updateGPIO", zone);
    if(HeatCoolMode==Characteristic.CurrentHeatingCoolingState.OFF){
      platform.log("updateGPIO 1");
      if(platform.zones[zone].relayPinTopeni)platform.writeGPIO(platform.zones[zone].relayPinTopeni,RELAY_OFF);
      platform.checkKotel(zone);
    }else if(HeatCoolMode==Characteristic.CurrentHeatingCoolingState.HEAT){
      platform.log("updateGPIO 2");
      if(platform.zones[zone].relayPinTopeni)platform.writeGPIO(platform.zones[zone].relayPinTopeni,val?RELAY_ON:RELAY_OFF);
      if(!val) {
        platform.checkKotel(zone);
      } else {
        if(platform.zones[zone].relayPinKotel)platform.writeGPIO(platform.zones[zone].relayPinKotel,val?RELAY_ON:RELAY_OFF);
      }
    }else if(HeatCoolMode==Characteristic.CurrentHeatingCoolingState.COOL){
      platform.log("updateGPIO 3");
      if(platform.zones[zone].relayPinTopeni)platform.writeGPIO(platform.zones[zone].relayPinTopeni,val?RELAY_ON:RELAY_OFF);
      if(!val) {
        platform.checkKotel(zone);
      } else {
        if(platform.zones[zone].relayPinKotel)platform.writeGPIO(platform.zones[zone].relayPinKotel,val?RELAY_ON:RELAY_OFF);
      }
    }
};
MultiZonePlatform.prototype.startSensorLoops = function(){
  this.sensorInterval=setInterval(
      function(){
        platform.readTemperatureFromJablotron();
        if(platform.environmentCountdown) {
          platform.environmentCountdown--;
        } else {
          platform.environmentCountdown=60;
        }
      }
      ,this.sensorCheckMilliseconds);
};
MultiZonePlatform.prototype.readTemperatureFromJablotron = function() {
  for(var zone in this.zones) { 
    for(var deviceid in this.zones[zone].sensors){
      var val = this.zones[zone].sensors[deviceid][source];
      if(val == 'Jablotron') {
        this.jablotron.getThermomethers(function (callback) {
          var teplota = 22;

          callback.forEach(function (segment) {
            let segmentName = segment['segment_name'];

            if (segmentName == deviceid) {
                teplota = segment['segment_informations'][0]['value'];
            } else if((deviceid == 'Ložnice' || deviceid == 'Kuchyň') && segmentName == 'Přízemí') {
                teplota = segment['segment_informations'][0]['value'];
            }
          });
        });
        platform.updateSensorData(deviceid, { 'temp' : teplota });
      }
    }
  }
};
MultiZonePlatform.prototype.getZoneForDevice=function(deviceid){
  for(var zone in this.zones){
    if(this.zones[zone].sensors[deviceid])return zone;
  }
  return null;
};
MultiZonePlatform.prototype.updateSensorData = function(deviceid, data){
  var logdata=JSON.parse(JSON.stringify(data));
  logdata.deviceid=deviceid;
  logdata.timestamp=new Date().toISOString();
  var zone = this.getZoneForDevice(deviceid);
  if(!zone){
      return;
  }
  var timestamp=new Date().toString();
  for(var val in data){
    this.zones[zone].sensors[deviceid][val]=data[val];
    this.zones[zone].sensors[deviceid]['timestamp']=timestamp;
  }
  var foundAccessories = 0;
  for(var i in this.accessories){
    var accessory=this.accessories[i];
    for(var j in accessory.services){

      var service = accessory.services[j];
      if(service.displayName==deviceid || service.displayName==zone)
      {
        foundAccessories++;
        this.setCharacteristics(service,deviceid,data);
      }
    }
  }
  if(foundAccessories<4){
     this.addAccessoriesForSensor(deviceid);
  }
};
MultiZonePlatform.prototype.testCharacteristic=function(service,name){
  var index, characteristic;
  for (index in service.characteristics) {
    characteristic = service.characteristics[index];
    if (typeof name === 'string' && characteristic.displayName === name) {
      return true;
    }
    else if (typeof name === 'function' && ((characteristic instanceof name) || (name.UUID === characteristic.UUID))) {
      return true;
    }
  }
  for (index in service.optionalCharacteristics) {
    characteristic = service.optionalCharacteristics[index];
    if (typeof name === 'string' && characteristic.displayName === name) {
      return true;
    }
    else if (typeof name === 'function' && ((characteristic instanceof name) || (name.UUID === characteristic.UUID))) {
      return true;
    }
  }
  return false;
}
MultiZonePlatform.prototype.getAverageSensor=function(zone,dataType){
  var count=0,sum=0;
  for(var deviceid in this.zones[zone].sensors){
    var val=this.zones[zone].sensors[deviceid][dataType];
    if(val){sum+=val;count++}
  }
  return count>0 ? Math.round(sum/count) : 0;
};
MultiZonePlatform.prototype.getMinimumSensor=function(zone,dataType){
  var min;
  for(var deviceid in this.zones[zone].sensors){
    var val=this.zones[zone].sensors[deviceid][dataType];
    if(!min || val<min){min=val;}
  }
  return min;
};
MultiZonePlatform.prototype.setCharacteristics = function(service,deviceid,data){
  for(var dataType in data){
    switch(dataType){
      case 'temp':  
        if(this.testCharacteristic(service,Characteristic.CurrentTemperature))
        {
          //if(service.displayName.indexOf("Thermostat")>0){
            var zone = this.getZoneForDevice(deviceid);
            service.setCharacteristic(Characteristic.CurrentTemperature,this.getAverageSensor(zone,dataType));
          /*}
          else 
            service.setCharacteristic(Characteristic.CurrentTemperature,Number(data[dataType]));*/
        }
        break;
      default:
          platform.log('error','no support for',dataType,'from sensor',deviceid);
    }
  }
};
MultiZonePlatform.prototype.addAccessoriesForSensor = function(deviceid){
  for(var zone in this.zones){
    var sensor=this.zones[zone].sensors[deviceid];
    if(sensor){
      this.addAccessory(zone);
    }
  }
};
MultiZonePlatform.prototype.addAccessory = function(accessoryName) {
  for(var i in this.accessories){
    if (this.accessories[i].displayName==accessoryName) {
      return;
    }
  }
  platform.log("Add Accessory",accessoryName);
  var uuid = UUIDGen.generate(accessoryName);

  var accessory = new Accessory(accessoryName, uuid);
  accessory.on('identify', function(paired, callback) {
    platform.log(accessory.displayName, "Identify!!!");
    callback();
  });

  this.configureAccessory(accessory);
  var service=accessory.getService(Service.Thermostat);
  if(service){
    platform.log("set thermostat defaults")
    service.setCharacteristic(Characteristic.TargetTemperature, 21);
    service.setCharacteristic(Characteristic.TemperatureDisplayUnits, platform.temperatureDisplayUnits);
    service.setCharacteristic(Characteristic.CurrentHeatingCoolingState, Characteristic.CurrentHeatingCoolingState.OFF);
  }
  this.api.registerPlatformAccessories("homebridge-thermo", "MultiZonePlatform", [accessory]);
};
MultiZonePlatform.prototype.configureAccessory = function(accessory) {
  platform.log(accessory.displayName,"Configure Accessory");
      
  //if(accessory.displayName.indexOf('Zone')>=0){
    this.makeThermostat(accessory);
  //}
  
  accessory.reachable = true;
  this.accessories.push(accessory);
};
MultiZonePlatform.prototype.configurationRequestHandler = function(context, request, callback) {
  platform.log("Context: ", JSON.stringify(context));
  platform.log("Request: ", JSON.stringify(request));

  if (request && request.response && request.response.inputs && request.response.inputs.name) {
    this.addAccessory(request.response.inputs.name);

    callback(null, "platform", true, 
        {
          "platform" : "MultiZonePlatform",
          "name" : "MultiZone Platform", 
          "zones" : this.zones,
          "sensorCheckMilliseconds" : this.sensorCheckMilliseconds,
          "startDelay" : this.startDelay,
          "minOnOffTime" : this.minOnOffTime,
          "serverPort" : this.serverPort,
        });
    return;
  }

  var respDict = {
    "type": "Interface",
    "interface": "input",
    "title": "Add Accessory",
    "items": [
      {
        "id": "name",
        "title": "Name",
        "placeholder": "Zone Thermostat"
      }
    ]
  };

  context.ts = "MultiZoneContext";
  callback(respDict);
};
MultiZonePlatform.prototype.makeThermostat=function(accessory){
  var zone=accessory.displayName;
  
  accessory.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, "Martin Grůza")
      .setCharacteristic(Characteristic.Model, 'Zone Thermostat')
      .setCharacteristic(Characteristic.SerialNumber, '00x000x0000x')
      .setCharacteristic(Characteristic.FirmwareRevision, '1');
  accessory.thermostatService=accessory.getService(Service.Thermostat);
    if(accessory.thermostatService==undefined){
      accessory.thermostatService=accessory.addService(Service.Thermostat, accessory.displayName);
      platform.log("added ThermostatService");
    }
  var characteristic=accessory.thermostatService.getCharacteristic(Characteristic.TargetTemperature);
  characteristic.validateValue = (temp) => {
    if(temp>=platform.reasonableTemperatures[1].low && temp<=platform.reasonableTemperatures[1].high){
       temp=(Number(temp)-32)*5/9;
    }
    if(temp>=platform.reasonableTemperatures[0].low && temp<=platform.reasonableTemperatures[0].high){
       return Math.round( Number(temp)*10 )/10;
    }
    return 21
  };
  characteristic.on('set', (temp, callback, context) => {
    platform.log('SET TargetTemperature from', characteristic.value, 'to', temp);
    callback(null,temp);
  });
};
MultiZonePlatform.prototype.systemStateValue=function(heatingCoolingStateName) {
  if (heatingCoolingStateName.toUpperCase() === 'HEAT'){
    return Characteristic.CurrentHeatingCoolingState.HEAT
  } else if (heatingCoolingStateName.toUpperCase() === 'COOL') {
    return Characteristic.CurrentHeatingCoolingState.COOL;
  } else {
    return Characteristic.CurrentHeatingCoolingState.OFF;
  }
};
MultiZonePlatform.prototype.systemStateName=function(heatingCoolingState) {
  if (heatingCoolingState === Characteristic.CurrentHeatingCoolingState.HEAT) {
    return 'HEAT';
  } else if (heatingCoolingState === Characteristic.CurrentHeatingCoolingState.COOL) {
    return 'COOL';
  } else {
    return 'OFF';
  }
};
MultiZonePlatform.prototype.getThermostatForZone=function(zone){
  for(var i in this.accessories){
    var accessory=this.accessories[i];
    var service=accessory.getService(Service.Thermostat);
    if(service && service.displayName==zone)
    {
      return service
    }
  }
  platform.log("ERROR:  this should not be null", zone);
  return null;
};
MultiZonePlatform.prototype.currentlyRunning=function(service){
  return platform.systemStateName(service.getCharacteristic(Characteristic.CurrentHeatingCoolingState).value);
};
MultiZonePlatform.prototype.shouldTurnOnHeating=function(targetState,currentTemp,targetTemperature){
  return (targetState === Characteristic.TargetHeatingCoolingState.HEAT && 
          currentTemp < targetTemperature);
};
MultiZonePlatform.prototype.shouldTurnOnCooling=function(targetState,currentTemp,targetTemperature){
  return (targetState === Characteristic.TargetHeatingCoolingState.COOL && 
          currentTemp > targetTemperature);
};
MultiZonePlatform.prototype.turnOnSystem=function(zone, service, systemToTurnOn) {
    if(service.getCharacteristic(Characteristic.CurrentHeatingCoolingState).value === Characteristic.CurrentHeatingCoolingState.OFF){
      platform.log("START",this.systemStateName(systemToTurnOn), service.displayName, service.getCharacteristic(Characteristic.CurrentTemperature).value);
      service.setCharacteristic(Characteristic.CurrentHeatingCoolingState, systemToTurnOn);
      platform.updateGPIO(zone, systemToTurnOn, ON);
      this.lastCurrentHeatingCoolingStateChangeTime=new Date();
    } else if (service.getCharacteristic(Characteristic.CurrentHeatingCoolingState).value !== systemToTurnOn) {
      this.turnOffSystem(zone, service, service.getCharacteristic(Characteristic.CurrentHeatingCoolingState).value);
    }
};
MultiZonePlatform.prototype.timeSinceLastHeatingCoolingStateChange=function(){
  return (new Date() - this.lastCurrentHeatingCoolingStateChangeTime);
};
MultiZonePlatform.prototype.turnOffSystem=function(zone, service, systemToTurnOff){
  platform.log("STOP",platform.currentlyRunning(service) , service.displayName, service.getCharacteristic(Characteristic.CurrentTemperature).value);
  service.setCharacteristic(Characteristic.CurrentHeatingCoolingState, Characteristic.CurrentHeatingCoolingState.OFF);
  platform.updateGPIO(zone, Characteristic.CurrentHeatingCoolingState.OFF, OFF);
  this.lastCurrentHeatingCoolingStateChangeTime=new Date();
};  
MultiZonePlatform.prototype.updateSystem=function(){
  var changed=false;
  for(var zone in platform.zones){
    var service=platform.getThermostatForZone(zone);
    if(service){
      var currentState=service.getCharacteristic(Characteristic.CurrentHeatingCoolingState).value;
      var targetState=service.getCharacteristic(Characteristic.TargetHeatingCoolingState).value;
      var currentTemp=service.getCharacteristic(Characteristic.CurrentTemperature).value;
      var targetTemperature=service.getCharacteristic(Characteristic.TargetTemperature).value;

      if (currentState === Characteristic.CurrentHeatingCoolingState.OFF
          && targetState !== Characteristic.TargetHeatingCoolingState.OFF) {
        if (platform.shouldTurnOnHeating(targetState,currentTemp,targetTemperature)) {
          platform.turnOnSystem(zone,service,Characteristic.CurrentHeatingCoolingState.HEAT);
        } else if (platform.shouldTurnOnCooling(targetState,currentTemp,targetTemperature)) {
          platform.turnOnSystem(zone,service,Characteristic.CurrentHeatingCoolingState.COOL);
        } 
      } else if (currentState !== Characteristic.CurrentHeatingCoolingState.OFF
          && targetState === Characteristic.TargetHeatingCoolingState.OFF) {
            platform.turnOffSystem(zone,service,currentState);
      } else if (currentState !== Characteristic.CurrentHeatingCoolingState.OFF
          && targetState !== Characteristic.TargetHeatingCoolingState.OFF) {
        if (platform.shouldTurnOnHeating(targetState,currentTemp,targetTemperature)) {
          platform.turnOnSystem(zone,service,Characteristic.CurrentHeatingCoolingState.HEAT);
        } else if (platform.shouldTurnOnCooling(targetState,currentTemp,targetTemperature)) {
          platform.turnOnSystem(zone,service,Characteristic.CurrentHeatingCoolingState.COOL);
        } else {
          platform.turnOffSystem(zone,service,Characteristic.CurrentHeatingCoolingState.OFF);
        }
      } 
      if (platform.timeSinceLastHeatingCoolingStateChange() > platform.minOnOffTime*4) {
        platform.updateGPIO(zone,currentState, currentState !== Characteristic.CurrentHeatingCoolingState.OFF ? ON : OFF);
        changed=true;
      }
    }
  }
  if(changed){
    platform.lastCurrentHeatingCoolingStateChangeTime=new Date();
  }
  for(var zone in platform.zones){
	for(var deviceid in platform.zones[zone].sensors){
      		var temp=platform.zones[zone].sensors[deviceid].temp;
		if(temp && temp<platform.alarmTemp){
			platform.log("LOW TEMP ALARM", deviceid);
			platform.sendSNSMessage("ALARM Temp:"+deviceid+"="+(temp*9/5+32)+"F");
		}
	}
  }
};
MultiZonePlatform.prototype.startControlLoop=function(){
  platform.lastCurrentHeatingCoolingStateChangeTime=new Date();
  platform.log("startControlLoop",platform.minOnOffTime);
  setTimeout(function(){
    for(var zone in platform.zones){
      var service=platform.getThermostatForZone(zone);
      if(service)
        platform.updateGPIO(zone,service.getCharacteristic(Characteristic.CurrentHeatingCoolingState).value, ON);
    }
  },10000);
  platform.updateInterval=setInterval(function(){platform.updateSystem();},platform.minOnOffTime);
};
