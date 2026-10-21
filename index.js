/**
 * CAZO — Backend tepercaya (Firebase Cloud Functions v2, Node 22)
 * Semua perubahan saldo, harga, transaksi, dan persetujuan deposit terjadi DI SINI,
 * bukan di browser. Browser hanya memanggil fungsi ini lewat httpsCallable.
 */
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");

setGlobalOptions({ region: "asia-southeast1", maxInstances: 10 });
admin.initializeApp({ databaseURL: "https://mybro-9ba5f-default-rtdb.firebaseio.com/" });
const db = admin.database();

const DEFAULTS = {
  initialPrice: 500,
  minPrice: 1,
  feePct: 0.5,          // biaya transaksi (%)
  minOrderRp: 1000,
  maxOrderRp: 5000000,
  minDeposit: 5000,
  maxDeposit: 50000000,
  k: 0.05,              // sensitivitas harga terhadap tekanan
  maxChangePct: 2,      // batas perubahan harga per menit (%)
  liquidity: 50000      // penyangga likuiditas (Rp) agar order kecil tidak melonjakkan harga
};

// Bungkus semua fungsi: error tak terduga dicatat di log dan dikirim dengan pesan jelas (bukan sekadar "internal").
function onCallSafe(fn) {
  return onCall(async (req) => {
    try { return await fn(req); }
    catch (e) {
      if (e instanceof HttpsError) throw e;
      console.error("CAZO function error:", e);
      throw new HttpsError("internal", "Kesalahan server: " + (e && e.message ? e.message : String(e)));
    }
  });
}

const INTERVALS = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "1d": 86400 };
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

const round2 = (n) => Math.round(n * 100) / 100;
const floor6 = (n) => Math.floor(n * 1e6 + 1e-9) / 1e6;
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));

function uidOf(req) {
  if (!req.auth || !req.auth.uid) throw new HttpsError("unauthenticated", "Silakan login terlebih dahulu.");
  return req.auth.uid;
}
async function requireAdmin(req) {
  const uid = uidOf(req);
  const s = await db.ref(`admins/${uid}`).get();
  if (s.val() !== true) throw new HttpsError("permission-denied", "Akses administrator ditolak.");
  return uid;
}
async function getSettings() {
  const s = (await db.ref("market/cazo/settings").get()).val() || {};
  return { ...DEFAULTS, ...s };
}
async function getPrice(settings) {
  const st = (await db.ref("market/cazo/state").get()).val();
  return st && st.price ? st.price : settings.initialPrice;
}
async function adminLog(adminUid, action, targetId, meta) {
  await db.ref("adminLogs").push({ adminUid, action, targetId: targetId || null, meta: meta || null, createdAt: Date.now() });
}
function needId(v, name) {
  if (typeof v !== "string" || !ID_RE.test(v)) throw new HttpsError("invalid-argument", `${name} tidak valid.`);
  return v;
}

/**
 * Terapkan perubahan saldo secara atomik & idempoten.
 * Penanda opId disimpan di dalam node wallet yang sama, sehingga
 * pemanggilan ulang dengan opId yang sama tidak menggandakan saldo.
 */
async function applyWallet(uid, opId, dRp, dCazo) {
  let reason = null;
  const res = await db.ref(`wallets/${uid}`).transaction((w) => {
    reason = null;
    w = w || { rupiahBalance: 0, cazoBalance: 0 };
    if (w.applied && w.applied[opId]) { reason = "already"; return; }
    const rp = round2((w.rupiahBalance || 0) + dRp);
    const cz = Math.round(((w.cazoBalance || 0) + dCazo) * 1e6) / 1e6;
    if (rp < 0 || cz < 0) { reason = "insufficient"; return; }
    w.rupiahBalance = rp;
    w.cazoBalance = cz;
    w.applied = Object.assign({}, w.applied, { [opId]: true });
    w.updatedAt = Date.now();
    return w;
  });
  if (res.committed) return "applied";
  return reason || "aborted";
}

async function ensureWallet(uid) {
  await db.ref(`wallets/${uid}`).transaction((w) => w || { rupiahBalance: 0, cazoBalance: 0, updatedAt: Date.now() });
}

