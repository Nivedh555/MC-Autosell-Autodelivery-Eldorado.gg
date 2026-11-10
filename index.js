'use strict';
process.chdir(__dirname);
process.env.AUTOSELL_GAME_TRANSPORT = 'fabric';
require('dotenv').config({ path: require('node:path').join(__dirname, '.env') });
const ConsoleLogger = require('./services/console-logger');
ConsoleLogger.install();

   
                                         
   

const config = require('./config');
const services = require('./services');

require('./minecraft/protocol-patch').apply();

const DiscordLogger = require('./discord/logger');
const MinecraftBot = require('./minecraft/bot');
const VerifyBot = require('./minecraft/verify-bot');
const SellStore = require('./sell/store');
const SellManager = require('./sell/manager');
const exchange = require('./sell/exchange');
const { LtcWallet } = require('./wallet/ltc-wallet');
const discordClient = require('./discord/client');

async function main() {
  const releaseInstance = require('./ops/instance-lock').acquire(require('node:path').join(__dirname, 'data'));
  process.once('exit', releaseInstance);
  services.buildStatus=new(require('./ops/build-status').BuildStatus)(__dirname);
  const path = require('path');
  const readline = require('readline');
  const Database = require('./db/database');
  const { SettingsRegistry, loadDefaults } = require('./settings/registry');
  const Ledger = require('./ledger/ledger');
  const Reconciler = require('./ledger/reconciler');
  const SessionManager = require('./minecraft/session-manager');
  const TreasuryRouter = require('./treasury/treasury-router');
  const apiServer = require('./api/server');
  
                                            
  const DiscordLogger = require('./discord/logger');
  const discordClient = require('./discord/client');
  ConsoleLogger.banner(`
\x1b[38;2;225;29;72m  █████╗ ██╗   ██╗████████╗ ██████╗ ███████╗███████╗██╗     ██╗     \x1b[0m
\x1b[38;2;244;63;94m ██╔══██╗██║   ██║╚══██╔══╝██╔═══██╗██╔════╝██╔════╝██║     ██║     \x1b[0m
\x1b[38;2;251;113;133m ███████║██║   ██║   ██║   ██║   ██║███████╗█████╗  ██║     ██║     \x1b[0m
\x1b[38;2;253;164;175m ██╔══██║██║   ██║   ██║   ██║   ██║╚════██║██╔══╝  ██║     ██║     \x1b[0m
\x1b[38;2;254;205;211m ██║  ██║╚██████╔╝   ██║   ╚██████╔╝███████║███████╗███████╗███████╗\x1b[0m
\x1b[38;2;254;226;226m ╚═╝  ╚═╝ ╚═════╝    ╚═╝    ╚═════╝ ╚══════╝╚══════╝╚══════╝╚══════╝\x1b[0m
\x1b[90m ───────────────────────────────────────────────────────────────────────\x1b[0m
\x1b[1m\x1b[37m  AUTOSELL V3.0 \x1b[0m\x1b[90m| DonutSMP Trading\x1b[0m
\x1b[90m ───────────────────────────────────────────────────────────────────────\x1b[0m
`);

  ConsoleLogger.bootStep(1, 7, 'Connecting database & trade records...');
  const dbPath = path.join(__dirname, 'data/autosell.db');
  const db = await Database.open(dbPath);
  require('./marketplace/browser/message-outbox').recover(db.raw());
  services.db = db;
  ConsoleLogger.bootSuccess('Local database ready');
  ConsoleLogger.line('INFO','BUILD','Backend build '+services.buildStatus.buildId,{PID:process.pid});
  console.log('');

  ConsoleLogger.bootStep(2, 7, 'Loading configuration & security vault...');
  const vaultPath = path.join(__dirname, 'data/vault.enc');
  const passphrase = process.env.VAULT_PASSPHRASE;
  const settings = new SettingsRegistry(dbPath, vaultPath, passphrase);
  await settings.init();
  loadDefaults(settings);
  services.config = config;
  services.settings = settings;
  services.vault = settings.vault;
  await config.bindRegistry(settings);
  await require('./minecraft/donutsmp-profile').configure(settings);
  services.apiKey = await require('./ops/api-key-policy').selectKey(settings, process.env, path.join(__dirname,'data/revoked-api-keys.json'));
  services.discordClient = discordClient;
  services.logger = new DiscordLogger();
  const { OperationsMonitor } = require('./ops/monitor');
  services.ops = new OperationsMonitor(services); services.ops.start();
  ConsoleLogger.bootInfo('Settings loaded; external credentials have not been validated');
  console.log('');

  ConsoleLogger.bootStep(3, 7, 'Initializing wallet & order processing services...');
  const store = new SellStore();
  store.load();
  services.store = store;

  const wallet = new LtcWallet();
  wallet.init();
  services.wallet = wallet;
  await require('./v3/init').init(services);
  await require('./payments/automatic-intake').configure(settings);

  services.sellManager = new SellManager(store);
  const ledger = new Ledger(db.raw());
  services.ledger = ledger;
  db.raw().prepare("UPDATE intake_sales SET state='NEEDS_OPERATOR',reason='Restart during intake; reconcile account balance and captured receipt' WHERE state IN ('ARMED','CHECKING')").run();
  db.raw().prepare("UPDATE payout_intents SET state='NEEDS_OPERATOR',reason='Restart with pending broadcast; inspect wallet history before any further payout' WHERE state='BROADCAST_INTENT'").run();
  db.raw().prepare("UPDATE intake_sales SET state='COMPLETED' WHERE state='RECEIVED' AND EXISTS (SELECT 1 FROM payout_intents p WHERE p.id=intake_sales.id AND p.state='BROADCAST')").run();
  db.raw().prepare("UPDATE intake_sales SET state='NEEDS_OPERATOR',reason='Restart after receipt; reconcile this unpaid sale before accepting more funds' WHERE state='RECEIVED'").run();
                                                                                 
                                                                
  db.raw().prepare("UPDATE orders SET status=CASE WHEN status='queued' THEN 'cancelled' ELSE 'needs_operator' END WHERE status IN ('queued','collecting')").run();
  ConsoleLogger.bootInfo(`Ledger open; wallet ${wallet.enabled ? 'configured' : 'not configured'}`);
  console.log('');

  ConsoleLogger.bootStep(4, 7, 'Configuring DonutSMP accounts & trading pairs...');
  const sessions = require('./minecraft/session-manager');
  services.sessions = sessions;
  services.calibration = new (require('./ops/calibration').CalibrationRecorder)(services);
  services.sessionManager = sessions;

  let buyer1Client = sessions.getClient('buyer1');
  if (!buyer1Client) {
    buyer1Client = new MinecraftBot('buyer1');
    sessions.clients.set('buyer1', buyer1Client);
    sessions._bindClientEvents('buyer1', buyer1Client);
  }
  services.mcBot = buyer1Client;

  let buyer2Client = sessions.getClient('buyer2');
  if (!buyer2Client) {
    buyer2Client = new VerifyBot('buyer2');
    sessions.clients.set('buyer2', buyer2Client);
    sessions._bindClientEvents('buyer2', buyer2Client);
  }
  services.buyer2Bot = buyer2Client;
  for (const accountId of Object.keys(await settings.get('treasury.accountRoles'))) {
    if (['buyer1', 'buyer2'].includes(accountId)) continue;
    const client = sessions.getClient(accountId);
  }

  try {
    const d1 = typeof buyer1Client.getDetectedIgn === 'function' ? buyer1Client.getDetectedIgn() : null;
    const ign1 = d1 || services.config?.mc?.ign || 'Account 1';
    ConsoleLogger.bootInfo(`Account 1 label: ${ign1}; connected: ${buyer1Client.isOnline()}`);

    const d2 = typeof buyer2Client.getDetectedIgn === 'function' ? buyer2Client.getDetectedIgn() : null;
    const ign2 = d2 || services.config?.mc?.buyer2Ign || 'Account 2';
    ConsoleLogger.bootInfo(`Account 2 label: ${ign2}; connected: ${buyer2Client.isOnline()}`);
  } catch {}

  const treasury = require('./treasury/treasury-router');
  services.treasury = treasury;
  db.raw().prepare("UPDATE transfer_queue SET state='NEEDS_OPERATOR' WHERE state='PROCESSING'").run();
  await treasury.start();

  const PairManager = require('./treasury/pair-manager');
  const pairManager = new PairManager(store.pairsRepo);
  await pairManager.init();
  services.pairManager = pairManager;
  const pCount = pairManager.getPairs?.().length || 0;
  ConsoleLogger.bootInfo(`${pCount} pair records configured; balances and account connectivity require live checks`);
  console.log('');

  ConsoleLogger.bootStep(5, 7, 'Connecting Eldorado marketplace order monitor...');
  try {
    const { EldoradoOfficialAdapter } = require('./marketplace/adapters/eldorado-official');
    const { DeliveryService } = require('./marketplace/delivery-service');
    const { OrderPoller } = require('./marketplace/order-poller');
    const { OrderNotifier } = require('./marketplace/order-notifier');
    const { RolloutController } = require('./marketplace/rollout');

    services.rollout = new RolloutController(db, settings, services.events, { pauseListings: () => services.listingManager?.pauseAll() });

    if (['browser','hybrid','api'].includes(settings.getSync('eldorado.connection'))) {
      services.browserBridge = new (require('./marketplace/browser/playwright-session').PlaywrightSession)(services);
      await services.browserBridge.start();
    }
    const adapter = require('./marketplace/create-adapter').createAdapter();
    services.marketplace = adapter;
    services.offerQueue = new (require('./marketplace/offer-queue').OfferQueue)(db);

    const { ListingManager } = require('./marketplace/listing-manager');
    const { PricingEngine } = require('./marketplace/pricing-engine');
    services.pricingEngine = new PricingEngine(settings);
    services.listingManager = new ListingManager(adapter, services.pricingEngine, { db, settings, sessions });

    const deliveryService = new DeliveryService(sessions, ledger, settings, adapter);
    services.deliveryService = deliveryService;
    deliveryService.recover();
    if (services.browserBridge) {
      services.browserFulfillment = new (require('./marketplace/browser/fulfillment').BrowserFulfillment)(services);
      await require('./marketplace/browser/runtime-settings').configure(settings);
      // V3 starts with fresh records; never import another installation's payment captures.
    }

    const orderNotifier = new OrderNotifier();
    services.orderNotifier = orderNotifier;

    const orderPoller = new OrderPoller(adapter, deliveryService);
    services.orderPoller = orderPoller;
    services.chatScheduler = new (require('./marketplace/chat-scheduler').ChatScheduler)(services);
    await services.chatScheduler.start();
    await services.listingManager.start();
    orderPoller.start();
    ConsoleLogger.bootInfo('Marketplace reader initialized; actual browser connection and account stock determine readiness');
  } catch(e) {
    ConsoleLogger.bootWarn(`Marketplace monitor: ${e.message}`);
  }
  console.log('');

  ConsoleLogger.bootStep(6, 7, 'Starting Web Dashboard server...');
  const dashboardBind = require('./ops/dashboard-bind');
  const { port, host } = await dashboardBind.resolveBind(settings);
  if (!['127.0.0.1', '::1'].includes(host)) {
    if (settings.getSync('security.api.remoteEnabled') !== true) throw new Error('Remote API bind requires explicit opt-in');
    ConsoleLogger.bootWarn('Remote API access enabled: use TLS and an explicit origin allow-list');
  }

  const app = apiServer.createServer(services);
  await dashboardBind.listen(app, { port, host });
  ConsoleLogger.line('READY', 'DASHBOARD', 'Dashboard is listening', { Address: `http://${host === '::1' ? '[::1]' : host}:${port}` });
  console.log('');

  ConsoleLogger.bootStep(7, 7, 'Checking notification channels & verifying integrity...');
  try {
    const hasToken = Boolean(config.discord?.token || process.env.DISCORD_TOKEN);
    if (hasToken) {
      await discordClient.start();
      ConsoleLogger.bootSuccess('Discord bot connected for alerts');
    } else {
      services.discordClient = null;
      ConsoleLogger.bootInfo('Discord notifications offline (Optional: add token in Environment Studio)');
    }
  } catch(e) {
    services.discordClient = null;
    ConsoleLogger.bootInfo('Discord notifications offline (Optional: add token in Environment Studio)');
  }

  try {
    const diffs = ledger.reconciler.run();
    if (diffs.length === 0) {
      ConsoleLogger.bootInfo('Local ledger reconciliation reported no differences');
    }
  } catch {}

                                        
  ConsoleLogger.attachRuntimeEvents(services);
                                                                            
                                                                              
  services.treasury?.requestBalanceRefresh();

  ConsoleLogger.section('STARTUP COMPLETE');
  ConsoleLogger.line('READY', 'DASHBOARD', 'Ready for owner access', { Address: `http://${host === '::1' ? '[::1]' : host}:${port}`, Pairs: pCount });
  ConsoleLogger.line(services.discordClient?.isReady?.() ? 'READY' : 'WAIT', 'DISCORD', services.discordClient?.isReady?.() ? 'Connected; system alerts use log channels' : 'Not connected; check Discord settings');
  ConsoleLogger.line('INFO', 'AUTOSell', 'Trading follows Global Autosell and each pair’s switch');
  ConsoleLogger.line('WAIT', 'ELDORADO', services.browserFulfillment
    ? 'Connect the selected seller profile in Eldorado Setup. Offer status and account stock are checked automatically.'
    : 'API processing requires its verified contract and server payment signals.', {});
  ConsoleLogger.section('LIVE ACTIVITY');

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    ConsoleLogger.line('WAIT', 'SHUTDOWN', 'Closing sessions and stopping services', { Signal: signal });
    try {
      services.orderPoller?.stop();
      services.chatScheduler?.stop();
      services.treasury?.stop();
      services.v3Notifications?.stop();
      if(services.deliveryService&&!await services.deliveryService.stop(30000))ConsoleLogger.line('WAIT','SHUTDOWN','Delivery drain timed out; persisted payment records remain held for reconciliation. No payment will be replayed.');
      try{await services.listingManager?.stop();}catch(error){ConsoleLogger.line('WAIT','SHUTDOWN','Offer pause could not be confirmed: '+error.message);}
      if (services.sessions) await services.sessions.shutdownAll();
      await services.browserBridge?.close();
      services.ops?.stop();
      services.v3Notifications?.stop();
      services.v3PayoutMonitor?.stop();
      await services.gameBridge?.close();
      services.calibration?.close();
      services.orderNotifier?.stop();
      services.pairManager?.stop();
      if (services.discordClient) services.discordClient.destroy();
    } catch(e) {
      ConsoleLogger.line('ERROR', 'SHUTDOWN', require('./discord/log-text').readableReason(e.message));
    } finally {
      process.exit(0);
    }
  };
  services.shutdown = shutdown;
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

                                                                         
let fatalInProgress = false;
function fatalStop(kind, error) {
  if (fatalInProgress) return;
  fatalInProgress = true;
  ConsoleLogger.line('ERROR', 'APPLICATION', 'Application stopped after an unexpected error', { Type: error?.name || 'Error', Event: kind, 'Next step': 'Review the dashboard activity feed and local journals before restarting.' });
  try {
    services.browserBridge?.pause('Application fault');
  } catch {                                                                      }
  services.orderPoller?.stop();
  services.chatScheduler?.stop();
  services.treasury?.stop();
  Promise.resolve(services.sessions?.shutdownAll()).catch(()=>{}).finally(()=>process.exit(1));
}
process.on('unhandledRejection', error => fatalStop('unhandledRejection', error));
process.on('uncaughtException', error => fatalStop('uncaughtException', error));

main().catch((err) => {
                                        
  ConsoleLogger.line('ERROR', 'STARTUP', 'Autosell could not start', { Reason: require('./discord/log-text').readableReason(err.message) });
  process.exit(1);
});
