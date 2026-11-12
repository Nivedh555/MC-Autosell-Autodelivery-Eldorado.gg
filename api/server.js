'use strict';
const express = require('express');
const path = require('path');
const fs = require('fs');

const authRouter = require('./routes/auth');
const healthRouter = require('./routes/health');
const settingsRouter = require('./routes/settings');
const sellersRouter = require('./routes/sellers');
const salesRouter = require('./routes/sales');
const treasuryRouter = require('./routes/treasury');
const marketplaceRouter = require('./routes/marketplace');
const walletRouter = require('./routes/wallet');
const sessionsRouter = require('./routes/sessions');
const logsRouter = require('./routes/logs');
const sseRouter = require('./routes/sse');

function createServer(services) {
  const app = express();
  
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  const boundary = require('./security-boundary');
  const { verifyAuth, csrfProtection } = require('./middleware');
  app.use(boundary.originGuard);
  app.use(express.json({ limit: '2mb' }));
  app.use(['/api/auth', '/api/v2/auth'], boundary.authRouter());
  app.use('/api', verifyAuth, csrfProtection, boundary.sensitiveGuard);

  app.use('/api/ops', require('./routes/operations'));
  app.use('/api/intake', require('./routes/intake'));

  const v2 = express.Router();
  
                  
  v2.use('/health', healthRouter);
  v2.use('/auth', authRouter);

                                                                        
  const requireAuth = verifyAuth;

  v2.use('/settings', requireAuth, settingsRouter);
  v2.use('/sellers', requireAuth, sellersRouter);
  v2.use('/sales', requireAuth, salesRouter);
  v2.use('/treasury', requireAuth, treasuryRouter);
  v2.use('/marketplace', requireAuth, marketplaceRouter);
  v2.use('/wallet', requireAuth, walletRouter);
  v2.use('/sessions', requireAuth, sessionsRouter);
  v2.use('/logs', requireAuth, logsRouter);
  v2.use('/events', requireAuth, sseRouter);

  app.use('/api/v2', v2);
  app.use('/api/v3', require('../v3/routes'));
  app.get('/classic', (_req,res)=>res.sendFile(path.join(__dirname,'../web/dist/index.html')));
  app.get(['/', '/v3', '/v3/index.html'], (_req,res)=>res.sendFile(path.join(__dirname,'../web/dist/index.html')));

                                                              
  app.use('/api/marketplace', marketplaceRouter);
  app.use('/api/proofs', (req, res, next) => {
    req.url = '/proofs' + req.url;
    marketplaceRouter(req, res, next);
  });
  app.use('/api/pairs', (req, res, next) => {
    req.url = '/pairs' + req.url;
    marketplaceRouter(req, res, next);
  });
  app.use('/api/events', sseRouter);
  app.use('/api/env', require('./routes/env'));

                                                                           
  try {
    const v1Routes = require('./routes');
    app.use('/api', v1Routes);
  } catch(e) {
    console.log('[server] v1 routes not loaded:', e.message);
  }

                                             
  const distDir = path.join(__dirname, '../web/dist');
  const distIndex = path.join(distDir, 'index.html');
  const legacyIndex = path.join(__dirname, '../web/legacy-index.html');
  app.get('/operations', (_req, res) => res.sendFile(path.join(__dirname, '../web/operations.html')));
  app.get('/intake-setup', (_req, res) => res.sendFile(path.join(__dirname, '../web/intake-setup.html')));
  app.get('/assets/gsap.min.js', (_req,res) => res.sendFile(require.resolve('gsap/dist/gsap.min.js')));

  app.use('/assets', express.static(path.join(distDir, 'assets')));
  app.use(express.static(distDir));

                           
  app.get(['/legacy', '/legacy-index.html'], (req, res) => {
    if (fs.existsSync(legacyIndex)) {
      res.sendFile(legacyIndex);
    } else {
      res.redirect('/');
    }
  });

                            
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    if (fs.existsSync(distIndex)) {
      res.sendFile(distIndex);
    } else if (fs.existsSync(legacyIndex)) {
      res.sendFile(legacyIndex);
    } else {
      res.sendFile(path.join(__dirname, '../web/index.html'));
    }
  });

                  
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: err.message } });
  });

  return app;
}
module.exports = { createServer };