/** Perbarui harga & candle dari transaksi beli/jual yang benar-benar berhasil. */
async function applyMarket(side, costRp, qty, settings) {
  const now = Math.floor(Date.now() / 1000);
  const bucket = Math.floor(now / 60) * 60;
  let oldPrice = settings.initialPrice, newPrice = settings.initialPrice;
  await db.ref("market/cazo/state").transaction((s) => {
    s = s || { price: settings.initialPrice, bucketStart: bucket, bucketOpen: settings.initialPrice, buyRp: 0, sellRp: 0 };
    oldPrice = s.price;
    if (s.bucketStart !== bucket) { s.bucketStart = bucket; s.bucketOpen = s.price; s.buyRp = 0; s.sellRp = 0; }
    if (side === "buy") s.buyRp = (s.buyRp || 0) + costRp; else s.sellRp = (s.sellRp || 0) + costRp;
    const total = s.buyRp + s.sellRp;
    const pressure = (s.buyRp - s.sellRp) / (total + settings.liquidity); // -1..1 ; + = tekanan beli
    // ATURAN KHUSUS CAZO: tekanan beli > jual => harga TURUN; jual > beli => NAIK.
    const raw = -settings.k * pressure;
    const lim = settings.maxChangePct / 100;
    const chg = clamp(raw, -lim, lim);
    newPrice = Math.max(settings.minPrice, round2(s.bucketOpen * (1 + chg)));
    s.price = newPrice;
    s.initialPrice = settings.initialPrice;
    s.lastUpdated = Date.now();
    return s;
  });
  for (const [name, secs] of Object.entries(INTERVALS)) {
    const b = name === "1d" ? Math.floor((now + 25200) / 86400) * 86400 - 25200 : Math.floor(now / secs) * secs;
    await db.ref(`market/cazo/candles/${name}/${b}`).transaction((c) => {
      c = c || { o: oldPrice, h: oldPrice, l: oldPrice, c: oldPrice, v: 0, bv: 0, sv: 0, n: 0 };
      c.h = Math.max(c.h, newPrice, oldPrice);
      c.l = Math.min(c.l, newPrice, oldPrice);
      c.c = newPrice;
      c.v = Math.round((c.v + qty) * 1e6) / 1e6;
      if (side === "buy") c.bv = Math.round(((c.bv || 0) + qty) * 1e6) / 1e6;
      else c.sv = Math.round(((c.sv || 0) + qty) * 1e6) / 1e6;
      c.n += 1;
      return c;
    });
  }
}

// ---------------------------------------------------------------- USER
exports.ensureUser = onCallSafe(async (req) => {
  const uid = uidOf(req);
  const t = req.auth.token || {};
  await db.ref(`users/${uid}`).transaction((u) => u || {
    displayName: t.name || null, photoURL: t.picture || null, email: t.email || null, createdAt: Date.now()
  });
  await ensureWallet(uid);
  return { ok: true };
});

exports.trade = onCallSafe(async (req) => {
  const uid = uidOf(req);
  const d = req.data || {};
  const side = d.side;
  if (side !== "buy" && side !== "sell") throw new HttpsError("invalid-argument", "Jenis transaksi tidak valid.");
  const idemKey = needId(d.idemKey, "idemKey");
  const opId = `${side}_${idemKey}`;
  const recRef = db.ref(`transactions/${uid}/${opId}`);
  const settings = await getSettings();

  let rec = (await recRef.get()).val();
  if (!rec) {
    const value = Number(d.value);
    if (!isFinite(value) || value <= 0) throw new HttpsError("invalid-argument", "Nominal tidak valid.");
    const price = await getPrice(settings);
    const f = settings.feePct / 100;
    let qty, cost, fee, total;
    if (side === "buy") {
      if (d.mode === "qty") qty = floor6(value);
      else qty = floor6(value / (1 + f) / price);
      if (qty <= 0) throw new HttpsError("invalid-argument", "Jumlah terlalu kecil.");
      cost = round2(qty * price); fee = round2(cost * f); total = round2(cost + fee);
    } else {
      qty = floor6(value);
      if (qty <= 0) throw new HttpsError("invalid-argument", "Jumlah terlalu kecil.");
      cost = round2(qty * price); fee = round2(cost * f); total = round2(cost - fee);
    }
    if (cost < settings.minOrderRp) throw new HttpsError("invalid-argument", `Minimal order Rp${settings.minOrderRp}.`);
    if (cost > settings.maxOrderRp) throw new HttpsError("invalid-argument", `Maksimal order Rp${settings.maxOrderRp}.`);
    const w = (await db.ref(`wallets/${uid}`).get()).val() || {};
    if (side === "buy" && (w.rupiahBalance || 0) < total) throw new HttpsError("failed-precondition", "Saldo rupiah tidak mencukupi.");
    if (side === "sell" && (w.cazoBalance || 0) < qty) throw new HttpsError("failed-precondition", "Saldo CAZO tidak mencukupi.");
    const candidate = {
      id: opId, uid, type: side, quantity: qty, unitPrice: price, amount: cost, fee, total,
      reference: `ORD-${idemKey.slice(0, 8).toUpperCase()}`, status: "pending", createdAt: Date.now()
    };
    await recRef.transaction((cur) => cur || candidate); // pembuat pertama menentukan angka
    rec = (await recRef.get()).val();
  }
  if (rec.status === "failed") return rec;

  const dRp = side === "buy" ? -rec.total : rec.total;
  const dCz = side === "buy" ? rec.quantity : -rec.quantity;
  const r = await applyWallet(uid, opId, dRp, dCz);
  if (r === "insufficient") {
    await recRef.update({ status: "failed", failReason: "Saldo tidak mencukupi" });
    throw new HttpsError("failed-precondition", "Saldo tidak mencukupi.");
  }
  if (rec.status !== "completed") await recRef.update({ status: "completed", completedAt: Date.now() });

  let flipped = false;
  await recRef.child("marketApplied").transaction((v) => { flipped = !v; return true; });
  if (flipped) {
    await applyMarket(side, rec.amount, rec.quantity, settings);
    await db.ref(`txFeed/${uid}_${opId}`).set({
      uid, type: side, quantity: rec.quantity, unitPrice: rec.unitPrice, amount: rec.amount, fee: rec.fee,
      reference: rec.reference, status: "completed", createdAt: rec.createdAt
    });
  }
  return (await recRef.get()).val();
});

