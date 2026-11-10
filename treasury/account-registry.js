'use strict';

class AccountRegistry {
  constructor() {
    this.accounts = new Map();
  }

     
                             
                                                                   
                                             
                                                         
                                                                                     
     
  registerAccount(id, username, role = 'spare', sessionMode = 'on_demand') {
    const account = { id, username, role, sessionMode };
    this.accounts.set(id, account);
    return account;
  }

  getAccount(id) {
    return this.accounts.get(id);
  }

  getAccountsByRole(role) {
    return Array.from(this.accounts.values()).filter(a => a.role === role);
  }

  getAllAccounts() {
    return Array.from(this.accounts.values());
  }

  removeAccount(id) {
    this.accounts.delete(id);
  }
}

module.exports = new AccountRegistry();
