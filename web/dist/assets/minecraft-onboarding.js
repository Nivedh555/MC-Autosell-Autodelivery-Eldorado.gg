export function minecraftOnboarding(React, request) {
  const { createElement: h, useEffect, useRef, useState } = React;
  const post = (url, body) => request(url, { method: 'POST', body: JSON.stringify(body) });
  const field = (text, control) => h('label', null, text, React.cloneElement(control, { 'aria-label': text }));

  return function MinecraftOnboarding({ pairs = [], accounts = [], onChange }) {
    const [data, setData] = useState(null);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const [rootId, setRootId] = useState('');
    const [instanceId, setInstanceId] = useState('');
    const [accountId, setAccountId] = useState('seller1');
    const [ign, setIgn] = useState('');
    const [rootPath, setRootPath] = useState('');
    const [gameClosed, setGameClosed] = useState(false);
    const [result, setResult] = useState(null);
    const working = useRef(false);
    const slots = pairs.flatMap(pair => ['seller', 'buyer'].map(role => role + pair.pairIndex));
    const root = data?.roots.find(item => item.id === rootId);
    const instance = root?.instances.find(item => item.id === instanceId);
    const installedAccount = accounts.find(account => account.id === (result?.accountId || accountId));

    function accept(response) {
      if (!Array.isArray(response?.roots) || !response.release) throw Error('Restart Autosell to load Minecraft setup, then refresh this page.');
      setData(response);
      setRootId(current => response.selectedRootId || (response.roots.some(item => item.id === current) ? current : response.roots[0]?.id || ''));
    }
    async function run(operation) {
      if (working.current) return;
      working.current = true;
      setBusy(true);
      setError('');
      try { await operation(); }
      catch (cause) { setError(cause.status === 404 ? 'Restart Autosell to load Minecraft setup, then refresh this page.' : cause.message || 'Minecraft setup failed. Refresh and try again.'); }
      finally { working.current = false; setBusy(false); }
    }
    useEffect(() => { run(async () => accept(await request('/v3/game/onboarding'))); }, []);
    useEffect(() => { if (slots.length && !slots.includes(accountId)) setAccountId(slots[0]); }, [slots.join('|')]);
    useEffect(() => {
      const account = accounts.find(item => item.id === accountId);
      if (account) setIgn(account.ign);
    }, [accountId, accounts.map(account => account.id + ':' + account.ign).join('|')]);
    async function install(event) {
      event.preventDefault();
      await run(async () => {
        const response = await post('/v3/game/onboarding/install', {
          rootId, ...(instanceId ? { instanceId } : { create: true }), accountId, ign: ign.trim(), gameClosed,
        });
        setResult(response);
        setGameClosed(false);
        accept(await request('/v3/game/onboarding'));
        await onChange?.();
      });
    }
    const button = (text, onClick, disabled = false) => h('button', { type: 'button', onClick, disabled }, text);
    return h('div', { className: 'desk-minecraft-setup' },
      h('h4', null, 'Set up Minecraft in Prism'),
      h('p', null, 'Choose a Prism instance and delivery account. Autosell installs the required mods and connects that instance to this account slot.'),
      h('div', { className: 'desk-row' },
        button(busy ? 'Working…' : 'Refresh Prism folders', () => run(async () => accept(await request('/v3/game/onboarding'))), busy),
        h('a', { href: 'https://prismlauncher.org/download/', target: '_blank', rel: 'noreferrer' }, 'Install Prism Launcher ↗')),
      error ? h('p', { role: 'alert', className: 'desk-setup-error' }, error) : null,
      data?.release.ready === false ? h('p', { role: 'alert', className: 'desk-setup-error' }, data.release.error) : null,
      data && data.roots.length === 0 ? h('p', null, 'Open Prism once to finish its setup, then refresh. For a portable installation, add its launcher root below.') : null,
      h('details', null, h('summary', null, 'Use a portable or different Prism folder'),
        h('p', null, 'In Prism choose Folders → Launcher Root. Copy that folder path here. It contains prismlauncher.cfg.'),
        h('div', { className: 'desk-row' }, field('Prism launcher root', h('input', { value: rootPath, onChange: event => setRootPath(event.target.value), placeholder: 'Full folder path', autoComplete: 'off' })),
          button('Use this folder', () => run(async () => { accept(await post('/v3/game/onboarding/root', { path: rootPath.trim() })); setInstanceId(''); }), busy || !rootPath.trim()))),
      data?.roots.length ? h('form', { onSubmit: install, className: 'desk-minecraft-form' },
        field('Prism folder', h('select', { value: rootId, onChange: event => { setRootId(event.target.value); setInstanceId(''); setResult(null); } },
          ...data.roots.map(item => h('option', { key: item.id, value: item.id }, item.path)))),
        field('Minecraft instance', h('select', { value: instanceId, onChange: event => { setInstanceId(event.target.value); setResult(null); } },
          h('option', { value: '' }, 'Create Autosell Delivery instance'),
          ...(root?.instances || []).map(item => h('option', { key: item.id, value: item.id, disabled: !item.compatible || item.running },
            item.name + ' · ' + (item.compatible ? '26.3 / Fabric 0.20.1' : 'Different Minecraft or Fabric version') + (item.running ? ' · Running' : ''))))),
        h('p', null, instance ? 'Selected game folder — ' + instance.gamePath : 'Creates Minecraft 26.3 with Fabric Loader 0.20.1. Prism downloads Minecraft and Java when you launch it.'),
        h('div', { className: 'desk-minecraft-columns' },
          field('Account slot', h('select', { value: accountId, onChange: event => { setAccountId(event.target.value); setIgn(''); setResult(null); } },
            ...slots.map(slot => h('option', { key: slot, value: slot }, slot)))),
          field('Exact Minecraft IGN', h('input', { required: true, value: ign, maxLength: 17, autoComplete: 'off', spellCheck: false, onChange: event => setIgn(event.target.value), placeholder: 'Name of your delivery account' }))),
        h('label', { className: 'desk-minecraft-checkbox' }, h('input', { type: 'checkbox', checked: gameClosed, onChange: event => setGameClosed(event.target.checked) }), 'I have closed this Minecraft instance'),
        h('div', { className: 'desk-row' }, h('button', { className: 'desk-primary', disabled: busy || !gameClosed || !ign.trim() || !slots.length || !data.release.ready }, busy ? 'Installing…' : 'Install mods and pair')),
        !slots.length ? h('p', null, 'Create an account pair above before installing your delivery client.') : null) : null,
      result ? h('div', { className: 'desk-minecraft-result', role: 'status' }, h('strong', null, 'Minecraft files installed'), h('p', null, result.message)) : null,
      h('ol', { className: 'desk-minecraft-next' },
        h('li', null, 'In Prism, open Accounts → Manage Accounts → Add Microsoft. Sign in with the account that owns Minecraft Java and shows your exact IGN.'),
        h('li', null, 'In Prism Settings → Java, enable automatic Java detection and the Mojang Java download. If your Prism build needs a manual runtime, select Java 25.'),
        h('li', null, 'Select ' + (result?.instance?.name || instance?.name || 'Autosell Delivery ' + accountId) + ', choose ' + (result?.ign || ign || 'your delivery account') + ', and click Launch. Reopen Prism if the new instance is missing.'),
        h('li', null, 'In Minecraft, choose Multiplayer → Direct Connection → ' + (data?.server || 'donutsmp.net') + '. Keep the game open during delivery.')),
      h('p', { className: installedAccount?.connected ? 'desk-online' : 'desk-offline', 'aria-live': 'polite' },
        installedAccount?.connected ? installedAccount.id + ' connected as ' + installedAccount.ign + ' on ' + (installedAccount.host || data?.server) :
          'Waiting for the game connection. Check the chosen instance, exact IGN, server, and that Autosell is running on this computer.'),
    );
  };
}