exports.createDeposit = onCallSafe(async (req) => {
  const uid = uidOf(req);
  const idemKey = needId((req.data || {}).idemKey, "idemKey");
  const amount = Math.floor(Number((req.data || {}).amount));
  const s = await getSettings();
  if (!isFinite(amount) || amount < s.minDeposit)
    throw new HttpsError("invalid-argument", `Deposit minimal Rp${s.minDeposit.toLocaleString("id-ID")}. Nominal di bawah minimum tidak dapat dikreditkan, jadi jangan melakukan pembayaran.`);
  if (amount > s.maxDeposit) throw new HttpsError("invalid-argument", `Deposit maksimal Rp${s.maxDeposit.toLocaleString("id-ID")}.`);
  const all = (await db.ref(`deposits/${uid}`).get()).val() || {};
  if (!all[idemKey] && Object.values(all).filter((x) => x.status === "waiting_payment").length >= 5)
    throw new HttpsError("resource-exhausted", "Terlalu banyak deposit yang belum dibayar. Selesaikan atau tunggu dahulu.");
  const reference = "CZ-" + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase();
  const rec = { id: idemKey, uid, amount, reference, status: "waiting_payment", createdAt: Date.now() };
  await db.ref(`deposits/${uid}/${idemKey}`).transaction((cur) => cur || rec);
  return (await db.ref(`deposits/${uid}/${idemKey}`).get()).val();
});

exports.submitProof = onCallSafe(async (req) => {
  const uid = uidOf(req);
  const d = req.data || {};
  const id = needId(d.depositId, "depositId");
  const img = d.imageData;
  if (img != null) {
    if (typeof img !== "string" || !/^data:image\/(jpeg|png);base64,/.test(img) || img.length > 450000)
      throw new HttpsError("invalid-argument", "Gambar bukti tidak valid atau terlalu besar.");
  }
  const ref = db.ref(`deposits/${uid}/${id}`);
  let ok = false;
  await ref.transaction((dep) => {
    ok = false;
    if (!dep || dep.status !== "waiting_payment") return;
    dep.status = "awaiting_verification";
    dep.hasProof = !!img;
    dep.proofSubmittedAt = Date.now();
    ok = true;
    return dep;
  });
  if (!ok) throw new HttpsError("failed-precondition", "Status deposit tidak memungkinkan pengiriman bukti.");
  if (img) await db.ref(`depositProofs/${uid}/${id}`).set({ image: img, createdAt: Date.now() });
  return { ok: true };
});

