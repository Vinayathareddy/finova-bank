import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Chip, MenuItem, TextField } from '@mui/material';
import { ArrowLeftRight, Globe2, Landmark, List, LogOut, RefreshCw, Send } from 'lucide-react';
import { toPaise } from './amount';
import { configuredEndpoint, liveApi, parseEndpoint, readStorage, saveStorage } from './live-api';
import './live.css';

const money = minor => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(minor / 100);
const time = value => value ? new Intl.DateTimeFormat('en-IN', {
  dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata',
}).format(new Date(value)) : '—';

const statusNames = {
  PENDING: 'Pending', PROCESSING: 'Processing', COMPLETED: 'Completed', REJECTED: 'Rejected', MANUAL_REVIEW: 'Manual review',
};
const rejectionNames = {
  INSUFFICIENT_FUNDS: 'Insufficient available balance',
  LIMIT_EXCEEDED: 'Transfer limit exceeded',
  DESTINATION_ACCOUNT_UNAVAILABLE: 'The destination is unavailable',
};
const byId = (directory, id) => directory.find(bank => bank.bankId === id)?.bankName || id;

function TransferForm({ bank, accounts, directory, send }) {
  const [type, setType] = useState('interbank');
  const [from, setFrom] = useState('');
  const [destination, setDestination] = useState('');
  const [number, setNumber] = useState('');
  const [amount, setAmount] = useState('200');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const sources = accounts.filter(account => account.status === 'ACTIVE');
  const fromId = sources.some(item => item.accountId === from) ? from : (sources[0]?.accountId || '');
  const routes = directory.filter(item => item.bankId !== bank.id && item.status === 'ACTIVE');
  const route = destination ? (routes.find(item => item.ifsc === destination)?.ifsc || '') : (routes[0]?.ifsc || '');
  const target = type === 'internal' ? bank.ifsc : route;

  async function submit(event) {
    event.preventDefault();
    setError('');
    const amountMinor = toPaise(amount);
    if (!fromId || !target || !number.trim() || amountMinor === null) {
      setError('Choose a source, destination and positive amount with at most two decimal places.');
      return;
    }
    setBusy(true);
    try {
      await send({ fromAccountId: fromId, destinationIfsc: target,
        destinationAccountNumber: number.trim(), amountMinor, currency: 'INR' });
      setNumber('');
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }

  return <section className="panel live-transfer"><header className="panel-head"><div>
    <h2>Send a test transfer</h2><p>Transfers use synthetic balances stored in Firestore.</p>
  </div><Send size={19} /></header>
    <form className="transfer-form" onSubmit={submit}>
      <div className="type-switch">
        {[['interbank', 'Interbank'], ['internal', 'Same bank']].map(([value, label]) => <Button key={value}
          type="button" aria-pressed={type === value} variant={type === value ? 'contained' : 'outlined'}
          disabled={busy} onClick={() => setType(value)}>{label}</Button>)}
      </div>
      <TextField select label="From account" required value={fromId} onChange={e => setFrom(e.target.value)} disabled={busy || !sources.length}>
        {sources.map(account => <MenuItem key={account.accountId} value={account.accountId}>
          {account.accountNumber} · {money(account.availableMinor)} available
        </MenuItem>)}
      </TextField>
      {type === 'interbank' && <TextField select label="Destination bank" required value={route}
        onChange={e => setDestination(e.target.value)} disabled={busy || !routes.length}>
        {routes.map(item => <MenuItem key={item.ifsc} value={item.ifsc}>{item.bankName} · {item.ifsc}</MenuItem>)}
      </TextField>}
      <TextField label="Destination account number" required value={number} onChange={e => setNumber(e.target.value)} disabled={busy} />
      <TextField label="Amount in INR" required value={amount} onChange={e => setAmount(e.target.value)} disabled={busy}
        slotProps={{ htmlInput: { inputMode: 'decimal' } }} />
      {error && <Alert severity="error">{error}</Alert>}
      <div><Button type="submit" variant="contained" disabled={busy || !fromId || !target} startIcon={<Send size={16} />}>
        {busy ? 'Submitting…' : 'Submit transfer'}
      </Button></div>
    </form>
  </section>;
}

function Activity({ rows, directory }) {
  return <section className="panel"><header className="panel-head"><div><h2>Transfer activity</h2><p>Latest 50 transfers for this user</p></div><List size={19} /></header>
    {rows.length ? <div className="table-scroll"><table>
      <thead><tr><th>Transfer</th><th>Route</th><th>Amount</th><th>Status</th></tr></thead>
      <tbody>{rows.map(row => <tr key={row.transferId}>
        <td><strong>{row.transferId}</strong><small>{time(row.createdAt)}</small></td>
        <td><strong>{byId(directory, row.sourceBankId)} → {byId(directory, row.destinationBankId)}</strong><small>
          {row.type === 'INTERNAL' ? 'Same bank' : row.direction === 'CREDIT' ? 'Incoming' : 'Outgoing'}
        </small></td>
        <td className={row.direction === 'CREDIT' ? 'incoming amount' : 'amount'}>{money(row.amountMinor)}</td>
        <td><Chip size="small" label={statusNames[row.status] || row.status}
          className={row.status === 'COMPLETED' ? 'completed' : 'live-' + row.status?.toLowerCase()} />
          {row.code && <small>{rejectionNames[row.code] || row.code.toLowerCase().replaceAll('_', ' ')}</small>}</td>
      </tr>)}</tbody>
    </table></div> : <div className="empty"><ArrowLeftRight size={23} /><strong>No transfers yet</strong><p>Your transfers appear here when the Worker accepts them.</p></div>}
  </section>;
}

export default function LiveBank({ bank, switchUrl, openDemo }) {
  const urlKey = 'x42-cloudflare-worker-url';
  const [base, setBase] = useState(() => configuredEndpoint || readStorage(localStorage, urlKey, ''));
  const [session, setSession] = useState(null);
  const prefix = '/banks/' + bank.id;
  const [url, setUrl] = useState(base);
  const [editUrl, setEditUrl] = useState(!base);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [data, setData] = useState({ accounts: [], transfers: [] });
  const [directory, setDirectory] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const activeToken = useRef(null);
  activeToken.current = session?.token;
  const pending = useRef(new Map());
  const refresh = useCallback(async signal => {
    if (!session) return;
    try {
      const value = await liveApi(base, prefix + '/dashboard', { token: session.token, signal });
      if (signal?.aborted || activeToken.current !== session.token) return;
      setData(value);
      setLoaded(true);
      setError('');
    } catch (failure) {
      if (signal?.aborted || activeToken.current !== session.token) return;
      if (failure.status === 401) {
        setSession(null);
        setData({ accounts: [], transfers: [] });
        setLoaded(false);
      }
      setError(failure.message);
    }
  }, [base, prefix, session]);

  useEffect(() => {
    if (!session) return undefined;
    const controller = new AbortController();
    const update = () => { if (document.visibilityState === 'visible') refresh(controller.signal); };
    refresh(controller.signal);
    const timer = setInterval(update, 12_000);
    document.addEventListener('visibilitychange', update);
    return () => {
      clearInterval(timer);
      controller.abort();
      document.removeEventListener('visibilitychange', update);
    };
  }, [session, refresh]);

  useEffect(() => {
    if (!session) return undefined;
    const controller = new AbortController();
    liveApi(base, '/directory/banks', { signal: controller.signal })
      .then(value => setDirectory(value.banks || []))
      .catch(failure => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [base, session]);

  function logout() {
    setSession(null);
    setLoaded(false);
    setData({ accounts: [], transfers: [] });
    setNote('');
  }

  async function signIn(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const value = await liveApi(base, prefix + '/sign-in', { data: { email: email.trim(), password } });
      setSession(value);
    } catch (failure) { setError(failure.message); }
    finally { setPassword(''); setBusy(false); }
  }

  function connect(event) {
    event.preventDefault();
    setError('');
    try {
      const endpoint = parseEndpoint(url);
      if (endpoint !== base) { logout(); setDirectory([]); }
      saveStorage(localStorage, urlKey, endpoint);
      setBase(endpoint);
      setEditUrl(false);
    } catch (failure) { setError(failure.message); }
  }

  async function send(transfer) {
    const raw = JSON.stringify([bank.id, base, session.uid, transfer]);
    const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw)));
    const hash = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    const keyName = 'x42-pending-' + hash;
    const key = pending.current.get(keyName) || readStorage(sessionStorage, keyName, null) || crypto.randomUUID();
    pending.current.set(keyName, key);
    saveStorage(sessionStorage, keyName, key);
    const row = await liveApi(base, prefix + '/transfers', { token: session.token, data: transfer, key });
    pending.current.delete(keyName);
    saveStorage(sessionStorage, keyName, null);
    const verb = row.status === 'COMPLETED' ? 'Completed' : row.status === 'REJECTED' ? 'Rejected' :
      row.status === 'MANUAL_REVIEW' ? 'Manual review' : 'Accepted';
    setNote(verb + ' · ' + row.transferId);
    await refresh();
  }

  return <div className="layout live-bank-layout">
    <aside className="sidebar"><div className="brand"><span className="brand-icon"><Landmark size={23} /></span>
      <span><strong>{bank.wordmark}</strong><small>PERSONAL BANKING</small></span></div>
      <div className="sidebar-caption">YOUR WORKSPACE</div>
      <nav aria-label="Bank actions">
        {session && <a className="sidebar-nav-link" href="#accounts"><Landmark size={18} /> My accounts</a>}
        {session && <a className="sidebar-nav-link" href="#send-money"><Send size={18} /> Send money</a>}
        {session && <a className="sidebar-nav-link" href="#activity"><List size={18} /> Transactions</a>}
        {session && <button onClick={() => refresh()}><RefreshCw size={18} /> Refresh balances</button>}
        {!configuredEndpoint && <button onClick={() => { setUrl(base); setEditUrl(!editUrl); }}><Globe2 size={18} /> Worker connection</button>}
        {openDemo && <button onClick={openDemo}><ArrowLeftRight size={18} /> Browser demo</button>}
        {session && <button onClick={logout}><LogOut size={18} /> Sign out</button>}
      </nav>
      <a className="switch-link" href={switchUrl}><Globe2 size={17} /> SharedBank switch</a>
    </aside>
    <div className="main">
      <header className="topbar"><div className="topbar-bank"><span className="topbar-mark"><Landmark size={17} /></span><div><strong>{bank.name}</strong><small>Secure digital banking</small></div></div><Chip label="TEST NETWORK" size="small" className="demo" /></header>
      <main className="content live-bank-content">
        <div className="page-head"><div><span className="eyebrow">{session ? 'OVERVIEW' : 'WELCOME TO ' + bank.name.toUpperCase()}</span><h1>{session ? 'Good to see you' : 'Banking, made simpler.'}</h1>
          <p>{session ? 'Here is your account overview and recent activity.' : 'Sign in securely to manage your accounts and transfers.'}</p>
          {session && <div className="signed-in-line"><span className="online-dot" /> Signed in as <strong>{session.email}</strong></div>}
        </div></div>
        {error && <Alert severity="error">{error}</Alert>}
        {note && <Alert severity="info" onClose={() => setNote('')}>{note}</Alert>}
        {editUrl && <section className="panel"><header className="panel-head"><div><h2>Worker connection</h2>
          <p>Use the same Cloudflare Worker URL across the bank pages.</p></div></header>
          <form className="transfer-form" onSubmit={connect}><TextField label="Cloudflare Worker URL" fullWidth required value={url} onChange={e => setUrl(e.target.value)} />
            <div><Button type="submit" variant="contained">Save connection</Button></div></form>
        </section>}
        {!session && base && !editUrl && <section className="panel live-sign-in"><header className="panel-head"><div><h2>Sign in to {bank.name}</h2>
          <p>Use a customer enabled in this bank’s Firebase project.</p></div></header>
          <form className="transfer-form" onSubmit={signIn}>
            <TextField label="Email" type="email" autoComplete="username" required value={email} onChange={event => setEmail(event.target.value)} />
            <TextField label="Password" type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} />
            <div><Button type="submit" variant="contained" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</Button></div>
          </form></section>}
        {session && <>
          {loaded && !data.accounts.length && <Alert severity="info">This Firebase user has no synthetic account in this bank. Attach an account to this Firebase UID.</Alert>}
          {!loaded && <Alert severity="info">Loading your accounts and activity…</Alert>}
          <section id="accounts" className="dashboard-section">
            <div className="section-intro"><div><span className="eyebrow">YOUR MONEY</span><h2>My accounts</h2><p>Available balances across your active accounts</p></div><span className="section-count">{data.accounts.length} {data.accounts.length === 1 ? 'ACCOUNT' : 'ACCOUNTS'}</span></div>
            <div className="accounts">{data.accounts.map((account, i) =>
              <section key={account.accountId} className={'account-card ' + (i === 0 ? 'primary-account' : 'light-account')}>
                <div className="account-head"><span>{account.accountNumber}</span><Landmark size={19} /></div>
                <div className="account-value">{money(account.availableMinor)}</div>
                <div className="account-foot"><span>Available · Held {money(account.heldMinor)}</span><span>{account.accountId}</span></div>
              </section>)}
            </div>
          </section>
          {data.accounts.length > 0 && <div id="send-money" className="dashboard-section">
            <div className="section-intro"><div><span className="eyebrow">MOVE MONEY</span><h2>Transfers</h2><p>Send funds within Finova or to another participating bank</p></div></div>
            <TransferForm bank={bank} accounts={data.accounts} directory={directory} send={send} />
          </div>}
          <div id="activity" className="dashboard-section">
            <div className="section-intro"><div><span className="eyebrow">YOUR RECORDS</span><h2>Recent transactions</h2><p>Track incoming and outgoing transfers</p></div></div>
            <Activity rows={data.transfers} directory={directory} />
          </div>
        </>}
      </main>
    </div>
  </div>;
}
