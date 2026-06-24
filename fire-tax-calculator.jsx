import { useState, useMemo } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer } from "recharts";

// ═══════════════════════════════════════════════════════════
// 2026 FEDERAL TAX CONSTANTS (Verified)
// ═══════════════════════════════════════════════════════════
const STD_DED = { single: 16100, mfj: 32200, hoh: 24150 };
const SENIOR_DED = { single: 2050, hoh: 2050, mfj: 1650 }; // per person
const OBBBA_AMT = 6000; // per qualifying person 65+, 2025-2028
const OBBBA_PHASEOUT = { single: 75000, mfj: 150000, hoh: 75000 };
const CG_0_CEIL = { single: 49450, mfj: 98900, hoh: 66250 };
const CG_15_CEIL = { single: 492300, mfj: 553850, hoh: 523050 };
const BRACKETS = {
  single: [[0.10, 12400], [0.12, 47550], [0.22, 103350], [0.24, 197300], [0.32, 252525], [0.35, 629900], [0.37, Infinity]],
  mfj: [[0.10, 24800], [0.12, 95100], [0.22, 206700], [0.24, 394600], [0.32, 505050], [0.35, 755300], [0.37, Infinity]],
  hoh: [[0.10, 17600], [0.12, 64150], [0.22, 103350], [0.24, 197300], [0.32, 252525], [0.35, 629900], [0.37, Infinity]],
};
const FICA_RATE = 0.0765;
const SS_THRESH = { single: [25000, 34000], mfj: [32000, 44000], hoh: [25000, 34000] };
const NIIT_THRESH = { single: 200000, mfj: 250000, hoh: 200000 };
const NIIT_RATE = 0.038;
const IRMAA_THRESH = { single: 106000, mfj: 212000, hoh: 106000 };
const IRMAA_TIER1 = 1148; // annual per person
const ACA_400FPL = { 1: 62600, 2: 81760, 3: 104880, 4: 128600 };
const ACA_EST_LOW = 6000;
const ACA_EST_HIGH = 15000;

// ═══════════════════════════════════════════════════════════
// TAX MATH
// ═══════════════════════════════════════════════════════════
function calcOrdinaryTax(taxableOrd, status) {
  if (taxableOrd <= 0) return 0;
  let tax = 0, prev = 0;
  for (const [rate, ceiling] of BRACKETS[status]) {
    if (taxableOrd <= prev) break;
    tax += (Math.min(taxableOrd, ceiling) - prev) * rate;
    prev = ceiling;
  }
  return tax;
}

function calcCapGainsTax(gains, taxableOrd, status) {
  if (gains <= 0) return 0;
  let tax = 0, remaining = gains;
  const room0 = Math.max(0, CG_0_CEIL[status] - taxableOrd);
  remaining -= Math.min(remaining, room0);
  const room15 = Math.max(0, CG_15_CEIL[status] - Math.max(taxableOrd, CG_0_CEIL[status]));
  const at15 = Math.min(remaining, room15);
  tax += at15 * 0.15;
  remaining -= at15;
  tax += remaining * 0.20;
  return tax;
}

function calcTaxableSS(ss, nonSSAgi, status) {
  if (ss <= 0) return 0;
  const combined = nonSSAgi + 0.5 * ss;
  const [t1, t2] = SS_THRESH[status];
  if (combined <= t1) return 0;
  if (combined <= t2) return Math.min(0.5 * ss, 0.5 * (combined - t1));
  const base = Math.min(0.5 * ss, 0.5 * (t2 - t1));
  return Math.min(0.85 * ss, base + 0.85 * (combined - t2));
}

function marginalRate(taxableOrd, status) {
  if (taxableOrd <= 0) return 0;
  for (const [rate, ceiling] of BRACKETS[status]) {
    if (taxableOrd <= ceiling) return rate;
  }
  return 0.37;
}