// ---------------------------------------------------------------- ADMIN
exports.reviewDeposit = onCallSafe(async (req) => {
  const adminUid = await requireAdmin(req);
  const d = req.data || {};
  const uid = String(d.uid || ""), id = needId(d.depositId, "depositId");
  const note = String(d.note || "").slice(0, 300);
  if (!uid) throw new HttpsError("invalid-argument", "UID tidak valid.");
  const ref = db.ref(`deposits/${uid}/${id}`);

  if (d.decision === "reject") {
    let ok = false;
    await ref.transaction((dep) => {
      ok = false;
      if (!dep || (dep.status !== "awaiting_verification" && dep.status !== "waiting_payment")) return;
      dep.status = "rejected"; dep.reviewedAt = Date.now(); dep.reviewedBy = adminUid; dep.note = note;
      ok = true; return dep;
    });
    if (!ok) throw new HttpsError("failed-precondition", "Deposit sudah diproses atau tidak ditemukan.");
    await adminLog(adminUid, "deposit_reject", id, { uid, note });
    return { status: "rejected" };
  }
  if (d.decision !== "approve") throw new HttpsError("invalid-argument", "Keputusan tidak valid.");

  // Klaim: awaiting_verification -> crediting (atau lanjutkan jika sebelumnya terhenti di crediting)
  let claimed = false;
  await ref.transaction((dep) => {
    claimed = false;
    if (!dep) return;
    if (dep.status === "awaiting_verification" || dep.status === "crediting") {
      dep.status = "crediting"; dep.reviewedBy = adminUid; dep.reviewedAt = dep.reviewedAt || Date.now(); dep.note = note;
      claimed = true; return dep;
    }
  });
  if (!claimed) throw new HttpsError("failed-precondition", "Deposit sudah diproses atau belum menunggu verifikasi.");
  const dep = (await ref.get()).val();
  await ensureWallet(uid);
  const r = await applyWallet(uid, `dep_${id}`, dep.amount, 0); // idempoten: tepat satu kali
  await db.ref(`transactions/${uid}/dep_${id}`).set({
    id: `dep_${id}`, uid, type: "deposit", amount: dep.amount, total: dep.amount, quantity: 0, unitPrice: 0,
    reference: dep.reference, status: "completed", createdAt: dep.reviewedAt || Date.now()
  });
  await db.ref(`txFeed/${uid}_dep_${id}`).set({
    uid, type: "deposit", amount: dep.amount, reference: dep.reference, status: "completed", createdAt: Date.now()
  });
  await ref.update({ status: "approved", creditedAt: Date.now() });
  await adminLog(adminUid, "deposit_approve", id, { uid, amount: dep.amount, wallet: r });
  return { status: "approved", wallet: r };
});

exports.updateSettings = onCallSafe(async (req) => {
  const adminUid = await requireAdmin(req);
  const d = req.data || {};
  const rules = {
    feePct: [0, 10], minOrderRp: [1, 1e9], maxOrderRp: [1, 1e10], minDeposit: [1000, 1e9], maxDeposit: [1000, 1e10],
    k: [0, 1], maxChangePct: [0.01, 20], liquidity: [1, 1e12]
  };
  const out = {};
  for (const [key, [a, b]] of Object.entries(rules)) {
    if (d[key] === undefined) continue;
    const v = Number(d[key]);
    if (!isFinite(v) || v < a || v > b) throw new HttpsError("invalid-argument", `Nilai ${key} harus antara ${a} dan ${b}.`);
    out[key] = v;
  }
  await db.ref("market/cazo/settings").update(out);
  await adminLog(adminUid, "settings_update", "market/cazo/settings", out);
  return { ok: true, settings: out };
});

exports.postAnnouncement = onCallSafe(async (req) => {
  const adminUid = await requireAdmin(req);
  const text = String((req.data || {}).text || "").trim().slice(0, 400);
  await db.ref("announcements/latest").set(text ? { text, createdAt: Date.now(), by: adminUid } : null);
  await adminLog(adminUid, text ? "announcement_post" : "announcement_clear", "announcements/latest", { text });
  return { ok: true };
});

exports.initMarket = onCallSafe(async (req) => {
  const adminUid = await requireAdmin(req);
  const cur = await db.ref("market/cazo/state").get();
  if (cur.exists()) throw new HttpsError("already-exists", "Pasar sudah diinisialisasi.");
  const now = Math.floor(Date.now() / 1000);
  await db.ref("market/cazo").update({
    state: { price: DEFAULTS.initialPrice, initialPrice: DEFAULTS.initialPrice, bucketStart: Math.floor(now / 60) * 60, bucketOpen: DEFAULTS.initialPrice, buyRp: 0, sellRp: 0, lastUpdated: Date.now() },
    settings: DEFAULTS
  });
  await adminLog(adminUid, "market_init", "market/cazo", null);
  return { ok: true };
});
