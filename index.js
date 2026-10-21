const functions = require("firebase-functions");
const admin = require("firebase-admin");
admin.initializeApp();

const db = admin.database();
const INITIAL_PRICE = 500;
const MIN_DEPOSIT = 5000;

function assertAdmin(context) {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Login diperlukan.");
  return db.ref(`admins/${context.auth.uid}`).get().then(s => {
    if (!s.exists() || s.val() !== true) throw new functions.https.HttpsError("permission-denied", "Bukan administrator.");
  });
}
function now(){ return Date.now(); }

// =========== EXECUTE TRADE ===========
exports.executeTrade = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Login diperlukan.");
  const uid = context.auth.uid;
  const { side, rupiahAmount, cazoQuantity, idempotencyKey } = data || {};

  if (!idempotencyKey || typeof idempotencyKey !== "string")
    throw new functions.https.HttpsError("invalid-argument", "idempotencyKey wajib.");
  if (side !== "buy" && side !== "sell")
    throw new functions.https.HttpsError("invalid-argument", "side tidak valid.");

  const idemRef = db.ref(`idempotency/${uid}/${idempotencyKey}`);
  const existing = await idemRef.get();
  if (existing.exists()) return existing.val();

  const marketSnap = await db.ref("market/cazo").get();
  const market = marketSnap.val() || {};
  const unitPrice = Number(market.price) || INITIAL_PRICE;
  const settings = market.settings || {};
  const feePct = Number(settings.feePct) || 0;
  const maxChangePct = Number(settings.maxChangePct) || 5;

  // Validasi
  let amount, quantity;
  if (side === "buy") {
    amount = Number(rupiahAmount);
    if (!Number.isFinite(amount) || amount < 1000)
      throw new functions.https.HttpsError("invalid-argument", "Nominal minimal Rp1.000.");
    const fee = amount * feePct / 100;
    quantity = (amount - fee) / unitPrice;
    if (quantity <= 0) throw new functions.https.HttpsError("invalid-argument", "Nominal terlalu kecil.");
  } else {
    quantity = Number(cazoQuantity);
    if (!Number.isFinite(quantity) || quantity <= 0)
      throw new functions.https.HttpsError("invalid-argument", "Jumlah CAZO tidak valid.");
    amount = quantity * unitPrice;
  }

  const walletRef = db.ref(`wallets/${uid}`);
  const marketRef = db.ref("market/cazo");
  const txId = db.ref("transactions").push().key;
  const pubTxId = db.ref("publicTransactions").push().key;

  const result = await db.ref().transaction(async () => {
    const walletSnap = await walletRef.get();
    const wallet = walletSnap.val() || { rupiahBalance: 0, cazoBalance: 0 };
    let newRupiah, newCazo;

    if (side === "buy") {
      newRupiah = Number(wallet.rupiahBalance || 0) - amount;
      newCazo = Number(wallet.cazoBalance || 0) + quantity;
      if (newRupiah < 0) throw new functions.https.HttpsError("failed-precondition", "Saldo rupiah tidak cukup.");
    } else {
      if (quantity > Number(wallet.cazoBalance || 0))
        throw new functions.https.HttpsError("failed-precondition", "CAZO tidak cukup.");
      const fee = amount * feePct / 100;
      newRupiah = Number(wallet.rupiahBalance || 0) + (amount - fee);
      newCazo = Number(wallet.cazoBalance || 0) - quantity;
    }

    // Mekanisme harga CAZO:
    // - Tekanan beli > jual -> harga TURUN (delta negatif)
    // - Tekanan jual > beli -> harga NAIK (delta positif)
    // - Seimbang -> stabil
    const oldBuyVol = Number(market.buyVolume || 0);
    const oldSellVol = Number(market.sellVolume || 0);
    const newBuyVol = oldBuyVol + (side === "buy" ? amount : 0);
    const newSellVol = oldSellVol + (side === "sell" ? amount : 0);
    const totalVol = newBuyVol + newSellVol || 1;
    const buyPressure = newBuyVol / totalVol;
    const sellPressure = newSellVol / totalVol;
    let deltaPct = (sellPressure - buyPressure) * 2;
    deltaPct = Math.max(-maxChangePct, Math.min(maxChangePct, deltaPct));
    let newPrice = unitPrice * (1 + deltaPct / 100);
    if (newPrice <= 0) newPrice = 1;

    const t = now();
    const tx = {
      uid, type: side, amount, unitPrice, quantity,
      fee: amount * feePct / 100, status: "success",
      reference: txId, createdAt: t
    };

    await walletRef.update({ rupiahBalance: newRupiah, cazoBalance: newCazo });
    await marketRef.update({
      price: newPrice, lastUpdated: t,
      buyVolume: newBuyVol, sellVolume: newSellVol,
      totalTransactions: Number(market.totalTransactions || 0) + 1
    });
    await db.ref(`transactions/${txId}`).set(tx);
    await db.ref(`publicTransactions/${pubTxId}`).set({
      type: side, amount, unitPrice, quantity, createdAt: t
    });

    return { ok: true, txId, unitPrice, quantity, newPrice, deltaPct };
  });

  await idemRef.set(result);
  return result;
});