function runScenario(w2, inc, status, seniors, hhSize) {
  const nonSSAgi = w2 + inc.capGains + inc.qualDivs + inc.rothConv + inc.otherOrd;
  const taxSS = calcTaxableSS(inc.socialSec, nonSSAgi, status);
  const agi = nonSSAgi + taxSS;

  // Deductions
  let deductions = STD_DED[status];
  if (seniors > 0) {
    deductions += seniors * (status === "mfj" ? SENIOR_DED.mfj : (SENIOR_DED[status] || SENIOR_DED.single));
  }
  let obbbaDed = 0;
  if (seniors > 0 && agi <= OBBBA_PHASEOUT[status]) {
    obbbaDed = seniors * OBBBA_AMT;
    deductions += obbbaDed;
  }

  // Split ordinary vs capital gains
  const grossOrdinary = w2 + inc.rothConv + inc.otherOrd + taxSS;
  const grossGains = inc.capGains + inc.qualDivs;

  // Apply deductions to ordinary first, overflow to gains
  const taxableOrd = Math.max(0, grossOrdinary - deductions);
  const unusedDed = Math.max(0, deductions - grossOrdinary);
  const taxableGains = Math.max(0, grossGains - unusedDed);

  // Compute taxes
  const ordTax = calcOrdinaryTax(taxableOrd, status);
  const gainsTax = calcCapGainsTax(taxableGains, taxableOrd, status);
  const ficaTax = w2 * FICA_RATE;
  const niitExcess = Math.max(0, agi - NIIT_THRESH[status]);
  const niitTax = NIIT_RATE * Math.min(grossGains, niitExcess);

  const acaLimit = ACA_400FPL[hhSize] || ACA_400FPL[1];
  return {
    agi, taxSS, taxableOrd, taxableGains, deductions, obbbaDed,
    ordTax, gainsTax, ficaTax, niitTax,
    totalTax: ordTax + gainsTax + ficaTax + niitTax,
    acaEligible: seniors === 0 && agi <= acaLimit,
    irmaaTriggered: seniors > 0 && agi > IRMAA_THRESH[status],
    marginal: marginalRate(taxableOrd, status),
    grossOrdinary, grossGains,
  };
}

// ═══════════════════════════════════════════════════════════
// FORMATTING
// ═══════════════════════════════════════════════════════════
const fmtDollar = (n) => "$" + Math.round(Math.abs(n)).toLocaleString("en-US");
const fmtK = (n) => {
  if (n === 0) return "$0";
  if (n >= 1000) return `$${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return `$${Math.round(n)}`;
};

// ═══════════════════════════════════════════════════════════
// UI COMPONENTS
// ═══════════════════════════════════════════════════════════
function CurrencyInput({ label, value, onChange, hint }) {
  return (
    <div className="flex flex-col gap-0.5">
      <label className="text-sm font-medium text-gray-600">{label}</label>
      <div className="relative">
        <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 text-sm">$</span>
        <input
          type="text"
          inputMode="numeric"
          className="w-full pl-6 pr-3 py-2 border border-gray-300 rounded-lg text-right text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent"
          placeholder="0"
          value={value === "" || value === "0" ? "" : Number(value).toLocaleString("en-US")}
          onChange={(e) => {
            const raw = e.target.value.replace(/[^0-9]/g, "");
            onChange(raw === "" ? "0" : raw);
          }}
        />
      </div>
      {hint && <span className="text-xs text-gray-400 leading-tight">{hint}</span>}
    </div>
  );
}

function Pill({ label, active, onClick }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
        active
          ? "bg-blue-600 text-white"
          : "bg-gray-100 text-gray-600 hover:bg-gray-200"
      }`}
    >
      {label}
    </button>
  );
}

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: "white", padding: "8px 12px", borderRadius: 8, boxShadow: "0 2px 8px rgba(0,0,0,0.15)", border: "1px solid #e5e7eb", fontSize: 12 }}>
      <p style={{ fontWeight: 600, color: "#374151", marginBottom: 4 }}>{label}</p>
      {payload.map((entry, i) => (
        <p key={i} style={{ color: entry.color, margin: 0 }}>
          {entry.name}: {fmtDollar(entry.value)}
        </p>
      ))}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// ADVANTAGE STATUS (compact)
