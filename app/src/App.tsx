import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { AnchorProvider, BN } from '@coral-xyz/anchor';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { getPlanPda, getSubscriptionPda, getProgram} from './lib/program';
import './App.css';
import '@solana/wallet-adapter-react-ui/styles.css';

type PlanInfo = {
  publicKey: string;
  merchant: string;
  planId: number;
  amountLamports: string;
  intervalSecs: string;
  name: string;
  active: boolean;
};

type SubInfo = {
  publicKey: string;
  subscriber: string;
  plan: string;
  amountLamports: string;
  nextBillingAt: string;
  status: number;
};

const LAMPORTS_PER_SOL = 1e9;
const DEVNET_EXPLORER = 'https://explorer.solana.com/tx';
const PLAN_NAMES_KEY = 'sub-eng-plan-names';

function getStoredPlanNames(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(PLAN_NAMES_KEY) || '{}');
  } catch {
    return {};
  }
}

type TabId = 'dashboard' | 'create-plan' | 'plans' | 'subscriptions' | 'cancelled';

function App() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [activeTab, setActiveTab] = useState<TabId>('dashboard');
  const [planId, setPlanId] = useState(1);
  const [planName, setPlanName] = useState('');
  const [amountSol, setAmountSol] = useState('0.01');
  const [intervalDays, setIntervalDays] = useState(30);
  const [selectedPlanKey, setSelectedPlanKey] = useState('');
  const [plans, setPlans] = useState<PlanInfo[]>([]);
  const [subscriptions, setSubscriptions] = useState<SubInfo[]>([]);
  const [txSig, setTxSig] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [, setNamesVersion] = useState(0);

  const savePlanNameLocal = useCallback((planPubkey: string, name: string) => {
    const stored = getStoredPlanNames();
    stored[planPubkey] = name;
    localStorage.setItem(PLAN_NAMES_KEY, JSON.stringify(stored));
    setNamesVersion((v) => v + 1);
  }, []);

  const provider = useMemo(() => {
    if (!wallet.publicKey) return null;
    return new AnchorProvider(connection, wallet as never, { commitment: 'confirmed' });
  }, [connection, wallet]);

  const program = useMemo(() => (provider ? getProgram(provider) : null), [provider]);

  const fetchPlans = useCallback(async () => {
    if (!program) return;
    try {
      const programId = program.programId;
      const planDiscriminator = new Uint8Array([161, 231, 251, 119, 2, 12, 162, 2]); // Plan from IDL
      let accountInfos: { pubkey: PublicKey; account: { data: Buffer } }[] = [];
      try {
        accountInfos = [...await connection.getProgramAccounts(programId, { commitment: 'confirmed' })];
      } catch (_) {
        accountInfos = [];
      }
      const accounts: { publicKey: PublicKey; account: { merchant: PublicKey; planId: number; amountLamports: BN; intervalSecs: BN; name: string; active: boolean } }[] = [];
      const decodePlan60 = (d: Buffer): { merchant: PublicKey; planId: number; amountLamports: BN; intervalSecs: BN; name: string; active: boolean } | null => {
        if (d.length !== 60) return null;
        let o = 8;
        const merchant = new PublicKey(d.slice(o, o + 32)); o += 32;
        const planId = d.readUInt16LE(o); o += 2;
        const amountLamports = new BN(d.slice(o, o + 8), 'le'); o += 8;
        const intervalSecs = new BN(d.slice(o, o + 8), 'le'); o += 8;
        const active = d[o] !== 0;
        return { merchant, planId, amountLamports, intervalSecs, name: '', active };
      };
      const decodePlan128 = (d: Buffer): { merchant: PublicKey; planId: number; amountLamports: BN; intervalSecs: BN; name: string; active: boolean } | null => {
        if (d.length < 8 + 32 + 2 + 8 + 8 + 4 + 1 + 1) return null; // min with empty name
        let o = 8;
        const merchant = new PublicKey(d.slice(o, o + 32)); o += 32;
        const planId = d.readUInt16LE(o); o += 2;
        const amountLamports = new BN(d.slice(o, o + 8), 'le'); o += 8;
        const intervalSecs = new BN(d.slice(o, o + 8), 'le'); o += 8;
        const nameLen = d.readUInt32LE(o); o += 4;
        const name = (nameLen > 0 && o + nameLen <= d.length) ? d.slice(o, o + nameLen).toString('utf8') : ''; o += nameLen;
        if (o + 2 > d.length) return null;
        const active = d[o] !== 0; o += 1;
        return { merchant, planId, amountLamports, intervalSecs, name, active };
      };
      for (const { pubkey, account } of accountInfos) {
        const data = account.data instanceof Buffer ? account.data : Buffer.from(new Uint8Array(account.data));
        if (data.length < 8) continue;
        if (!data.slice(0, 8).every((b: number, i: number) => b === planDiscriminator[i])) continue;
        let d = data.length === 60 ? decodePlan60(data) : data.length >= 120 ? decodePlan128(data) : null;
        if (!d) {
          try {
            d = (program.coder.accounts as { decode: (name: string, data: Buffer) => unknown }).decode('Plan', data) as { merchant: PublicKey; planId: number; amountLamports: BN; intervalSecs: BN; name: string; active: boolean };
          } catch (_) {
            try {
              d = (program.coder.accounts as { decode: (name: string, data: Buffer) => unknown }).decode('plan', data) as { merchant: PublicKey; planId: number; amountLamports: BN; intervalSecs: BN; name: string; active: boolean };
            } catch (_) {
              continue;
            }
          }
        }
        accounts.push({ publicKey: pubkey, account: d });
      }
      setPlans(
        accounts.map((a) => ({
          publicKey: a.publicKey.toBase58(),
          merchant: a.account.merchant.toBase58(),
          planId: a.account.planId,
          amountLamports: a.account.amountLamports.toString(),
          intervalSecs: a.account.intervalSecs.toString(),
          name: a.account.name ?? '',
          active: a.account.active,
        }))
      );
    } catch (e) {
      console.error(e);
      setPlans([]);
    }
  }, [program, connection]);

  const fetchSubscriptions = useCallback(async () => {
    if (!program || !wallet.publicKey) return;
    try {
      const myWalletB58 = wallet.publicKey.toBase58();
      const programId = program.programId;
      const subs: SubInfo[] = [];
      const accountInfos = await connection.getProgramAccounts(programId, {
        filters: [{ dataSize: 107 }],
      });
      for (const { pubkey, account } of accountInfos) {
        try {
          const decoded = (program.coder.accounts as { decode: (name: string, data: Buffer) => unknown }).decode('subscription', account.data);
          const d = decoded as { subscriber: PublicKey; plan: PublicKey; amountLamports: BN; nextBillingAt: BN; status: number };
          if (d.subscriber.toBase58() !== myWalletB58) continue;
          subs.push({
            publicKey: pubkey.toBase58(),
            subscriber: d.subscriber.toBase58(),
            plan: d.plan.toBase58(),
            amountLamports: String(d.amountLamports),
            nextBillingAt: String(d.nextBillingAt),
            status: d.status,
          });
        } catch (_) {
          continue;
        }
      }
      setSubscriptions(subs);
    } catch (e) {
      console.error(e);
      setSubscriptions([]);
    }
  }, [program, wallet.publicKey, connection]);

  useEffect(() => {
    fetchPlans();
    fetchSubscriptions();
  }, [fetchPlans, fetchSubscriptions]);


  const nextPlanId = useMemo(() => {
    const pk = wallet.publicKey;
    if (!pk) return 1;
    const myPlans = plans.filter((p) => p.merchant === pk.toBase58());
    if (myPlans.length === 0) return 1;
    const maxId = Math.max(...myPlans.map((p) => p.planId), 0);
    return maxId + 1;
  }, [plans, wallet.publicKey]);

  useEffect(() => {
    if (activeTab === 'create-plan') setPlanId(nextPlanId);
  }, [activeTab, nextPlanId]);

  const runTx = useCallback(
    async (fn: () => Promise<string>) => {
      setError(null);
      setTxSig(null);
      setLoading(true);
      try {
        const sig = await fn();
        setTxSig(sig);
        await fetchPlans();
        await fetchSubscriptions();
        setTimeout(() => { fetchPlans(); fetchSubscriptions(); }, 5000);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('already in use') || msg.includes('Allocate:')) {
          if (msg.includes('CreatePlan') || msg.includes('Create plan'))
            setError('This Plan ID is already used by you. Use a different Plan ID (e.g. ' + (nextPlanId) + ').');
          else if (msg.includes('CreateSubscription') || msg.includes('Subscribe'))
            setError('You are already subscribed to this plan. Check My Subscriptions.');
          else
            setError('Account already exists. Use a different Plan ID or plan.');
        } else if (msg.includes('PlanStillActive') || msg.includes('Plan must be inactive')) {
          setError('Deactivate the plan first, then close it to reclaim rent.');
        } else {
          setError(msg);
        }
      } finally {
        setLoading(false);
      }
    },
    [fetchPlans, fetchSubscriptions, nextPlanId]
  );

  const createPlan = useCallback(() => {
    if (!program || !wallet.publicKey) return;
    const amountLamports = new BN(Math.floor(parseFloat(amountSol) * LAMPORTS_PER_SOL));
    const intervalSecs = new BN(intervalDays * 24 * 60 * 60);
    const name = (planName || `Plan ${planId}`).slice(0, 64);
    const planPda = getPlanPda(wallet.publicKey, planId);
    const p = program as unknown as { methods: { createPlan: (a: number, b: BN, c: BN, d: string) => { accounts: (acc: object) => { rpc: () => Promise<string> } } } };
    runTx(async () => {
      const sig = await p.methods.createPlan(planId, amountLamports, intervalSecs, name).accounts({ plan: planPda, merchant: wallet.publicKey!, systemProgram: SystemProgram.programId }).rpc();
      const stored = getStoredPlanNames();
      stored[planPda.toBase58()] = name;
      localStorage.setItem(PLAN_NAMES_KEY, JSON.stringify(stored));
      return sig;
    });
  }, [program, wallet.publicKey, planId, planName, amountSol, intervalDays, runTx]);

  const createSubscription = useCallback(() => {
    if (!program || !wallet.publicKey || !selectedPlanKey) return;
    const planPk = new PublicKey(selectedPlanKey);
    const planAccount = plans.find((p) => p.publicKey === selectedPlanKey);
    if (!planAccount) return;
    const subscriptionPda = getSubscriptionPda(wallet.publicKey, planPk);
    const p = program as unknown as { methods: { createSubscription: () => { accounts: (acc: object) => { rpc: () => Promise<string> } } } };
    runTx(() => p.methods.createSubscription().accounts({ subscription: subscriptionPda, subscriber: wallet.publicKey!, plan: planPk, merchant: planAccount.merchant, systemProgram: SystemProgram.programId }).rpc());
  }, [program, wallet.publicKey, selectedPlanKey, plans, runTx]);

  const renewSubscription = useCallback(
    async (sub: SubInfo) => {
      if (!program || !wallet.publicKey) return;
      const planPk = new PublicKey(sub.plan);
      const subPda = getSubscriptionPda(wallet.publicKey, planPk);
      const planAccount = plans.find((p) => p.publicKey === sub.plan);
      if (!planAccount) return;
      const p = program as unknown as { methods: { renew: () => { accounts: (acc: object) => { rpc: () => Promise<string> } } } };
      runTx(() => p.methods.renew().accounts({ subscription: subPda, subscriber: wallet.publicKey!, plan: planPk, merchant: planAccount.merchant, systemProgram: SystemProgram.programId }).rpc());
    },
    [program, wallet.publicKey, plans, runTx]
  );

  const cancelSubscription = useCallback(
    async (sub: SubInfo) => {
      if (!program || !wallet.publicKey) return;
      const planPk = new PublicKey(sub.plan);
      const subPda = getSubscriptionPda(wallet.publicKey, planPk);
      const p = program as unknown as { methods: { cancel: () => { accounts: (acc: object) => { rpc: () => Promise<string> } } } };
      runTx(() => p.methods.cancel().accounts({ subscription: subPda, subscriber: wallet.publicKey!, plan: planPk }).rpc());
    },
    [program, wallet.publicKey, runTx]
  );

  const closePlan = useCallback(
    async (plan: PlanInfo) => {
      if (!program || !wallet.publicKey || plan.merchant !== wallet.publicKey.toBase58()) return;
      const planPda = getPlanPda(wallet.publicKey, plan.planId);
      const p = program as unknown as { methods: { closePlan: (id: number) => { accounts: (acc: object) => { rpc: () => Promise<string> } } } };
      runTx(() => p.methods.closePlan(plan.planId).accounts({ plan: planPda, merchant: wallet.publicKey! }).rpc());
    },
    [program, wallet.publicKey, runTx]
  );

  const closeSubscription = useCallback(
    async (sub: SubInfo) => {
      if (!program || !wallet.publicKey || sub.subscriber !== wallet.publicKey.toBase58() || sub.status !== 1) return;
      const planPk = new PublicKey(sub.plan);
      const subPda = getSubscriptionPda(wallet.publicKey, planPk);
      const p = program as unknown as { methods: { closeSubscription: () => { accounts: (acc: object) => { rpc: () => Promise<string> } } } };
      runTx(() => p.methods.closeSubscription().accounts({ subscription: subPda, subscriber: wallet.publicKey!, plan: planPk }).rpc());
    },
    [program, wallet.publicKey, runTx]
  );

  // ——— Login / Landing ———
  if (!wallet.publicKey) {
    return (
      <div className="login-page">
        <div className="login-card">
          <div className="login-brand">
            <span className="login-logo">◇</span>
            <h1>Subscription Engine</h1>
            <p>On-chain recurring billing on Solana</p>
          </div>
          <div className="login-actions">
            <WalletMultiButton className="btn-connect" />
            <p className="login-hint">Use Devnet. Connect Phantom, Solflare, or any Solana wallet.</p>
          </div>
        </div>
      </div>
    );
  }

  // ——— Dashboard (after login) ———
  const tabs: { id: TabId; label: string }[] = [
    { id: 'dashboard', label: 'Dashboard' },
    { id: 'create-plan', label: 'Create Plan' },
    { id: 'plans', label: 'Browse Plans' },
    { id: 'subscriptions', label: 'My Subscriptions' },
    { id: 'cancelled', label: 'Cancelled' },
  ];

  const activeSubs = subscriptions.filter((s) => s.status === 0);
  const cancelledSubs = subscriptions.filter((s) => s.status === 1);
  const getPlanDisplay = (planPubkey: string) => {
    const stored = getStoredPlanNames()[planPubkey];
    if (stored) return stored;
    const p = plans.find((x) => x.publicKey === planPubkey);
    return p ? (p.name || `Plan ${p.planId}`) : `Plan (${planPubkey.slice(0, 8)}…)`;
  };

  return (
    <div className="app">
      <header className="header">
        <div className="header-left">
          <span className="brand-logo">◇</span>
          <span className="brand-name">Subscription Engine</span>
        </div>
        <div className="header-right">
          <span className="header-devnet">Devnet</span>
          <span className="wallet-addr-wrap" data-full={wallet.publicKey.toBase58()}>
            <span className="wallet-addr">{wallet.publicKey.toBase58().slice(0, 6)}…{wallet.publicKey.toBase58().slice(-6)}</span>
          </span>
          <WalletMultiButton className="btn-wallet">{wallet.connected ? 'Connected' : undefined}</WalletMultiButton>
        </div>
      </header>

      {error && (
        <div className="banner error">
          {error}
        </div>
      )}
      {txSig && (
        <div className="banner success">
          <a href={`${DEVNET_EXPLORER}/${txSig}?cluster=devnet`} target="_blank" rel="noreferrer">
            View transaction on Explorer →
          </a>
        </div>
      )}

      <nav className="tabs">
        {tabs.map((t) => (
          <button
            key={t.id}
            className={`tab ${activeTab === t.id ? 'active' : ''}`}
            onClick={() => setActiveTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <main className="main">
        {activeTab === 'dashboard' && (
          <div className="dashboard">
            <h2>Dashboard</h2>
            <div className="stats">
              <div className="stat-card">
                <span className="stat-value">{activeSubs.length}</span>
                <span className="stat-label">Active subscriptions</span>
              </div>
              <div className="stat-card">
                <span className="stat-value">{cancelledSubs.length}</span>
                <span className="stat-label">Cancelled</span>
              </div>
              <div className="stat-card">
                <span className="stat-value">{plans.length}</span>
                <span className="stat-label">Plans available</span>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'create-plan' && (
          <div className="panel">
            <h2>Create plan</h2>
            <p className="panel-desc">Create a billing plan as a merchant. Subscribers will pay this amount each interval.</p>
            <div className="form">
              <label>Plan name (e.g. Pro Monthly)</label>
              <input
                type="text"
                value={planName}
                onChange={(e) => setPlanName(e.target.value)}
                placeholder="Pro Monthly"
                maxLength={64}
              />
              <label>Plan ID (suggested: {nextPlanId} — use a new ID for each plan)</label>
              <input
                type="number"
                min={0}
                value={planId}
                onChange={(e) => setPlanId(parseInt(e.target.value, 10) || 0)}
              />
              <label>Amount (SOL)</label>
              <input
                type="text"
                value={amountSol}
                onChange={(e) => setAmountSol(e.target.value)}
                placeholder="0.01"
              />
              <label>Billing interval (days)</label>
              <input
                type="number"
                min={1}
                value={intervalDays}
                onChange={(e) => setIntervalDays(parseInt(e.target.value, 10) || 1)}
              />
              <button className="btn-primary" onClick={createPlan} disabled={loading}>
                {loading ? 'Creating…' : 'Create plan'}
              </button>
            </div>
          </div>
        )}

        {activeTab === 'plans' && (
          <div className="panel">
            <div className="panel-head-row">
              <h2>Browse plans</h2>
              <button type="button" className="btn-small" onClick={() => { fetchPlans(); fetchSubscriptions(); }} title="Refresh list">
                Refresh
              </button>
            </div>
            <p className="panel-desc">Subscribe to a plan. First period is charged when you subscribe. If your new plan doesn’t appear, wait a few seconds or click Refresh.</p>
            <div className="subscribe-form">
              <select
                value={selectedPlanKey}
                onChange={(e) => setSelectedPlanKey(e.target.value)}
              >
                <option value="">Select a plan</option>
                {plans.filter((p) => p.active).map((p) => (
                  <option key={p.publicKey} value={p.publicKey}>
                    {getPlanDisplay(p.publicKey)} — {Number(p.amountLamports) / LAMPORTS_PER_SOL} SOL every {Number(p.intervalSecs) / 86400} days
                  </option>
                ))}
              </select>
              <button className="btn-primary" onClick={createSubscription} disabled={loading || !selectedPlanKey}>
                {loading ? '…' : 'Subscribe'}
              </button>
            </div>
            <ul className="plan-list">
              {plans.map((p) => (
                <li key={p.publicKey} className="plan-item">
                  <div>
                    <strong
                      className="plan-name-editable"
                      title="Double-click to set name"
                      onDoubleClick={() => {
                        const n = prompt('Plan name', getPlanDisplay(p.publicKey));
                        if (n != null && n.trim()) savePlanNameLocal(p.publicKey, n.trim().slice(0, 64));
                      }}
                    >
                      {getPlanDisplay(p.publicKey)}
                    </strong>
                    <span> · {(Number(p.amountLamports) / LAMPORTS_PER_SOL).toFixed(4)} SOL every {Number(p.intervalSecs) / 86400} days</span>
                  </div>
                  <div className="plan-item-actions">
                    {p.merchant === wallet.publicKey?.toBase58() && !p.active && (
                      <button type="button" className="btn-small danger" onClick={() => closePlan(p)} disabled={loading}>Close</button>
                    )}
                    <span className={`badge ${p.active ? 'badge-active' : 'badge-inactive'}`}>
                      {p.active ? 'Active' : 'Inactive'}
                    </span>
                  </div>
                </li>
              ))}
              {plans.length === 0 && <li className="plan-item empty">No plans yet. Create one from the Create Plan tab.</li>}
            </ul>
          </div>
        )}

        {activeTab === 'subscriptions' && (
          <div className="panel">
            <div className="panel-head-row">
              <h2>My subscriptions</h2>
              <button type="button" className="btn-small" onClick={() => { fetchSubscriptions(); fetchPlans(); }} title="Refresh list">
                Refresh
              </button>
            </div>
            <ul className="sub-list">
              {activeSubs.map((s) => (
                <li key={s.publicKey} className="sub-item">
                  <div className="sub-info">
                    <span
                      className="sub-plan-name plan-name-editable"
                      title="Double-click to set plan name"
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        const n = prompt('Plan name', getPlanDisplay(s.plan));
                        if (n != null && n.trim()) {
                          savePlanNameLocal(s.plan, n.trim().slice(0, 64));
                        }
                      }}
                    >
                      <strong>{getPlanDisplay(s.plan)}</strong>
                    </span>
                    <span className="sub-amount">{(Number(s.amountLamports) / LAMPORTS_PER_SOL).toFixed(4)} SOL</span>
                    <span className="sub-next">Next billing: {new Date(Number(s.nextBillingAt) * 1000).toLocaleString()}</span>
                    <span className="badge badge-active">Active</span>
                  </div>
                  <div className="sub-actions">
                    <button className="btn-small" onClick={() => renewSubscription(s)} disabled={loading}>Renew</button>
                    <button className="btn-small danger" onClick={() => cancelSubscription(s)} disabled={loading}>Cancel</button>
                  </div>
                </li>
              ))}
              {activeSubs.length === 0 && <li className="sub-item empty">No active subscriptions. Subscribe from Browse Plans.</li>}
            </ul>
          </div>
        )}

        {activeTab === 'cancelled' && (
          <div className="panel">
            <div className="panel-head-row">
              <h2>Cancelled subscriptions</h2>
              <button type="button" className="btn-small" onClick={() => { fetchSubscriptions(); fetchPlans(); }} title="Refresh list">
                Refresh
              </button>
            </div>
            <ul className="sub-list">
              {cancelledSubs.map((s) => (
                <li key={s.publicKey} className="sub-item">
                  <div className="sub-info">
                    <span
                      className="sub-plan-name plan-name-editable"
                      title="Double-click to set plan name"
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        const n = prompt('Plan name', getPlanDisplay(s.plan));
                        if (n != null && n.trim()) {
                          savePlanNameLocal(s.plan, n.trim().slice(0, 64));
                        }
                      }}
                    >
                      <strong>{getPlanDisplay(s.plan)}</strong>
                    </span>
                    <span className="sub-amount">{(Number(s.amountLamports) / LAMPORTS_PER_SOL).toFixed(4)} SOL</span>
                    <span className="sub-next">Period end: {new Date(Number(s.nextBillingAt) * 1000).toLocaleString()}</span>
                    <span className="badge badge-inactive">Cancelled</span>
                  </div>
                  <div className="sub-actions">
                    <button type="button" className="btn-small" onClick={() => closeSubscription(s)} disabled={loading}>Close</button>
                  </div>
                </li>
              ))}
              {cancelledSubs.length === 0 && <li className="sub-item empty">No cancelled subscriptions.</li>}
            </ul>
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