// =========== CREATE DEPOSIT ===========
exports.createDepositRequest = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Login diperlukan.");
  const uid = context.auth.uid;
  const { amount, idempotencyKey } = data || {};
  if (!idempotencyKey) throw new functions.https.HttpsError("invalid-argument", "idempotencyKey wajib.");

  const idemRef = db.ref(`idempotency/${uid}/dep-${idempotencyKey}`);
  const existing = await idemRef.get();
  if (existing.exists()) return existing.val();

  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt < MIN_DEPOSIT)
    throw new functions.https.HttpsError("invalid-argument", `Minimal deposit Rp${MIN_DEPOSIT.toLocaleString("id-ID")}.`);

  const ref_ = `CAZO-${Date.now()}-${Math.random().toString(36).slice(2,8).toUpperCase()}`;
  const depRef = db.ref("deposits").push();
  await depRef.set({
    uid, amount: amt, reference: ref_, proofURL: "",
    status: "pending", createdAt: now(),
    reviewedAt: null, reviewedBy: null
  });

  const res = { ok: true, depositId: depRef.key, reference: ref_, status: "pending" };
  await idemRef.set(res);
  return res;
});

// =========== ADMIN REVIEW DEPOSIT ===========
exports.adminReviewDeposit = functions.https.onCall(async (data, context) => {
  await assertAdmin(context);
  const adminUid = context.auth.uid;
  const { depositId, decision, reason } = data || {};
  if (!depositId || !["approve","reject"].includes(decision))
    throw new functions.https.HttpsError("invalid-argument", "Parameter tidak valid.");

  const result = await db.ref().transaction(async () => {
    const depRef = db.ref(`deposits/${depositId}`);
    const snap = await depRef.get();
    if (!snap.exists()) return { ok: false, error: "Deposit tidak ditemukan." };
    const d = snap.val();
    if (d.status !== "pending" && d.status !== "waiting_verification")
      return { ok: false, error: "Deposit sudah diproses sebelumnya." };

    const t = now();
    if (decision === "approve") {
      const walletRef = db.ref(`wallets/${d.uid}`);
      const wSnap = await walletRef.get();
      const w = wSnap.val() || { rupiahBalance: 0, cazoBalance: 0 };
      await walletRef.update({ rupiahBalance: Number(w.rupiahBalance || 0) + Number(d.amount) });
      await depRef.update({ status: "approved", reviewedAt: t, reviewedBy: adminUid });
    } else {
      await depRef.update({ status: "rejected", reviewedAt: t, reviewedBy: adminUid, rejectReason: reason || "" });
    }
    return { ok: true, status: decision === "approve" ? "approved" : "rejected" };
  });

  await db.ref("adminLogs").push().set({
    adminUid, action: `deposit_${decision}`, targetId: depositId, createdAt: now()
  });
  return result;
});

// =========== ADMIN UPDATE MARKET SETTINGS ===========
exports.adminUpdateMarketSettings = functions.https.onCall(async (data, context) => {
  await assertAdmin(context);
  const { maxChangePct, feePct } = data || {};
  if (!Number.isFinite(maxChangePct) || maxChangePct < 0 || maxChangePct > 100)
    throw new functions.https.HttpsError("invalid-argument", "maxChangePct tidak valid.");
  if (!Number.isFinite(feePct) || feePct < 0 || feePct > 10)
    throw new functions.https.HttpsError("invalid-argument", "feePct tidak valid.");

  await db.ref("market/cazo/settings").update({ maxChangePct, feePct });
  await db.ref("adminLogs").push().set({
    adminUid: context.auth.uid, action: "update_market_settings",
    targetId: "market/cazo/settings", createdAt: now()
  });
  return { ok: true };
});

// =========== ADMIN CLAIM (one-time) ===========
exports.setAdminClaim = functions.https.onRequest(async (req, res) => {
  const secret = req.headers["x-admin-secret"];
  if (secret !== functions.config().admin?.secret) {
    res.status(403).send("Forbidden"); return;
  }
  const { uid } = req.body;
  if (!uid) { res.status(400).send("uid required"); return; }
  await admin.auth().setCustomUserClaims(uid, { admin: true });
  await db.ref(`admins/${uid}`).set(true);
  res.json({ ok: true, uid });
});