// ═══════════════════════════════════════════════════════════
const ADVANTAGES_META = [
  { id: 1, title: "Standard Deduction Shelter", check: () => true },
  { id: 2, title: "0% Capital Gains Bracket", check: (inc) => (inc.capGains + inc.qualDivs) > 0 },
  { id: 3, title: "Qualified Dividends at 0%", check: (inc) => inc.qualDivs > 0 },
  { id: 4, title: "No FICA / Payroll Tax", check: (inc) => inc.w2 > 0 },
  { id: 5, title: "Roth Conversion Ladder", check: (inc) => inc.rothConv > 0 },
  { id: 6, title: "ACA Premium Tax Credits", check: (_, seniors) => seniors === 0 },
  { id: 7, title: "SS Taxation Reduced", check: (inc) => inc.socialSec > 0 },
  { id: 8, title: "No Net Investment Income Tax", check: (_, __, withW2, withoutW2, status) => withW2.niitTax > 0 || withoutW2.niitTax > 0 || withW2.agi > NIIT_THRESH[status] * 0.8 },
  { id: 9, title: "OBBBA Senior Bonus Deduction", check: (_, seniors) => seniors > 0 },
  { id: 10, title: "Additional Senior Std Deduction", check: (_, seniors) => seniors > 0 },
  { id: 11, title: "Roth Withdrawal Invisibility", check: (inc) => inc.rothWd > 0 },
  { id: 12, title: "IRMAA Avoidance", check: (_, seniors) => seniors > 0 },
];

