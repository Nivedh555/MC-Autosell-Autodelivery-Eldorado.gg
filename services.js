'use strict';

   
                                                                             
                                                                           
   

const { EventEmitter } = require('events');

const services = {
                                   
  config: null,
                                            
  discordClient: null,
                                           
  logger: null,
                                                                        
  mcBot: null,
                                                                                   
  buyer2Bot: null,
                                                                            
  logChannels: null,
                                                                             
  statsChannels: null,
                                                        
  wallet: null,
                                         
  sellManager: null,
                                       
  store: null,

                     
                                        
  db: null,
                                              
  settings: null,
                                        
  vault: null,
                                          
  ledger: null,
                                                      
  sessions: null,
  get sessionManager() {
    return this.sessions || require('./minecraft/session-manager');
  },
  set sessionManager(mgr) {
    this.sessions = mgr;
  },
                                                     
  treasury: null,
                                                  
  pairsRepo: null,
                                                  
  pairManager: null,
                                                
  marketplace: null,
                                            
  httpClient: null,
                                              
  events: new EventEmitter(),
};

module.exports = services;
