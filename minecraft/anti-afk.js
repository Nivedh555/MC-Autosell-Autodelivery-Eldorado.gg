'use strict';

   
            
  
                                                                               
                                                                          
                                                                                
                                                                                
          
  
                                                                                
                                                                               
                                                                                 
                                                                              
                                                                                
                                                         
   

const services = require('../services');

class AntiAfk {
                                                                      
  constructor(mcBot) {
    this.mcBot = mcBot;
    this._timer = null;
    this._busy = false;
  }

  start() {
    const enabled = services.settings.getSync('session.antiAfk.enabled');
    const intervalMs = services.settings.getSync('session.antiAfk.intervalMs') || 45000;
    
    if (!enabled || this._timer) return;
    this._timer = setInterval(() => this._tick().catch(() => {}), intervalMs);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  async _tick() {
    const STATE = require('./account-client').STATE;                     
    const mcBot = this.mcBot;

    if (this._busy) return;
    if (!mcBot.isOnline() || mcBot.state !== STATE.IDLE) return;
    
                                                                        
                                                                 
    const manager = require('./session-manager');
    const leases = manager.getLeases(mcBot.accountId);
    if (leases.length === 0 && manager.getMode(mcBot.accountId) !== 'always_on') {
      return;                                                                
    }
    const bot = mcBot.bot;
    if (!bot || !bot.entity) return;

    this._busy = true;
    try {
      await this._randomAction(bot);
    } catch {
                                       
    } finally {
      this._busy = false;
    }
  }

                                          
  async _randomAction(bot) {
                                                                             
    const actions = ['look', 'swing', 'sneak'];
    const choice = actions[Math.floor(Math.random() * actions.length)];

    switch (choice) {
      case 'look': {
                                                                      
        const yaw = Math.random() * Math.PI * 2;
        const pitch = (Math.random() - 0.5) * 0.6;                
        await bot.look(yaw, pitch, false);
        break;
      }
      case 'swing':
        bot.swingArm('right');
        break;
      case 'sneak':
        bot.setControlState('sneak', true);
        await this._sleep(400);
        bot.setControlState('sneak', false);
        break;
      default:
        break;
    }
  }

  _sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
}

module.exports = AntiAfk;