// ═══════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════
export default function FIRETaxCalculator() {
  const [status, setStatus] = useState("single");
  const [ageGroup, setAgeGroup] = useState("under65");
  const [hhSize, setHhSize] = useState(1);
  const [inputs, setInputs] = useState({
    w2: "0", capGains: "0", qualDivs: "0", rothConv: "0",
    socialSec: "0", rothWd: "0", otherOrd: "0",
  });

  const set = (field) => (val) => setInputs((p) => ({ ...p, [field]: val }));

  const inc = useMemo(() => ({
    w2: parseInt(inputs.w2) || 0,
    capGains: parseInt(inputs.capGains) || 0,
    qualDivs: parseInt(inputs.qualDivs) || 0,
    rothConv: parseInt(inputs.rothConv) || 0,
    socialSec: parseInt(inputs.socialSec) || 0,
    rothWd: parseInt(inputs.rothWd) || 0,
    otherOrd: parseInt(inputs.otherOrd) || 0,
  }), [inputs]);

  const seniors = ageGroup === "both65" ? 2 : ageGroup === "one65" || ageGroup === "65plus" ? 1 : 0;

  const handleStatus = (s) => {
    setStatus(s);
    if (s === "mfj") {
      setHhSize(2);
      if (ageGroup === "65plus") setAgeGroup("one65");
    } else {
      if (ageGroup === "one65" || ageGroup === "both65") setAgeGroup("65plus");
    }
  };

  const withW2 = useMemo(() => runScenario(inc.w2, inc, status, seniors, hhSize), [inc, status, seniors, hhSize]);
  const withoutW2 = useMemo(() => runScenario(0, inc, status, seniors, hhSize), [inc, status, seniors, hhSize]);

  // Savings
  const ficaSavings = withW2.ficaTax;
  const incomeTaxSavings = withW2.ordTax - withoutW2.ordTax;
  const gainsTaxSavings = withW2.gainsTax - withoutW2.gainsTax;
  const niitSavings = withW2.niitTax - withoutW2.niitTax;
  const acaCrossed = seniors === 0 && withW2.agi > (ACA_400FPL[hhSize] || ACA_400FPL[1]) && withoutW2.acaEligible;
  const acaMidpoint = acaCrossed ? (ACA_EST_LOW + ACA_EST_HIGH) / 2 : 0;
  const irmaaCrossed = seniors > 0 && withW2.irmaaTriggered && !withoutW2.irmaaTriggered;
  const irmaaSavings = irmaaCrossed ? seniors * IRMAA_TIER1 : 0;
  const directSavings = ficaSavings + incomeTaxSavings + gainsTaxSavings + niitSavings;
  const estimatedExtras = acaMidpoint + irmaaSavings;
  const totalSavings = directSavings + estimatedExtras;

  const hasW2 = inc.w2 > 0;
  const hasAnyIncome = Object.values(inc).some(v => v > 0);

  // Chart data: tax comparison
  const comparisonData = useMemo(() => {
    const items = [
      { name: "Income Tax", withW2: Math.round(withW2.ordTax), withoutW2: Math.round(withoutW2.ordTax) },
      { name: "Cap Gains", withW2: Math.round(withW2.gainsTax), withoutW2: Math.round(withoutW2.gainsTax) },
      { name: "FICA", withW2: Math.round(withW2.ficaTax), withoutW2: 0 },
      { name: "NIIT", withW2: Math.round(withW2.niitTax), withoutW2: Math.round(withoutW2.niitTax) },
    ];
    return items.filter(d => d.withW2 > 0 || d.withoutW2 > 0);
  }, [withW2, withoutW2]);

  // Chart data: savings breakdown (horizontal)
  const savingsData = useMemo(() => {
    return [
      { name: "FICA", value: Math.round(ficaSavings) },
      { name: "Income Tax", value: Math.round(incomeTaxSavings) },
      { name: "Cap Gains Tax", value: Math.round(gainsTaxSavings) },
      { name: "NIIT", value: Math.round(niitSavings) },
      { name: "ACA Premiums", value: Math.round(acaMidpoint), estimated: true },
      { name: "IRMAA", value: Math.round(irmaaSavings), estimated: true },
    ].filter(d => d.value > 0)
     .sort((a, b) => b.value - a.value);
  }, [ficaSavings, incomeTaxSavings, gainsTaxSavings, niitSavings, acaMidpoint, irmaaSavings]);

  // Chart data: single-scenario tax profile (no W-2 entered)
  const profileData = useMemo(() => {
    const items = [
      { name: "Income Tax", value: Math.round(withoutW2.ordTax) },
      { name: "Cap Gains Tax", value: Math.round(withoutW2.gainsTax) },
      { name: "NIIT", value: Math.round(withoutW2.niitTax) },
    ];
    return items.filter(d => d.value > 0);
  }, [withoutW2]);

  // Advantage status
  const advantageStatus = useMemo(() => {
    return ADVANTAGES_META.map(a => ({
      ...a,
      active: a.check(inc, seniors, withW2, withoutW2, status),
    }));
  }, [inc, seniors, withW2, withoutW2, status]);
  const activeCount = advantageStatus.filter(a => a.active).length;

  return (
    <div className="max-w-2xl mx-auto p-4 space-y-6 font-sans">
      {/* Header */}
      <div className="text-center space-y-1">
        <h1 className="text-2xl font-bold text-gray-900">FIRE Tax Advantage Calculator</h1>
        <p className="text-sm text-gray-500">What $0 earned income unlocks · 2026 federal numbers</p>
      </div>

      {/* Inputs */}
      <div className="space-y-5 p-5 bg-gray-50 rounded-2xl">
        <div className="space-y-2">
          <label className="text-sm font-semibold text-gray-700">Filing Status</label>
          <div className="flex flex-wrap gap-2">
            <Pill label="Single" active={status === "single"} onClick={() => handleStatus("single")} />
            <Pill label="Married Filing Jointly" active={status === "mfj"} onClick={() => handleStatus("mfj")} />
            <Pill label="Head of Household" active={status === "hoh"} onClick={() => handleStatus("hoh")} />
          </div>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-semibold text-gray-700">Age</label>
          <div className="flex flex-wrap gap-2">
            {status === "mfj" ? (
              <>
                <Pill label="Both under 65" active={ageGroup === "under65"} onClick={() => setAgeGroup("under65")} />
                <Pill label="One spouse 65+" active={ageGroup === "one65"} onClick={() => setAgeGroup("one65")} />
                <Pill label="Both 65+" active={ageGroup === "both65"} onClick={() => setAgeGroup("both65")} />
              </>
            ) : (
              <>
                <Pill label="Under 65" active={ageGroup === "under65"} onClick={() => setAgeGroup("under65")} />
                <Pill label="65 or older" active={ageGroup === "65plus"} onClick={() => setAgeGroup("65plus")} />
              </>
            )}
          </div>
        </div>

        {seniors === 0 && (
          <div className="space-y-2">
            <label className="text-sm font-semibold text-gray-700">Household Size <span className="font-normal text-gray-400">(for ACA subsidy cliff)</span></label>
            <div className="flex gap-2">
              {[1, 2, 3, 4].map(n => (
                <Pill key={n} label={String(n)} active={hhSize === n} onClick={() => setHhSize(n)} />
              ))}
            </div>
          </div>
        )}

        <div className="space-y-1">
          <label className="text-sm font-semibold text-gray-700">Your Income</label>
          <p className="text-xs text-gray-400 mb-3">
            Enter your current W-2 salary plus other income sources. The calculator compares "with paycheck" vs "without."
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <CurrencyInput label="Current W-2 Salary" value={inputs.w2} onChange={set("w2")} hint="Annual gross. Enter $0 if already FIRE'd." />
            <CurrencyInput label="Long-Term Capital Gains" value={inputs.capGains} onChange={set("capGains")} hint="Expected annual realized gains" />
            <CurrencyInput label="Qualified Dividends" value={inputs.qualDivs} onChange={set("qualDivs")} hint="Most U.S. stock dividends held >60 days" />
            <CurrencyInput label="Roth Conversions (planned)" value={inputs.rothConv} onChange={set("rothConv")} hint="Traditional → Roth conversion amount" />
            <CurrencyInput label="Social Security Benefits" value={inputs.socialSec} onChange={set("socialSec")} hint="Annual benefit, if receiving" />
            <CurrencyInput label="Roth Withdrawals" value={inputs.rothWd} onChange={set("rothWd")} hint="Tax-free and invisible to means tests" />
            <CurrencyInput label="Other Ordinary Income" value={inputs.otherOrd} onChange={set("otherOrd")} hint="Rental, freelance, interest, etc." />
          </div>
        </div>
      </div>

      {/* Prompt to enter income */}
      {!hasAnyIncome && (
        <div className="p-5 rounded-2xl bg-blue-50 border border-blue-100 text-center space-y-2">
          <p className="text-sm text-blue-700 font-medium">Enter your income above to see your tax visualization</p>
          <p className="text-xs text-blue-400">Start with your W-2 salary + one other source to see the comparison.</p>
        </div>
      )}

      {/* ══════════ WITH W-2: Full comparison ══════════ */}
      {hasW2 && (
        <>
          {/* Total savings hero */}
          <div className="p-5 rounded-2xl bg-gradient-to-br from-blue-50 to-emerald-50 border border-blue-100 text-center space-y-1">
            <p className="text-sm text-gray-500 font-medium">Dropping your W-2 saves an estimated</p>
            <p className="text-4xl font-bold text-emerald-700">
              {fmtDollar(totalSavings)}<span className="text-lg font-normal text-gray-400">/year</span>
            </p>
            {estimatedExtras > 0 && (
              <p className="text-xs text-gray-400">Includes ~{fmtDollar(estimatedExtras)} in estimated ACA/IRMAA savings</p>
            )}
          </div>

          {/* Grouped bar chart: With vs Without W-2 */}
          {comparisonData.length > 0 && (
            <div className="p-5 rounded-2xl bg-white border border-gray-200">
              <h2 className="text-sm font-bold text-gray-700 mb-1">Tax Burden Comparison</h2>
              <p className="text-xs text-gray-400 mb-4">Each tax type: with your salary vs without</p>
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={comparisonData} margin={{ top: 5, right: 10, bottom: 5, left: 10 }} barGap={4}>
                  <XAxis dataKey="name" tick={{ fontSize: 11, fill: "#6b7280" }} axisLine={false} tickLine={false} />
                  <YAxis tickFormatter={fmtK} tick={{ fontSize: 11, fill: "#9ca3af" }} axisLine={false} tickLine={false} width={50} />
                  <Tooltip content={<ChartTooltip />} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="withW2" name="With W-2" fill="#ef4444" radius={[4, 4, 0, 0]} maxBarSize={48} />
                  <Bar dataKey="withoutW2" name="Without W-2" fill="#10b981" radius={[4, 4, 0, 0]} maxBarSize={48} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Savings breakdown: horizontal bars */}
          {savingsData.length > 0 && (
            <div className="p-5 rounded-2xl bg-white border border-gray-200">
              <h2 className="text-sm font-bold text-gray-700 mb-1">Where Your Savings Come From</h2>
              <p className="text-xs text-gray-400 mb-4">
                {savingsData.some(d => d.estimated) ? "Striped bars = estimates" : "Annual tax savings by category"}
              </p>
              <ResponsiveContainer width="100%" height={savingsData.length * 48 + 16}>
                <BarChart data={savingsData} layout="vertical" margin={{ top: 0, right: 10, bottom: 0, left: 0 }}>
                  <XAxis type="number" tickFormatter={fmtK} tick={{ fontSize: 11, fill: "#9ca3af" }} axisLine={false} tickLine={false} />
                  <YAxis type="category" dataKey="name" tick={{ fontSize: 12, fill: "#374151" }} axisLine={false} tickLine={false} width={90} />
                  <Tooltip content={<ChartTooltip />} />
                  <Bar dataKey="value" name="Savings" radius={[0, 4, 4, 0]} maxBarSize={28}>
                    {savingsData.map((entry, i) => (
                      <Cell key={i} fill={entry.estimated ? "#f59e0b" : "#10b981"} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* MAGI comparison */}
          <div className="p-4 rounded-2xl bg-white border border-gray-200">
            <div className="grid grid-cols-2 gap-4 text-center">
              <div>
                <p className="text-[10px] uppercase tracking-wider text-red-500 font-semibold mb-1">With W-2</p>
                <p className="text-xs text-gray-500">MAGI</p>
                <p className="text-lg font-bold text-gray-800">{fmtDollar(withW2.agi)}</p>
                <p className="text-xs text-gray-500 mt-1">Total Tax</p>
                <p className="text-lg font-bold text-red-600">{fmtDollar(withW2.totalTax)}</p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wider text-emerald-500 font-semibold mb-1">Without W-2</p>
                <p className="text-xs text-gray-500">MAGI</p>
                <p className="text-lg font-bold text-gray-800">{fmtDollar(withoutW2.agi)}</p>
                <p className="text-xs text-gray-500 mt-1">Total Tax</p>
                <p className="text-lg font-bold text-emerald-600">{fmtDollar(withoutW2.totalTax)}</p>
              </div>
            </div>
            {inc.rothWd > 0 && (
              <p className="text-xs text-gray-400 mt-3 text-center">
                Your {fmtDollar(inc.rothWd)} in Roth withdrawals provide spending power but don't appear in either MAGI.
              </p>
            )}
          </div>
        </>
      )}

      {/* ══════════ NO W-2: Single scenario ══════════ */}
      {!hasW2 && hasAnyIncome && (
        <>
          <div className="p-5 rounded-2xl bg-gray-50 border border-gray-200 text-center space-y-2">
            <p className="text-sm text-gray-600 font-medium">{activeCount} of 12 advantages are active</p>
            <p className="text-xs text-gray-400">Enter a W-2 salary above to see how much a paycheck would cost in lost tax advantages.</p>
          </div>

          {profileData.length > 0 && (
            <div className="p-5 rounded-2xl bg-white border border-gray-200">
              <h2 className="text-sm font-bold text-gray-700 mb-1">Your Current Tax Profile</h2>
              <p className="text-xs text-gray-400 mb-4">MAGI: {fmtDollar(withoutW2.agi)} · Total tax: {fmtDollar(withoutW2.totalTax)}</p>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={profileData} margin={{ top: 5, right: 10, bottom: 5, left: 10 }}>
                  <XAxis dataKey="name" tick={{ fontSize: 11, fill: "#6b7280" }} axisLine={false} tickLine={false} />
                  <YAxis tickFormatter={fmtK} tick={{ fontSize: 11, fill: "#9ca3af" }} axisLine={false} tickLine={false} width={50} />
                  <Tooltip content={<ChartTooltip />} />
                  <Bar dataKey="value" name="Tax" fill="#10b981" radius={[4, 4, 0, 0]} maxBarSize={56} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </>
      )}

      {/* Advantage status grid */}
      {hasAnyIncome && (
        <div className="p-5 rounded-2xl bg-white border border-gray-200">
          <h2 className="text-sm font-bold text-gray-700 mb-3">12 Tax Advantages</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5">
            {advantageStatus.map(a => (
              <div key={a.id} className="flex items-center gap-2 py-0.5">
                <span className={`text-sm ${a.active ? "text-emerald-500" : "text-gray-300"}`}>
                  {a.active ? "●" : "○"}
                </span>
                <span className={`text-xs ${a.active ? "text-gray-700" : "text-gray-400"}`}>
                  {a.title}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="text-center text-[11px] text-gray-300 space-y-1 pt-2">
        <p>2026 federal estimates only. State taxes, AMT, and phase-outs beyond OBBBA not modeled.</p>
        <p>ACA premium savings are rough estimates — actual values depend on age, state, and plan tier.</p>
        <p>IRMAA uses first-tier surcharge only. Higher tiers add more.</p>
        <p className="pt-1 text-gray-400">Built for Retail Quant · retailquant.substack.com</p>
      </div>
    </div>
  );
}
