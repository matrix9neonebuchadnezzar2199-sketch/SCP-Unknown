/**
 * SCP-Unknown- core game logic.
 */
const SAVE_KEY = "scp-unknown-save-v1";
/** 緊急展開（巡回速度ブースト）の持続時間 */
const SECTOR_BOOST_MS = 60000;

/** @returns {object} fresh game state */
/** ゲスト用コードネーム。アクセスごとにユニークになるよう UUID から採番 */
function newGuestCodename() {
  const uuid = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`).replace(/-/g, "");
  return `Guest-${uuid.slice(0, 6).toUpperCase()}`;
}

function createNewState() {
  const starters = GAME_DATA.starters.map((cid, i) => {
    const u = createUnit(cid, 1, 0);
    u.uid = i + 1;
    return u;
  });
  return {
    version: GAME_DATA.version,
    acceptedLicense: false,
    stamina: GAME_DATA.staminaMaxBase,
    staminaMax: GAME_DATA.staminaMaxBase,
    staminaUpdatedAt: Date.now(),
    budget: 100,
    siteLevel: 1,
    floor: 1,
    maxFloor: 1,
    mapSite: GAME_DATA.defaultMapSite,
    mapProgress: {},
    units: starters,
    nextUnitId: starters.length + 1,
    squad: starters.map((u) => u.uid),
    chamber: [],
    storage: new Array(GAME_DATA.storageDefaults.slots).fill(null),
    storageSlots: GAME_DATA.storageDefaults.slots,
    partStack: GAME_DATA.storageDefaults.partStack,
    itemStack: GAME_DATA.storageDefaults.itemStack,
    parts: emptyPartsBag(),
    pending: [],
    equipped: {},
    operatorGear: emptyOperatorGear(),
    discovered: [...GAME_DATA.starters],
    battleLog: [],
    lastExplore: null,
    clearKills: 0,
    sectorCleared: false,
    bossActive: false,
    boostUntil: 0,
    breachLosses: 0,
    breachCooldownUntil: 0,
    sentries: [],
    revealedRooms: [],
    limitedRun: null,
    ospreyAtHq: false,
    siteNodes: ["n_start"],
    profile: { codename: newGuestCodename(), clearance: 2, title: "収容担当" },
    chatLog: [
      { channel: "all", user: "指揮官", text: "異常を戦力化せよ。Thaumiel運用を維持すること。", ts: Date.now() },
      { channel: "all", user: "研究員クロサワ", text: "深層は違反リスクが高い。編成を整えてから潜れ。", ts: Date.now() },
    ],
  };
}

/** Create a unit instance from catalog */
function createUnit(catalogId, level = 1, rev = 0, bonus = {}) {
  const cat = GAME_DATA.catalog[catalogId];
  if (!cat) throw new Error(`Unknown catalog: ${catalogId}`);
  return {
    uid: 0,
    catalogId,
    level,
    rev,
    reclass: 0,
    bonus: { ...bonus },
    artifact: null,
    xp: 0,
  };
}

function uid(state) {
  const id = state.nextUnitId++;
  return id;
}

function maxLevel(rev) {
  return 30 + rev * 10;
}

function xpForLevel(lv) {
  return Math.floor(50 * Math.pow(lv, 1.5));
}

function emptyOperatorGear() {
  const gear = {};
  for (const slot of GAME_DATA.gearSlots) gear[slot.id] = null;
  return gear;
}

function emptyAttachLoadout() {
  const attach = {};
  for (const slot of GAME_DATA.attachSlots || []) attach[slot.id] = null;
  return attach;
}

/** 武器個体の採番。セーブ内で単調増加し、衝突しない */
function newGearUid(state) {
  state.nextGearUid = (state.nextGearUid || 0) + 1;
  return `w${state.nextGearUid}`;
}

/**
 * uid 個体管理が必要なのはアタッチ設定の受け皿である銃のみ。
 * 刃やサブウエポンはアタッチを持たないので従来どおりスタックする
 * （ドロップで量産されるアーティファクト武器の個体化は倉庫を壊す）。
 */
function needsWeaponUid(id) {
  return weaponTypeOf(id) === "gun";
}

function makeGearPiece(id, lv = 0, uid = null) {
  return {
    id,
    lv: Math.max(0, lv | 0),
    uid: uid || null,
  };
}

function equippedItemId(entry) {
  if (!entry) return null;
  return typeof entry === "string" ? entry : entry.id;
}

function gearPieceOf(entry) {
  if (!entry) return null;
  if (typeof entry === "string") return makeGearPiece(entry, 0);
  return makeGearPiece(entry.id, entry.lv || 0, entry.uid || null);
}

/**
 * アタッチ設定の本体。キーは武器個体の uid。
 * アタッチの種類は武器を問わず装着でき、設定しても倉庫個体は消費されない。
 */
function ensureWeaponLoadouts(state) {
  if (!state.weaponLoadouts || typeof state.weaponLoadouts !== "object") {
    state.weaponLoadouts = {};
  }
  return state.weaponLoadouts;
}

function loadoutOf(state, uid) {
  if (!uid) return emptyAttachLoadout();
  const all = ensureWeaponLoadouts(state);
  if (!all[uid] || typeof all[uid] !== "object") return emptyAttachLoadout();
  return { ...emptyAttachLoadout(), ...all[uid] };
}

/** 装備中・倉庫の両方から uid で武器個体を探す */
function findWeaponPieceByUid(state, uid) {
  if (!uid) return null;
  const cur = gearPieceOf(state.operatorGear?.mainWeapon);
  if (cur?.uid === uid) return cur;
  for (const slot of state.storage || []) {
    if (slot?.uid === uid) return gearPieceOf(slot);
  }
  return null;
}

function attachInstOf(value) {
  if (!value) return null;
  if (typeof value === "string") {
    return { id: value, rarity: itemRarity(value), rolls: midAttachRolls(value) };
  }
  return {
    id: value.id,
    rarity: value.rarity || itemRarity(value.id),
    rolls: value.rolls || midAttachRolls(value.id),
  };
}

function attachInstKey(value) {
  const inst = attachInstOf(value);
  if (!inst) return "";
  return `${inst.id}:${inst.rarity}:${JSON.stringify(inst.rolls || {})}`;
}

function attachSignature(attach) {
  if (!attach || typeof attach !== "object") return "";
  return (GAME_DATA.attachSlots || []).map((s) => attachInstKey(attach[s.id])).join(",");
}

function instSignature(entry) {
  if (!entry) return "";
  const rar = entry.rarity || "";
  const rolls = entry.rolls ? JSON.stringify(entry.rolls) : "";
  return `${entry.lv || 0}|${attachSignature(entry.attach)}|${rar}|${rolls}`;
}

function hasAttachLoadout(attach) {
  if (!attach) return false;
  return Object.values(attach).some(Boolean);
}

const PCT_STATS = new Set(["crit", "eva", "regen", "thorns"]);
const ATTACH_ROLL_BAND = {
  E: [0, 0.35], D: [0.1, 0.45], C: [0.2, 0.55], B: [0.35, 0.7],
  A: [0.5, 0.85], S: [0.7, 0.95], SS: [0.85, 1],
};

function midFromRange(statRange, fallbackStat) {
  if (statRange && Object.keys(statRange).length) {
    const out = {};
    for (const [k, range] of Object.entries(statRange)) {
      const [lo, hi] = range;
      const mid = (lo + hi) / 2;
      out[k] = PCT_STATS.has(k) ? Math.round(mid * 1000) / 1000 : Math.round(mid);
    }
    return out;
  }
  return fallbackStat ? { ...fallbackStat } : {};
}

function midAttachRolls(id) {
  const meta = itemMeta(id);
  return midFromRange(meta?.statRange, meta?.stat);
}

function rollAttachRarity() {
  const weights = GAME_DATA.attachRarityWeights || { D: 1 };
  const entries = Object.entries(weights);
  let total = 0;
  for (const [, n] of entries) total += n;
  let r = Math.random() * total;
  for (const [id, n] of entries) {
    r -= n;
    if (r <= 0) return id;
  }
  return entries[0][0];
}

function rollInAttachRange(lo, hi, rarity, pct) {
  const [a, b] = ATTACH_ROLL_BAND[rarity] || [0, 1];
  const t = a + Math.random() * Math.max(0, b - a);
  const raw = lo + (hi - lo) * t;
  if (pct) return Math.round(raw * 1000) / 1000;
  return Math.round(raw);
}

function rollAttachInstance(id) {
  const meta = itemMeta(id);
  const rarity = rollAttachRarity();
  const rolls = {};
  const range = meta?.statRange;
  if (range) {
    for (const [k, pair] of Object.entries(range)) {
      const [lo, hi] = pair;
      rolls[k] = rollInAttachRange(lo, hi, rarity, PCT_STATS.has(k));
    }
  } else if (meta?.stat) {
    Object.assign(rolls, meta.stat);
  }
  return { id, rarity, rolls };
}

/** 検証用。振れ幅の上限値＋SS（パラレル） */
function maxAttachInstance(id) {
  const meta = itemMeta(id);
  const rolls = {};
  for (const [k, pair] of Object.entries(meta?.statRange || {})) {
    rolls[k] = pair[1];
  }
  if (!Object.keys(rolls).length && meta?.stat) Object.assign(rolls, meta.stat);
  return { id, rarity: "SS", rolls };
}

function ensureStorageEmptySlots(state, need) {
  let empty = 0;
  for (const s of state.storage) if (!s) empty++;
  while (empty < need) {
    state.storage.push(null);
    empty++;
  }
  state.storageSlots = Math.max(state.storageSlots || 0, state.storage.length);
}

/** 検証用。migrate からは呼ばない。アイコン確認時だけ手動で実行する */
function seedMaxAttachmentsForVerify(state) {
  if (state.seededMaxAttach) return;
  const list = GAME_DATA.attachments || [];
  ensureStorageEmptySlots(state, list.length);
  for (const a of list) {
    storageAdd(state, a.id, 1, maxAttachInstance(a.id));
  }
  state.seededMaxAttach = true;
}

function entryRarity(entry) {
  if (entry?.rarity) return entry.rarity;
  return itemRarity(entry?.id);
}

function formatRangeBound(key, value) {
  return formatStatValue(key, value).replace(/^\+/, "");
}

function formatAttachStatLine(inst) {
  const meta = itemMeta(inst?.id);
  const labels = {
    hp: "HP", atk: "物攻", anm: "異能", def: "防御", spd: "機動", luck: "運",
    crit: "CRIT", eva: "回避",
  };
  const rolls = inst?.rolls || {};
  const range = meta?.statRange || {};
  const parts = [];
  const keys = Object.keys(range).length ? Object.keys(range) : Object.keys(rolls);
  for (const k of keys) {
    const v = rolls[k];
    if (v == null) continue;
    const pair = range[k];
    if (pair) {
      parts.push(`${labels[k] || k} ${formatStatValue(k, v)}（${formatRangeBound(k, pair[0])}～${formatRangeBound(k, pair[1])}）`);
    } else {
      parts.push(`${labels[k] || k} ${formatStatValue(k, v)}`);
    }
  }
  return parts.join("  ") || "補正なし";
}

function ensureOperatorGear(state) {
  if (!state.operatorGear || typeof state.operatorGear !== "object") {
    state.operatorGear = emptyOperatorGear();
  }
  for (const slot of GAME_DATA.gearSlots) {
    if (!(slot.id in state.operatorGear)) state.operatorGear[slot.id] = null;
    const raw = state.operatorGear[slot.id];
    if (raw && typeof raw === "string") {
      const oldLv = state.operatorGearLv?.[slot.id] || 0;
      state.operatorGear[slot.id] = makeGearPiece(raw, oldLv);
    } else if (raw && typeof raw === "object") {
      state.operatorGear[slot.id] = makeGearPiece(raw.id, raw.lv || 0, raw.uid || null);
    }
  }
}

function materialsLack(state, mats) {
  const lack = [];
  for (const [id, n] of Object.entries(mats || {})) {
    if (n > 0 && !storageHas(state, id, n)) {
      lack.push({ id, need: n, have: storageCount(state, id) });
    }
  }
  return lack;
}

function spendMaterials(state, mats) {
  for (const [id, n] of Object.entries(mats || {})) {
    if (n > 0) storageRemove(state, id, n);
  }
}

/** 武器個体の消滅に伴い、uid 紐付きのアタッチ設定を破棄する */
function dropWeaponLoadout(state, uid) {
  if (uid && state.weaponLoadouts) delete state.weaponLoadouts[uid];
}

/** 1 レベル上げる暫定コスト（fromLv → fromLv+1） */
function enhanceStepCost(fromLv) {
  const spec = GAME_DATA.gearEnhance;
  const next = fromLv + 1;
  const mats = {};
  const scrap = (spec.scrapBase || 1) + Math.floor(next / (spec.scrapEvery || 10));
  if (scrap > 0) mats.p_scrap = scrap;
  if (next % (spec.alloyEvery || 5) === 0) mats.p_alloy = 1;
  if (next % (spec.circuitEvery || 10) === 0) mats.p_circuit = 1;
  return {
    budget: (spec.budgetBase || 5) + (spec.budgetPerLv || 3) * next,
    mats,
  };
}

function scaleIntCost(n, mult) {
  if (!n) return 0;
  return Math.max(1, Math.floor(n * mult + 1e-9));
}

/** fromLv から toLv まで一気に上げる合計。state があれば拠点パッシブの割引を掛ける */
function gearEnhanceCostRange(fromLv, toLv, st) {
  const spec = GAME_DATA.gearEnhance;
  const maxLv = spec.maxLv || 100;
  const from = Math.max(0, fromLv | 0);
  const to = Math.min(maxLv, toLv | 0);
  if (from >= maxLv) return { maxed: true, fromLv: from, toLv: from, mats: {}, budget: 0 };
  if (to <= from) return { maxed: false, fromLv: from, toLv: from, mats: {}, budget: 0 };
  const mats = {};
  let budget = 0;
  for (let lv = from; lv < to; lv++) {
    const step = enhanceStepCost(lv);
    budget += step.budget;
    for (const [id, n] of Object.entries(step.mats)) {
      mats[id] = (mats[id] || 0) + n;
    }
  }
  const p = sitePassives(st);
  const matMult = p.enhanceMat || 1;
  const budMult = p.enhanceBudget || 1;
  if (matMult !== 1) {
    for (const id of Object.keys(mats)) mats[id] = scaleIntCost(mats[id], matMult);
  }
  if (budMult !== 1) budget = scaleIntCost(budget, budMult);
  return { maxed: false, fromLv: from, toLv: to, mats, budget };
}

function enhanceOperatorGear(state, slotId, addLevels) {
  ensureOperatorGear(state);
  const piece = gearPieceOf(state.operatorGear[slotId]);
  if (!piece) return { ok: false, msg: "先に装備してください" };
  const add = Math.max(1, addLevels | 0);
  const cost = gearEnhanceCostRange(piece.lv, piece.lv + add, state);
  if (cost.maxed) return { ok: false, msg: "強化上限です" };
  if (cost.toLv <= piece.lv) return { ok: false, msg: "強化幅がありません" };
  if (state.budget < cost.budget) return { ok: false, msg: `予算不足 (要 ${cost.budget})` };
  const lack = materialsLack(state, cost.mats);
  if (lack.length) {
    return { ok: false, msg: `${itemName(lack[0].id)} が不足` };
  }
  state.budget -= cost.budget;
  spendMaterials(state, cost.mats);
  piece.lv = cost.toLv;
  state.operatorGear[slotId] = piece;
  return { ok: true, msg: `${itemName(piece.id)} を強化 Lv.${piece.lv}` };
}

function attachCandidates(state, attachSlotId) {
  const list = [];
  state.storage.forEach((slot, index) => {
    if (!slot) return;
    const meta = itemMeta(slot.id);
    if (meta?.kind !== "attach" || meta.attachSlot !== attachSlotId) return;
    const inst = attachInstOf(slot);
    list.push({ ...inst, qty: slot.qty, meta, index });
  });
  return list;
}

/**
 * ロードアウトへ設定する。倉庫個体は消費しない（所有していればどの銃にも効く）。
 * 設定は武器個体の uid に紐付いて保存される。
 */
function attachToWeapon(state, uid, attachSlotId, fromIndex) {
  const piece = findWeaponPieceByUid(state, uid);
  if (!piece) return { ok: false, msg: "武器が見つかりません" };
  if (weaponTypeOf(piece.id) !== "gun") return { ok: false, msg: "刃にはアタッチメントを装着できません" };
  const bag = state.storage[fromIndex];
  if (!bag) return { ok: false, msg: "倉庫にありません" };
  const meta = itemMeta(bag.id);
  if (meta?.kind !== "attach" || meta.attachSlot !== attachSlotId) {
    return { ok: false, msg: "この枠には装着できません" };
  }
  const inst = attachInstOf(bag);
  const all = ensureWeaponLoadouts(state);
  const loadout = { ...emptyAttachLoadout(), ...(all[uid] || {}) };
  loadout[attachSlotId] = { id: inst.id, rarity: inst.rarity, rolls: inst.rolls };
  all[uid] = loadout;
  saveGame(state);
  return { ok: true, msg: `${itemName(inst.id)} を装着（この武器に保存）` };
}

function detachFromWeapon(state, uid, attachSlotId) {
  const all = ensureWeaponLoadouts(state);
  const loadout = all[uid];
  const prev = loadout?.[attachSlotId];
  if (!prev) return { ok: false, msg: "未装着です" };
  const inst = attachInstOf(prev);
  loadout[attachSlotId] = null;
  saveGame(state);
  return { ok: true, msg: `${itemName(inst.id)} を外した（倉庫の個体は残る）` };
}

/** accessory 枠（acc1–3）は gear:"accessory" を入れる */
function itemFitsSlot(meta, slotId) {
  if (!meta?.gear) return false;
  if (slotId === "acc1" || slotId === "acc2" || slotId === "acc3") return meta.gear === "accessory";
  return meta.gear === slotId;
}

function mergeGearStat(into, stat) {
  if (!stat) return;
  for (const [k, v] of Object.entries(stat)) {
    if (k === "all") {
      for (const sk of ["hp", "atk", "anm", "def", "spd", "luck"]) into[sk] = (into[sk] || 0) + v;
    } else {
      into[k] = (into[k] || 0) + v;
    }
  }
}

function scaleStatByLv(stat, lv) {
  const per = GAME_DATA.gearEnhance?.statPerLv || 0;
  if (!stat) return {};
  const scaled = {};
  for (const [k, v] of Object.entries(stat)) {
    if (typeof v !== "number") continue;
    const mul = 1 + per * (lv || 0);
    scaled[k] = k === "crit" || k === "eva" || k === "regen" || k === "thorns"
      ? v * mul
      : Math.round(v * mul);
  }
  return scaled;
}

/** 装備中の銃に紐付くロードアウトのステ加算。刃装備中は乗らない */
function weaponLoadoutBonus(state) {
  const bonus = {};
  const piece = gearPieceOf(state.operatorGear?.mainWeapon);
  if (!piece || weaponTypeOf(piece.id) !== "gun") return bonus;
  const loadout = loadoutOf(state, piece.uid);
  for (const value of Object.values(loadout)) {
    if (!value) continue;
    mergeGearStat(bonus, attachInstOf(value).rolls);
  }
  return bonus;
}

/** 武器本体 + 強化 Lv のみ（アタッチは含めない） */
function pieceCombatStat(piece) {
  if (!piece) return {};
  const meta = itemMeta(piece.id);
  return scaleStatByLv(meta?.stat, piece.lv || 0);
}

/** 表示用の実効値。その武器個体の uid ロードアウトを加算する（銃のみ） */
function pieceCombatStatFull(state, piece) {
  const stat = pieceCombatStat(piece);
  if (piece?.uid && weaponTypeOf(piece.id) === "gun") {
    const loadout = loadoutOf(state, piece.uid);
    for (const value of Object.values(loadout)) {
      if (!value) continue;
      mergeGearStat(stat, attachInstOf(value).rolls);
    }
  }
  return stat;
}

function operatorGearBonus(state) {
  const bonus = {};
  ensureOperatorGear(state);
  for (const slot of GAME_DATA.gearSlots) {
    const piece = gearPieceOf(state.operatorGear[slot.id]);
    if (!piece) continue;
    mergeGearStat(bonus, pieceCombatStat(piece));
  }
  // アタッチ設定は装備中武器の uid に紐付く分だけ乗る（銃のみ）
  mergeGearStat(bonus, weaponLoadoutBonus(state));
  return bonus;
}

/** 装備品 ID → 戦闘で使うスキル定義（主人公専用） */
const GEAR_BATTLE_SKILLS = {
  eq_helm: { id: "gear_nvg", name: "NVG", type: "passive", stat: { def: 1.1, crit: 0.03 }, desc: "暗所索敵と防御底上げ。" },
  eq_nvg: { id: "gear_nvg2", name: "広域NVG", type: "passive", stat: { def: 1.12, luck: 1.08 }, desc: "広域索敵。" },
  eq_vest: { id: "gear_plate", name: "プレート", type: "active", power: 0, target: "self", buff: { def: 1.35, turns: 2 }, desc: "被弾時の防御を大幅底上げ。" },
  eq_riot: { id: "gear_riot", name: "鎮圧板", type: "active", power: 0, target: "self", buff: { def: 1.4, turns: 2 }, desc: "鎮圧防御。" },
  eq_rifle: { id: "gear_suppress", name: "サプレッサー", type: "active", power: 1.2, target: "single", element: "physical", desc: "物攻の単体射撃。" },
  eq_lmg: { id: "gear_lmg", name: "掃射", type: "active", power: 0.7, target: "all", element: "physical", hits: 3, desc: "全体掃射。" },
  eq_railgun: { id: "gear_rail", name: "電磁加速", type: "active", power: 1.5, target: "single", element: "physical", desc: "高威力の単体射撃。" },
  eq_pistol: { id: "gear_sidearm", name: "サイドアーム", type: "active", power: 0.9, target: "single", element: "physical", desc: "補助射撃。" },
  eq_smg: { id: "gear_smg", name: "短機関銃", type: "active", power: 0.85, target: "single", element: "physical", hits: 2, desc: "連射。" },
  eq_disruptor: { id: "gear_disrupt", name: "撹乱弾", type: "active", power: 1.1, target: "single", element: "anomaly", desc: "異能撹乱弾。" },
  eq_baton: { id: "gear_baton", name: "殴打", type: "active", power: 1.0, target: "single", element: "physical", desc: "物攻の近接打撃。" },
  eq_machete: { id: "gear_machete", name: "薙ぎ払い", type: "active", power: 1.1, target: "all", element: "physical", desc: "物攻の近接範囲攻撃。" },
  eq_heatblade: { id: "gear_heatblade", name: "灼熱斬", type: "active", power: 1.35, target: "single", element: "physical", desc: "高熱刃で装甲ごと断つ。" },
  eq_monoblade: { id: "gear_monoblade", name: "分子切断", type: "active", power: 1.6, target: "single", element: "physical", desc: "単分子の刃で両断する。" },
};

function getOperatorCombatSkills(state) {
  ensureOperatorGear(state);
  const out = [];
  for (const slot of GAME_DATA.gearSlots) {
    const id = equippedItemId(state.operatorGear[slot.id]);
    if (!id) continue;
    const battle = GEAR_BATTLE_SKILLS[id];
    if (battle) {
      out.push({ ...battle });
      continue;
    }
    const meta = itemMeta(id);
    if (meta?.skill) {
      out.push({
        id: `gear_${id}`,
        name: meta.skill.name,
        type: "active",
        power: 0.75,
        target: "single",
        element: "anomaly",
        desc: meta.skill.desc,
      });
    }
  }
  const hasAttack = out.some((s) => s.type === "active" && s.power > 0);
  if (!hasAttack) {
    out.push({
      id: "op_bash",
      name: "打撃",
      type: "active",
      power: 0.8,
      target: "single",
      element: "physical",
      desc: "基本攻撃。",
    });
  }
  return out;
}

function applyPassiveSkillStats(stats, passives) {
  for (const p of passives) {
    if (p.stat?.all) {
      for (const sk of ["hp", "atk", "anm", "def", "spd", "luck"]) {
        stats[sk] = Math.floor((stats[sk] || 0) * p.stat.all);
      }
    }
    if (p.stat) {
      for (const [k, v] of Object.entries(p.stat)) {
        if (k === "all" || k === "stealMult" || k === "artifactChance") continue;
        if (k === "crit" || k === "eva" || k === "regen" || k === "thorns") {
          stats[k] = (stats[k] || 0) + v;
        } else {
          stats[k] = Math.floor((stats[k] || 0) * v);
        }
      }
    }
  }
}

/** 主人公の戦闘ステータス（装備補正は本人のみ） */
function calcOperatorStats(state) {
  const stats = { ...GAME_DATA.operatorBase };
  const clearance = state.profile?.clearance || 2;
  if (clearance > 2) {
    const bonus = (clearance - 2) * 2;
    stats.atk += bonus;
    stats.def += bonus;
    stats.hp += bonus * 3;
  }
  mergeGearStat(stats, operatorGearBonus(state));
  applyPassiveSkillStats(stats, getOperatorCombatSkills(state).filter((s) => s.type === "passive"));
  stats.maxHp = stats.hp;
  stats.crit = stats.crit || 0.05;
  stats.critDmg = stats.critDmg || 0.5;
  stats.eva = stats.eva || 0;
  stats.regen = stats.regen || 0;
  stats.thorns = stats.thorns || 0;
  stats.stealMult = stats.stealMult || 1;
  stats.artifactChance = stats.artifactChance || 0;
  return stats;
}

function buildOperatorCombatant(state) {
  const profile = state.profile || { codename: "Researcher", title: "収容担当" };
  const stats = calcOperatorStats(state);
  return {
    unit: null,
    isOperator: true,
    name: profile.codename || "司令官",
    hp: stats.maxHp,
    maxHp: stats.maxHp,
    stats,
    skills: getOperatorCombatSkills(state),
    buffs: [],
    alive: true,
    dmgDealt: 0,
    dmgTaken: 0,
  };
}

/** 編成の収容個体（最大5）。主人公は含まない */
function getSquadUnits(state) {
  if (!Array.isArray(state.squad)) return [];
  return state.squad
    .map((id) => state.units.find((u) => u.uid === id))
    .filter(Boolean);
}

function normalizeSquad(state) {
  if (!Array.isArray(state.squad)) state.squad = [];
  state.squad = state.squad.filter((id) => state.units.some((u) => u.uid === id));
  if (state.squad.length > 5) state.squad = state.squad.slice(0, 5);
}

function operatorDisplayStats(state) {
  const stats = calcOperatorStats(state);
  const skills = [];
  for (const slot of GAME_DATA.gearSlots) {
    const id = equippedItemId(state.operatorGear[slot.id]);
    const meta = id ? itemMeta(id) : null;
    if (meta?.skill) skills.push({ slot: slot.name, name: meta.skill.name, desc: meta.skill.desc });
  }
  return { stats, skills };
}

function flattenGearStat(stat) {
  const out = { hp: 0, atk: 0, anm: 0, def: 0, spd: 0, luck: 0, crit: 0, eva: 0 };
  mergeGearStat(out, stat);
  return out;
}

function formatStatValue(key, value) {
  if (key === "crit" || key === "eva") {
    const pct = Math.round(value * 100);
    return `${pct >= 0 ? "+" : ""}${pct}%`;
  }
  return `${value >= 0 ? "+" : ""}${value}`;
}

function formatItemStats(stat) {
  const labels = {
    hp: "HP", atk: "物攻", anm: "異能", def: "防御", spd: "機動", luck: "運",
    crit: "CRIT", eva: "回避", all: "全能力",
  };
  if (!stat || !Object.keys(stat).length) return "補正なし";
  return Object.entries(stat).map(([k, v]) => `${labels[k] || k} ${formatStatValue(k, v)}`).join("  ");
}

/**
 * 候補装備の各ステータスを、現在装備と比較して HTML にする。
 * 上昇は緑↑、下降は赤↓。装備中行は currentStat を渡さず通常表示にする。
 */
function formatItemStatsCompare(nextStat, currentStat) {
  const labels = {
    hp: "HP", atk: "物攻", anm: "異能", def: "防御", spd: "機動", luck: "運",
    crit: "CRIT", eva: "回避",
  };
  const next = flattenGearStat(nextStat);
  const current = flattenGearStat(currentStat);
  const parts = [];
  for (const key of Object.keys(labels)) {
    const nv = next[key] || 0;
    const cv = current[key] || 0;
    if (nv === 0 && cv === 0) continue;
    let cls = "";
    let arrow = "";
    if (nv > cv) {
      cls = "up";
      arrow = "↑";
    } else if (nv < cv) {
      cls = "down";
      arrow = "↓";
    }
    const text = `${labels[key]} ${formatStatValue(key, nv)}${arrow ? ` ${arrow}` : ""}`;
    parts.push(cls ? `<span class="${cls}">${text}</span>` : `<span>${text}</span>`);
  }
  return parts.join(" ") || "補正なし";
}

function gearCandidates(state, slotId) {
  const groups = new Map();
  state.storage.forEach((slot, index) => {
    if (!slot) return;
    if (!itemFitsSlot(itemMeta(slot.id), slotId)) return;
    // 武器は uid の個体管理なのでグルーピングしない
    const sig = slot.uid ? `w|${slot.uid}` : `${slot.id}|${instSignature(slot)}`;
    const g = groups.get(sig);
    if (g) {
      g.qty += slot.qty;
      return;
    }
    groups.set(sig, {
      id: slot.id,
      qty: slot.qty,
      lv: slot.lv || 0,
      uid: slot.uid || null,
      meta: itemMeta(slot.id),
      index,
    });
  });
  return [...groups.values()];
}

function ownedGearCount(state) {
  ensureOperatorGear(state);
  let n = GAME_DATA.gearSlots.filter((s) => state.operatorGear[s.id]).length;
  for (const slot of state.storage) {
    if (slot && (itemMeta(slot.id)?.gear || itemMeta(slot.id)?.kind === "attach")) n += slot.qty;
  }
  return n;
}

function equipOperator(state, slotId, itemId, fromIndex) {
  ensureOperatorGear(state);
  const slot = GAME_DATA.gearSlots.find((s) => s.id === slotId);
  if (!slot) return { ok: false, msg: "未知の装備枠です" };
  if (!itemId) return unequipOperator(state, slotId);
  const meta = itemMeta(itemId);
  if (!itemFitsSlot(meta, slotId)) return { ok: false, msg: "この枠には装備できません" };
  let piece = null;
  if (typeof fromIndex === "number") {
    const bag = state.storage[fromIndex];
    if (!bag || bag.id !== itemId) return { ok: false, msg: "倉庫にありません" };
    piece = makeGearPiece(itemId, bag.lv || 0, bag.uid || null);
    bag.qty -= 1;
    if (bag.qty <= 0) state.storage[fromIndex] = null;
  } else {
    if (!storageHas(state, itemId, 1)) return { ok: false, msg: "倉庫にありません" };
    const idx = findStorageIndex(state, itemId);
    if (idx < 0) return { ok: false, msg: "倉庫にありません" };
    const bag = state.storage[idx];
    piece = makeGearPiece(itemId, bag.lv || 0, bag.uid || null);
    bag.qty -= 1;
    if (bag.qty <= 0) state.storage[idx] = null;
  }
  const current = gearPieceOf(state.operatorGear[slotId]);
  if (current) {
    const leftover = storageAdd(state, current.id, 1, current);
    if (leftover > 0) addInventory(state, current.id, leftover);
  }
  state.operatorGear[slotId] = piece;
  saveGame(state);
  return { ok: true, msg: `${itemName(itemId)} を ${slot.name} に装備` };
}

function unequipOperator(state, slotId) {
  ensureOperatorGear(state);
  const current = gearPieceOf(state.operatorGear[slotId]);
  if (!current) return { ok: false, msg: "空です" };
  const leftover = storageAdd(state, current.id, 1, current);
  if (leftover > 0) addInventory(state, current.id, leftover);
  state.operatorGear[slotId] = null;
  saveGame(state);
  return { ok: true, msg: `${itemName(current.id)} を外した` };
}

function calcStats(unit, st) {
  const cat = GAME_DATA.catalog[unit.catalogId];
  const lv = unit.level;
  const rev = unit.rev;
  const reclass = unit.reclass || 0;
  const scale = 1 + (lv - 1) * 0.04 + rev * 0.08 + reclass * 0.05;
  const stats = {};
  for (const [k, v] of Object.entries(cat.base)) {
    stats[k] = Math.floor(v * scale);
  }
  for (const [k, v] of Object.entries(unit.bonus || {})) {
    stats[k] = (stats[k] || 0) + v;
  }
  if (unit.artifact) {
    mergeGearStat(stats, GAME_DATA.artifacts.find((a) => a.id === unit.artifact)?.stat);
  }
  const passives = getUnitSkills(unit).filter((s) => s.type === "passive");
  for (const p of passives) {
    if (p.stat?.all) {
      for (const sk of ["hp", "atk", "anm", "def", "spd", "luck"]) {
        stats[sk] = Math.floor((stats[sk] || 0) * p.stat.all);
      }
    }
    if (p.stat) {
      for (const [k, v] of Object.entries(p.stat)) {
        if (k === "all" || k === "stealMult" || k === "artifactChance") continue;
        if (k === "crit" || k === "eva" || k === "regen" || k === "thorns") {
          stats[k] = (stats[k] || 0) + v;
        } else {
          stats[k] = Math.floor((stats[k] || 0) * v);
        }
      }
    }
  }
  stats.maxHp = stats.hp;
  stats.crit = stats.crit || 0.05;
  stats.critDmg = stats.critDmg || 0.5;
  stats.eva = stats.eva || 0;
  stats.regen = stats.regen || 0;
  stats.thorns = stats.thorns || 0;
  stats.stealMult = stats.stealMult || 1;
  stats.artifactChance = stats.artifactChance || 0;
  return stats;
}

function getUnitSkills(unit) {
  const cat = GAME_DATA.catalog[unit.catalogId];
  const ids = (Array.isArray(unit.inheritedSkills) && unit.inheritedSkills.length)
    ? unit.inheritedSkills
    : (cat.skills || []);
  const out = [];
  for (const sid of ids) {
    const sk = GAME_DATA.skills[sid];
    if (sk) out.push(sk);
  }
  return out;
}

function getUnitDisplay(unit) {
  const cat = GAME_DATA.catalog[unit.catalogId];
  return {
    ...unit,
    ...cat,
    stats: calcStats(unit),
    maxLv: maxLevel(unit.rev),
  };
}

/** セーブに残さないキー。メモリ上の進行表示用で、再開に不要 */
const SAVE_OMIT = new Set([
  "battleLog",
  "lastExplore",
  "equipped",
  "staminaMax",
  "chamberMax",
]);

/**
 * ディスク／クラウドへ出すセーブを作る。ライブ state は変更しない。
 * 全体チャットのプレイヤー発言は Firebase 側が正本なので含めない。
 */
function sanitizeStateForSave(state) {
  const out = {};
  for (const [k, v] of Object.entries(state)) {
    if (SAVE_OMIT.has(k)) continue;
    out[k] = v;
  }
  const chat = Array.isArray(state.chatLog) ? state.chatLog : [];
  out.chatLog = chat.filter((m) =>
    m.channel === "question" || (m.channel === "all" && m.user === "指揮官")
  ).slice(-50);
  return out;
}

function saveGame(state) {
  try {
    snapshotSiteProgress(state);
    state.savedAt = Date.now();
    const payload = sanitizeStateForSave(state);
    localStorage.setItem(SAVE_KEY, JSON.stringify(payload));
    if (typeof window.onGameSaved === "function") window.onGameSaved(payload);
  } catch (e) {
    console.error("Save failed", e);
  }
}

function loadGame() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const state = JSON.parse(raw);
    migrateState(state);
    applySiteBonuses(state);
    applyStaminaRegen(state);
    return state;
  } catch (e) {
    console.error("Load failed", e);
    return null;
  }
}

function applyStaminaRegen(state) {
  const now = Date.now();
  const elapsed = now - (state.staminaUpdatedAt || now);
  const regen = Math.floor(elapsed / GAME_DATA.staminaRegenMs);
  if (regen > 0) {
    const cap = typeof state.staminaMax === "number" ? state.staminaMax : GAME_DATA.staminaMaxBase;
    state.stamina = Math.min(cap, state.stamina + regen);
    state.staminaUpdatedAt = now - (elapsed % GAME_DATA.staminaRegenMs);
  }
}

function applySiteBonuses(state) {
  const site = GAME_DATA.siteUpgrades[state.siteLevel - 1] || GAME_DATA.siteUpgrades[0];
  const p = sitePassives(state);
  state.staminaMax = GAME_DATA.staminaMaxBase + site.staminaBonus + (p.stamina || 0);
  state.chamberMax = site.chamberSlots + (p.chamber || 0);
}

function siteTreeSpec() {
  return GAME_DATA.siteTree || { startId: "n_start", nodes: [], edges: [], startPoints: 3, pointsPerLevel: 4 };
}

function siteTreeNodeMap() {
  const map = new Map();
  for (const n of siteTreeSpec().nodes || []) map.set(n.id, n);
  return map;
}

function siteTreeAdj() {
  const adj = new Map();
  const add = (a, b) => {
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a).push(b);
  };
  for (const [a, b] of siteTreeSpec().edges || []) {
    add(a, b);
    add(b, a);
  }
  return adj;
}

function emptySitePassives() {
  return {
    sentryMax: 0,
    sentryAmmo: 0,
    sentryRadius: 0,
    sentrySave: 0,
    enhanceMat: 1,
    enhanceBudget: 1,
    craftCost: 1,
    dismantleChance: 0,
    dismantleExtra: 1,
    stamina: 0,
    dropBonus: 0,
    chamber: 0,
    reconSpeed: 1,
  };
}

function mergeSiteEffects(out, effects) {
  if (!effects) return;
  for (const [k, v] of Object.entries(effects)) {
    if (k === "enhanceMat" || k === "enhanceBudget" || k === "craftCost" || k === "reconSpeed") {
      out[k] = (out[k] || 1) * v;
    } else {
      out[k] = (out[k] || 0) + v;
    }
  }
}

function ensureSiteTree(state) {
  const startId = siteTreeSpec().startId || "n_start";
  if (!Array.isArray(state.siteNodes) || !state.siteNodes.length) {
    state.siteNodes = [startId];
    return;
  }
  if (!state.siteNodes.includes(startId)) state.siteNodes.unshift(startId);
}

function siteAllocatedSet(state) {
  ensureSiteTree(state);
  return new Set(state.siteNodes);
}

function sitePointsTotal(state) {
  const spec = siteTreeSpec();
  const lv = Math.max(1, state.siteLevel | 0);
  return (spec.startPoints || 3) + (lv - 1) * (spec.pointsPerLevel || 4);
}

function sitePointsSpent(state) {
  const map = siteTreeNodeMap();
  let n = 0;
  for (const id of state.siteNodes || []) {
    const node = map.get(id);
    if (node) n += node.cost || 0;
  }
  return n;
}

function sitePointsUnspent(state) {
  return Math.max(0, sitePointsTotal(state) - sitePointsSpent(state));
}

function siteNodeReachable(state, nodeId) {
  const spec = siteTreeSpec();
  if (nodeId === spec.startId) return true;
  const allocated = siteAllocatedSet(state);
  const adj = siteTreeAdj().get(nodeId) || [];
  return adj.some((id) => allocated.has(id));
}

function sitePassives(state) {
  const out = emptySitePassives();
  if (!state) return out;
  const map = siteTreeNodeMap();
  ensureSiteTree(state);
  for (const id of state.siteNodes) {
    mergeSiteEffects(out, map.get(id)?.effects);
  }
  return out;
}

function siteDropBonus(state) {
  const site = GAME_DATA.siteUpgrades[state.siteLevel - 1];
  const map = currentMapSite(state);
  return (site?.dropBonus || 0) + (sitePassives(state).dropBonus || 0) + (map?.dropBonus || 0);
}

function sentryMaxOf(st) {
  const base = typeof SENTRY_MAX === "number" ? SENTRY_MAX : 2;
  return base + (sitePassives(st).sentryMax || 0);
}

function sentryAmmoMaxOf(st) {
  const base = typeof SENTRY_AMMO_MAX === "number" ? SENTRY_AMMO_MAX : 20;
  return base + (sitePassives(st).sentryAmmo || 0);
}

function sentryRadiusOf(st) {
  const base = typeof SENTRY_RADIUS === "number" ? SENTRY_RADIUS : 56;
  return base + (sitePassives(st).sentryRadius || 0);
}

function allocateSiteNode(state, nodeId) {
  ensureSiteTree(state);
  const node = siteTreeNodeMap().get(nodeId);
  if (!node) return { ok: false, msg: "未知のノードです" };
  if (state.siteNodes.includes(nodeId)) return { ok: false, msg: "割り当て済みです" };
  if (!siteNodeReachable(state, nodeId)) return { ok: false, msg: "隣接する取得済みノードが必要です" };
  const cost = node.cost || 0;
  if (sitePointsUnspent(state) < cost) return { ok: false, msg: "プロトコル点が不足しています" };
  state.siteNodes.push(nodeId);
  applySiteBonuses(state);
  saveGame(state);
  return { ok: true, msg: `${node.name} を割り当て` };
}

function respecSiteTree(state) {
  const spec = siteTreeSpec();
  const spent = sitePointsSpent(state);
  if (spent <= 0) return { ok: false, msg: "解除するノードがありません" };
  const cost = spec.respecCost || 400;
  if (state.budget < cost) return { ok: false, msg: `予算不足 (要 ${cost})` };
  state.budget -= cost;
  state.siteNodes = [spec.startId];
  applySiteBonuses(state);
  saveGame(state);
  return { ok: true, msg: `プロトコルを再編成（-${cost}）` };
}

function applyDismantleBonus(state, yields) {
  const p = sitePassives(state);
  const out = { ...yields };
  let bonus = null;
  const chance = p.dismantleChance || 0;
  if (chance > 0 && Math.random() < chance) {
    const keys = Object.keys(out);
    if (keys.length) {
      const k = keys[Math.floor(Math.random() * keys.length)];
      const extra = p.dismantleExtra || 1;
      out[k] = (out[k] || 0) + extra;
      bonus = { id: k, extra };
    }
  }
  return { yields: out, bonus };
}

/* ===== アイテム定義の横断索引 ===== */

/** 部品・収容アイテム・アーティファクトを 1 つの id 空間で引けるようにする */
const ITEM_INDEX = (() => {
  const map = new Map();
  for (const p of GAME_DATA.parts) map.set(p.id, { ...p, kind: "part" });
  for (const o of GAME_DATA.recoveryObjects) map.set(o.id, { ...o, kind: "object" });
  for (const a of GAME_DATA.artifacts) map.set(a.id, { ...a, kind: "artifact", value: a.sell });
  for (const g of GAME_DATA.gear) map.set(g.id, { ...g, kind: "gear", value: g.value ?? g.sell });
  for (const a of GAME_DATA.attachments || []) {
    map.set(a.id, {
      ...a,
      kind: "attach",
      value: a.value ?? a.sell,
      stat: midFromRange(a.statRange, a.stat),
    });
  }
  return map;
})();

const RARITY_RANK = { E: 0, D: 1, C: 2, B: 3, A: 4, S: 5, SS: 6 };
const RARITY_ORDER = ["E", "D", "C", "B", "A", "S", "SS"];
/** 深度1と深度50の相対重み。線形補間し、深いほど高レアが出やすくする */
const RARITY_CURVE = {
  E: [78, 10],
  D: [18, 16],
  C: [3.5, 22],
  B: [0.5, 22],
  A: [0, 18],
  S: [0, 9],
  SS: [0, 3],
};

function rarityStars(r) {
  return "★".repeat((RARITY_RANK[r] ?? 0) + 1);
}

function canonicalItemId(id) {
  return GAME_DATA.partAlias[id] || id;
}

function emptyPartsBag() {
  const bag = {};
  for (const p of GAME_DATA.parts) bag[p.id] = 0;
  return bag;
}

function itemMeta(id) {
  return ITEM_INDEX.get(id) || null;
}
function itemName(id) {
  return itemMeta(id)?.name || id;
}
function itemValue(id) {
  return itemMeta(id)?.value || 0;
}
function itemRarity(id) {
  return itemMeta(id)?.rarity || "E";
}

/** メインウエポンのジャンル。未設定の旧データは銃として扱う */
function weaponTypeOf(id) {
  const meta = itemMeta(id);
  if (!meta) return null;
  if (meta.gear !== "mainWeapon") return null;
  return meta.weaponType || "gun";
}
function weaponTypeName(id) {
  const t = weaponTypeOf(id);
  return GAME_DATA.weaponTypes?.find((w) => w.id === t)?.name || "";
}
function isPart(id) {
  return itemMeta(id)?.kind === "part";
}
function stackLimit(state, id) {
  return isPart(id) ? state.partStack : state.itemStack;
}

/**
 * 分解で戻る部品。基礎部品自身は分解不可。
 * @returns {object|null}
 */
function dismantleYield(id) {
  if (isPart(id)) return null;
  const meta = itemMeta(id);
  if (!meta) return null;
  if (meta.scrapTo) return { ...meta.scrapTo };
  if (!meta.craft) return null;
  const out = {};
  for (const [pid, n] of Object.entries(meta.craft)) {
    out[pid] = Math.max(1, Math.floor(n * GAME_DATA.dismantleRate));
  }
  return out;
}

/** 深度に応じた基礎部品のランダムドロップ（上位ティアほど weight が低い） */
function rollPartDrop(depth) {
  const pool = [];
  for (const tierDef of GAME_DATA.partDropTable) {
    if (depth < tierDef.minDepth) continue;
    for (const id of tierDef.ids) {
      for (let i = 0; i < tierDef.weight; i++) pool.push(id);
    }
  }
  return pool[Math.floor(Math.random() * pool.length)];
}

function rarityWeights(depth) {
  const t = (Math.max(1, Math.min(50, depth)) - 1) / 49;
  const w = {};
  for (const g of RARITY_ORDER) {
    const [a, b] = RARITY_CURVE[g];
    w[g] = a + (b - a) * t;
  }
  return w;
}

function rarityPercents(depth) {
  const w = rarityWeights(depth);
  const total = RARITY_ORDER.reduce((s, g) => s + w[g], 0);
  const out = {};
  for (const g of RARITY_ORDER) out[g] = total > 0 ? (w[g] / total) * 100 : 0;
  return out;
}

function formatRarityPct(pct) {
  if (pct < 0.05) return "0%";
  if (pct < 10) return `${pct.toFixed(1)}%`;
  return `${Math.round(pct)}%`;
}

function rarityHudHtml(depth) {
  const pct = rarityPercents(depth);
  const chips = RARITY_ORDER.map((g) =>
    `<span class="rarity-chip" data-r="${g}"><b>${g}</b> ${formatRarityPct(pct[g])}</span>`
  ).join("");
  return `<div class="rarity-hud"><span class="rarity-hud-label">レア度発見率</span>${chips}</div>`;
}

function rollRarity(depth) {
  const w = rarityWeights(depth);
  let r = Math.random() * RARITY_ORDER.reduce((s, g) => s + w[g], 0);
  for (const g of RARITY_ORDER) {
    r -= w[g];
    if (r <= 0) return g;
  }
  return "E";
}

function poolForRarity(rarity) {
  const objs = GAME_DATA.recoveryObjects.filter((o) => o.rarity === rarity && !o.exclusive);
  const arts = GAME_DATA.artifacts.filter((a) => a.rarity === rarity && !a.exclusive);
  return [...objs, ...arts];
}

/** 深度に応じた回収物。等級は rarityWeights、品は同レアの収容品／アーティファクトから選ぶ */
function rollObjectDrop(depth) {
  let rarity = rollRarity(depth);
  let pool = poolForRarity(rarity);
  let i = RARITY_ORDER.indexOf(rarity);
  while (!pool.length && i > 0) {
    i -= 1;
    rarity = RARITY_ORDER[i];
    pool = poolForRarity(rarity);
  }
  if (!pool.length) return GAME_DATA.recoveryObjects[0].id;
  return pool[Math.floor(Math.random() * pool.length)].id;
}

/* ===== 倉庫（スロット制）と入手アイテム ===== */

function storageCount(state, id) {
  id = canonicalItemId(id);
  if (isPart(id)) return state.parts[id] || 0;
  let n = 0;
  for (const slot of state.storage) {
    if (slot && slot.id === id) n += slot.qty;
  }
  return n;
}

function storageUsed(state) {
  return state.storage.reduce((n, s) => n + (s && !isPart(s.id) ? 1 : 0), 0);
}

/**
 * 倉庫へ入れる。基礎部品は専用袋、それ以外はスロット。
 * @returns {number} 容量不足で入りきらなかった数
 */
function storageAdd(state, id, qty, inst) {
  id = canonicalItemId(id);
  if (isPart(id)) {
    const cap = state.partStack;
    const have = state.parts[id] || 0;
    const put = Math.min(cap - have, qty);
    state.parts[id] = have + Math.max(0, put);
    return qty - put;
  }
  if (itemMeta(id)?.kind === "attach") {
    let left = qty;
    for (let n = 0; n < qty; n++) {
      let empty = -1;
      for (let i = 0; i < state.storage.length; i++) {
        if (!state.storage[i]) { empty = i; break; }
      }
      if (empty < 0) break;
      const rolled = (inst?.rarity && inst?.rolls)
        ? { id, rarity: inst.rarity, rolls: inst.rolls }
        : rollAttachInstance(id);
      state.storage[empty] = { id, qty: 1, rarity: rolled.rarity, rolls: rolled.rolls };
      left -= 1;
    }
    return left;
  }
  // 銃は固有 uid の個体として管理し、スタックしない（アタッチ設定が uid 紐付きのため）
  if (needsWeaponUid(id)) {
    let left = qty;
    for (let n = 0; n < qty; n++) {
      let empty = -1;
      for (let i = 0; i < state.storage.length; i++) {
        if (!state.storage[i]) { empty = i; break; }
      }
      if (empty < 0) break;
      const entry = { id, qty: 1, uid: inst?.uid || newGearUid(state) };
      const lv = inst?.lv || 0;
      if (lv > 0) entry.lv = lv;
      state.storage[empty] = entry;
      left -= 1;
    }
    return left;
  }
  const limit = stackLimit(state, id);
  const lv = inst?.lv || 0;
  const wantSig = instSignature({ lv });
  let left = qty;
  for (const slot of state.storage) {
    if (left <= 0) break;
    if (!slot || slot.id !== id || slot.qty >= limit) continue;
    if (instSignature(slot) !== wantSig) continue;
    const put = Math.min(limit - slot.qty, left);
    slot.qty += put;
    left -= put;
  }
  for (let i = 0; i < state.storage.length && left > 0; i++) {
    if (state.storage[i]) continue;
    const put = Math.min(limit, left);
    const entry = { id, qty: put };
    if (lv > 0) entry.lv = lv;
    state.storage[i] = entry;
    left -= put;
  }
  return left;
}

/** 同じ id のスロットを、強化の浅い個体から取る */
function findStorageIndex(state, id, inst) {
  id = canonicalItemId(id);
  let best = -1;
  let bestKey = "";
  const wantSig = inst ? instSignature(inst) : null;
  state.storage.forEach((slot, i) => {
    if (!slot || slot.id !== id) return;
    if (wantSig && instSignature(slot) !== wantSig) return;
    const key = instSignature(slot);
    if (best < 0 || key < bestKey) {
      best = i;
      bestKey = key;
    }
  });
  return best;
}

/** @returns {number} 実際に取り出せた数 */
function storageRemove(state, id, qty) {
  id = canonicalItemId(id);
  if (isPart(id)) {
    const have = state.parts[id] || 0;
    const take = Math.min(have, qty);
    state.parts[id] = have - take;
    return take;
  }
  let left = qty;
  const order = state.storage
    .map((slot, i) => ({ slot, i }))
    .filter((x) => x.slot && x.slot.id === id)
    .sort((a, b) => instSignature(a.slot).localeCompare(instSignature(b.slot)));
  for (const { slot, i } of order) {
    if (left <= 0) break;
    const take = Math.min(slot.qty, left);
    if (slot.uid) dropWeaponLoadout(state, slot.uid);
    slot.qty -= take;
    left -= take;
    if (slot.qty <= 0) state.storage[i] = null;
  }
  return qty - left;
}

function storageHas(state, id, qty = 1) {
  return storageCount(state, id) >= qty;
}

/** 探索の戦利品は倉庫に直行せず、未整理領域に積む */
function addInventory(state, itemId, qty = 1) {
  itemId = canonicalItemId(itemId);
  const existing = state.pending.find((p) => p.id === itemId);
  if (existing) existing.qty += qty;
  else state.pending.push({ id: itemId, qty });
  // 時限観測のリザルトは「この挑戦で入った未整理」だけを出す
  if (isLimitedRunActive(state) && currentMapSite(state)?.limited) {
    recordLimitedLoot(state, itemId, qty);
  }
}

function pendingTotal(state) {
  return state.pending.reduce((n, p) => n + p.qty, 0);
}

/** 未整理エントリから qty 個を取り除く。qty 省略で全部 */
function takePending(state, index, qty) {
  const entry = state.pending[index];
  if (!entry) return 0;
  const take = Math.min(entry.qty, qty ?? entry.qty);
  entry.qty -= take;
  if (entry.qty <= 0) state.pending.splice(index, 1);
  return take;
}

/** 未整理 → 倉庫。容量オーバー分は未整理に残す */
function stashPending(state, index, qty) {
  const entry = state.pending[index];
  if (!entry) return { ok: false, msg: "対象がありません" };
  const id = entry.id;
  const want = Math.min(entry.qty, qty ?? entry.qty);
  const leftover = storageAdd(state, id, want);
  takePending(state, index, want - leftover);
  if (leftover === want) return { ok: false, msg: "倉庫に空きがありません" };
  return {
    ok: true,
    msg: `${itemName(id)} ×${want - leftover} を保管` + (leftover ? `（${leftover} 個は容量不足）` : ""),
  };
}

/** 未整理 → ゴミ箱（予算化） */
function scrapPending(state, index, qty) {
  const entry = state.pending[index];
  if (!entry) return { ok: false, msg: "対象がありません" };
  const id = entry.id;
  const took = takePending(state, index, qty);
  const gain = itemValue(id) * took;
  state.budget += gain;
  return { ok: true, msg: `${itemName(id)} ×${took} を廃棄 — 予算 +${gain}` };
}

/** 未整理 → 分解（基礎部品を倉庫へ直接入れる） */
function dismantlePending(state, index, qty) {
  const entry = state.pending[index];
  if (!entry) return { ok: false, msg: "対象がありません" };
  const id = entry.id;
  const yields = dismantleYield(id);
  if (!yields) return { ok: false, msg: `${itemName(id)} はこれ以上分解できません` };
  const took = takePending(state, index, qty);
  const rolled = applyDismantleBonus(state, yields);
  const parts = [];
  for (const [pid, n] of Object.entries(rolled.yields)) {
    const total = n * took;
    const leftover = storageAdd(state, pid, total);
    parts.push(`${itemName(pid)}×${total - leftover}`);
  }
  const extra = rolled.bonus ? ` / 選別 +${itemName(rolled.bonus.id)}×${rolled.bonus.extra}` : "";
  return { ok: true, msg: `${itemName(id)} ×${took} を分解 — ${parts.join(" / ")}${extra}` };
}

/** 倉庫のスロットを予算化する。武器の場合、アタッチ設定は個体と一緒に消える（アタッチ在庫は減らない） */
function scrapStorageSlot(state, slotIndex, qty) {
  const slot = state.storage[slotIndex];
  if (!slot) return { ok: false, msg: "空きスロットです" };
  const take = Math.min(slot.qty, qty ?? slot.qty);
  const gain = itemValue(slot.id) * take;
  const id = slot.id;
  if (slot.uid) dropWeaponLoadout(state, slot.uid);
  slot.qty -= take;
  if (slot.qty <= 0) state.storage[slotIndex] = null;
  state.budget += gain;
  return { ok: true, msg: `${itemName(id)} ×${take} を廃棄 — 予算 +${gain}` };
}

/** 基礎部品枠を予算化する */
function scrapPart(state, id, qty) {
  id = canonicalItemId(id);
  if (!isPart(id)) return { ok: false, msg: "基礎部品ではありません" };
  const take = storageRemove(state, id, qty ?? storageCount(state, id));
  if (!take) return { ok: false, msg: "在庫がありません" };
  const gain = itemValue(id) * take;
  state.budget += gain;
  return { ok: true, msg: `${itemName(id)} ×${take} を廃棄 — 予算 +${gain}` };
}

/** 廃棄プレビュー（確認ダイアログ用） */
function scrapPreview(id, qty) {
  return { name: itemName(id), qty, gain: itemValue(id) * qty };
}

/** 分解プレビュー。分解不可なら null */
function dismantlePreview(id, qty) {
  const yields = dismantleYield(id);
  if (!yields) return null;
  return {
    name: itemName(id),
    qty,
    parts: Object.entries(yields).map(([pid, n]) => ({
      id: pid, name: itemName(pid), qty: n * qty,
    })),
  };
}

/** 未整理一括廃棄の合計予算 */
function pendingScrapTotal(state) {
  return state.pending.reduce((n, p) => n + itemValue(p.id) * p.qty, 0);
}

/** 未整理一括分解の収率合計。部品自身は除外 */
function pendingDismantleTotal(state) {
  const bag = {};
  let skipped = 0;
  for (const p of state.pending) {
    const y = dismantleYield(p.id);
    if (!y) { skipped += p.qty; continue; }
    for (const [pid, n] of Object.entries(y)) bag[pid] = (bag[pid] || 0) + n * p.qty;
  }
  return {
    parts: Object.entries(bag).map(([id, qty]) => ({ id, name: itemName(id), qty })),
    skipped,
  };
}

/** 倉庫のスロットを分解する */
function dismantleStorageSlot(state, slotIndex, qty) {
  const slot = state.storage[slotIndex];
  if (!slot) return { ok: false, msg: "空きスロットです" };
  const yields = dismantleYield(slot.id);
  if (!yields) return { ok: false, msg: `${itemName(slot.id)} はこれ以上分解できません` };
  const id = slot.id;
  const take = Math.min(slot.qty, qty ?? slot.qty);
  if (slot.uid) dropWeaponLoadout(state, slot.uid);
  slot.qty -= take;
  if (slot.qty <= 0) state.storage[slotIndex] = null;
  const rolled = applyDismantleBonus(state, yields);
  const parts = [];
  for (const [pid, n] of Object.entries(rolled.yields)) {
    const total = n * take;
    const leftover = storageAdd(state, pid, total);
    parts.push(`${itemName(pid)}×${total - leftover}`);
  }
  const extra = rolled.bonus ? ` / 選別 +${itemName(rolled.bonus.id)}×${rolled.bonus.extra}` : "";
  return { ok: true, msg: `${itemName(id)} ×${take} を分解 — ${parts.join(" / ")}${extra}` };
}

function spendStamina(state, amount) {
  applyStaminaRegen(state);
  if (state.stamina < amount) return false;
  state.stamina -= amount;
  state.staminaUpdatedAt = Date.now();
  return true;
}

function addXp(unit, amount) {
  unit.xp = (unit.xp || 0) + amount;
  const cap = maxLevel(unit.rev);
  while (unit.level < cap && unit.xp >= xpForLevel(unit.level)) {
    unit.xp -= xpForLevel(unit.level);
    unit.level++;
  }
}

/** Auto battle simulation */
function runBattle(state, floorData) {
  const log = [];
  const squadUnits = getSquadUnits(state);

  const allies = [
    { ...buildOperatorCombatant(state), id: "a0", catalogId: null },
    ...squadUnits.map((u, i) => {
      const stats = calcStats(u, state);
      const cat = GAME_DATA.catalog[u.catalogId];
      return {
        id: `a${i + 1}`,
        unit: u,
        catalogId: u.catalogId,
        name: `${cat.scp} ${cat.name}`,
        hp: stats.maxHp,
        maxHp: stats.maxHp,
        stats,
        skills: getUnitSkills(u),
        buffs: [],
        alive: true,
        dmgDealt: 0,
        dmgTaken: 0,
      };
    }),
  ];

  const enemies = floorData.enemies.map((e, i) => {
    const cat = GAME_DATA.catalog[e.catalogId];
    const fakeUnit = { catalogId: e.catalogId, level: e.level, rev: 0, bonus: {}, reclass: 0, artifact: null };
    const stats = calcStats(fakeUnit);
    return {
      id: `e${i}`,
      catalogId: e.catalogId,
      name: `${cat.scp} ${cat.name}`,
      hp: stats.maxHp,
      maxHp: stats.maxHp,
      stats,
      skills: getUnitSkills(fakeUnit),
      buffs: [],
      alive: true,
      dmgDealt: 0,
      dmgTaken: 0,
      drops: rollEnemyDrops(floorData),
    };
  });

  const snapFighter = (c) => ({
    id: c.id,
    name: c.name,
    hp: c.hp,
    maxHp: c.maxHp,
    catalogId: c.catalogId || null,
    isOperator: !!c.isOperator,
  });
  const allySnap = allies.map(snapFighter);
  const enemySnap = enemies.map(snapFighter);
  const events = [];

  log.push(`── 区画探索: ${floorData.name} (深度 ${floorData.depth}) ──`);
  events.push({ type: "note", text: log[log.length - 1] });

  const openSiphon = allies.some((a) => a.skills.some((s) => s.onBattleStart === "mass_siphon"));
  if (openSiphon) {
    log.push("[開幕] 全情報吸い上げが発動！");
    events.push({ type: "note", text: log[log.length - 1] });
    for (const en of enemies) {
      if (en.drops.length > 0) {
        log.push(`  ${en.name} から ${en.drops[0].name} を吸い上げた`);
        events.push({ type: "note", text: log[log.length - 1] });
      }
    }
  }

  let turn = 0;
  const maxTurns = 40;
  const stolenItems = [];

  while (turn < maxTurns) {
    turn++;
    const combatants = [
      ...allies.filter((a) => a.alive).map((a) => ({ ...a, side: "ally" })),
      ...enemies.filter((e) => e.alive).map((e) => ({ ...e, side: "enemy" })),
    ].sort((a, b) => b.stats.spd - a.stats.spd);

    let anyAlive = { ally: false, enemy: false };
    for (const c of allies) if (c.alive) anyAlive.ally = true;
    for (const c of enemies) if (c.alive) anyAlive.enemy = true;
    if (!anyAlive.ally || !anyAlive.enemy) break;

    for (const c of combatants) {
      if (!c.alive) continue;
      const targets = c.side === "ally"
        ? enemies.filter((e) => e.alive)
        : allies.filter((a) => a.alive);
      if (targets.length === 0) break;

      const activeSkills = c.skills.filter((s) => s.type === "active");
      const skill = activeSkills.length > 0 ? activeSkills[turn % activeSkills.length] : null;

      if (skill?.steal && c.side === "ally") {
        for (const t of (skill.target === "all" ? targets : [targets[0]])) {
          const mult = c.stats.stealMult || 1;
          if (t.drops && t.drops.length > 0 && Math.random() < 0.3 * mult) {
            const item = t.drops.shift();
            stolenItems.push(item);
            log.push(`${c.name} が ${t.name} から ${item.name} を吸い上げた`);
            events.push({ type: "note", text: log[log.length - 1] });
          }
        }
        continue;
      }

      if (skill?.heal && c.side === "ally") {
        const healTargets = skill.target === "party" ? allies.filter((a) => a.alive) : [c];
        for (const t of healTargets) {
          const amt = Math.floor(t.maxHp * (skill.heal || 0.1));
          t.hp = Math.min(t.maxHp, t.hp + amt);
          log.push(`${c.name} が ${t.name} を ${amt} 回復`);
          events.push({
            type: "heal",
            actorId: c.id,
            targetId: t.id,
            hp: t.hp,
            maxHp: t.maxHp,
            text: log[log.length - 1],
          });
        }
        continue;
      }

      const target = targets[0];
      const atkStat = skill?.element === "anomaly" ? c.stats.anm : c.stats.atk;
      const power = skill?.power || 0.8;
      let dmg = Math.floor(atkStat * power * (0.9 + Math.random() * 0.2));
      const def = target.stats.def;
      dmg = Math.max(1, Math.floor(dmg * (100 / (100 + def * 0.5))));

      const isCrit = Math.random() < (c.stats.crit || 0.05);
      if (isCrit) {
        dmg = Math.floor(dmg * (1 + (c.stats.critDmg || 0.5)));
        log.push(`${c.name} の ${skill?.name || "攻撃"}！ ${target.name} に ${dmg} クリティカル！`);
      } else {
        log.push(`${c.name} の ${skill?.name || "攻撃"} → ${target.name} に ${dmg}`);
      }

      target.hp -= dmg;
      if (target.hp <= 0) {
        target.hp = 0;
        target.alive = false;
      }
      const actor = c.side === "ally"
        ? allies.find((a) => a.id === c.id)
        : enemies.find((e) => e.id === c.id);
      if (actor) actor.dmgDealt = (actor.dmgDealt || 0) + dmg;
      target.dmgTaken = (target.dmgTaken || 0) + dmg;
      events.push({
        type: "hit",
        actorId: c.id,
        targetId: target.id,
        dmg,
        hp: target.hp,
        maxHp: target.maxHp,
        crit: isCrit,
        text: log[log.length - 1],
      });
      if (!target.alive) {
        log.push(`  ${target.name} を無力化`);
        events.push({ type: "ko", targetId: target.id, hp: 0, maxHp: target.maxHp, text: log[log.length - 1] });
      }

      if (c.stats.regen > 0 && c.alive) {
        const r = Math.floor(c.maxHp * c.stats.regen);
        c.hp = Math.min(c.maxHp, c.hp + r);
      }
    }
  }

  const win = enemies.every((e) => !e.alive) && allies.some((a) => a.alive);
  const loot = stolenItems.map((it) => ({
    id: it.id,
    name: it.name || itemName(it.id),
    type: it.type || "material",
    qty: it.qty || 1,
  }));
  const xpGains = [];
  const discoveries = [];
  let budgetGain = 0;

  if (win) {
    log.push("── 探索成功 ──");
    events.push({ type: "end", win: true, text: log[log.length - 1] });
    const dropB = siteDropBonus(state);
    const xpEach = Math.floor(floorData.xpBase * (1 + squadUnits.length * 0.05));
    for (const u of squadUnits) {
      const cat = GAME_DATA.catalog[u.catalogId];
      const before = u.level;
      addXp(u, xpEach);
      xpGains.push({
        catalogId: u.catalogId,
        name: cat.name,
        scp: cat.scp,
        xp: xpEach,
        levelBefore: before,
        levelAfter: u.level,
        unitUid: u.uid,
        xpNow: u.xp || 0,
        xpNeed: xpForLevel(u.level),
      });
      log.push(`${cat.name} +${xpEach} XP (Lv.${u.level})`);
    }

    const budget = Math.floor(floorData.budgetBase * (1 + dropB));
    state.budget += budget;
    budgetGain = budget;
    log.push(`予算 +${budget}`);

    const partQty = 2 + Math.floor(floorData.depth / 6);
    const partId = rollPartDrop(floorData.depth);
    addInventory(state, partId, partQty);
    loot.push({ id: partId, name: itemName(partId), type: "part", qty: partQty });
    log.push(`回収: ${itemName(partId)} ×${partQty}`);

    if (Math.random() < floorData.dropChance + dropB) {
      const objId = rollObjectDrop(floorData.depth);
      addInventory(state, objId);
      loot.push({ id: objId, name: itemName(objId), type: "material", qty: 1 });
      log.push(`回収: ${itemName(objId)}`);
    }

    const linked = new Set();
    for (const e of floorData.enemies || []) {
      const oid = GAME_DATA.objectByCatalog?.[e.catalogId];
      if (oid) linked.add(oid);
    }
    if (floorData.catalogDrop) {
      const oid = GAME_DATA.objectByCatalog[floorData.catalogDrop];
      if (oid) linked.add(oid);
    }
    for (const oid of linked) {
      if (Math.random() >= 0.22 + dropB) continue;
      addInventory(state, oid);
      loot.push({ id: oid, name: itemName(oid), type: "material", qty: 1 });
      log.push(`特異回収: ${itemName(oid)}`);
    }

    if (floorData.catalogDrop && Math.random() < 0.15 + dropB) {
      const cid = floorData.catalogDrop;
      if (!state.discovered.includes(cid)) {
        state.discovered.push(cid);
        const cat = GAME_DATA.catalog[cid];
        discoveries.push({ catalogId: cid, name: `${cat.scp} ${cat.name}` });
        log.push(`新規収容体を発見: ${cat.scp}`);
      }
    }

    const publicArts = GAME_DATA.artifacts.filter((a) => !a.exclusive);
    if (publicArts.length && Math.random() < floorData.artifactChance + dropB * 0.5) {
      const art = publicArts[Math.floor(Math.random() * publicArts.length)];
      addInventory(state, art.id);
      loot.push({ id: art.id, name: art.name, type: "artifact", qty: 1 });
      log.push(`アーティファクト発見: ${art.name}`);
    }

    const exclusiveIds = currentMapSite(state)?.exclusiveDrops;
    if (exclusiveIds?.length && Math.random() < 0.28 + dropB) {
      const specId = rollExclusiveSiteDrop(state);
      if (specId) {
        addInventory(state, specId);
        loot.push({ id: specId, name: itemName(specId), type: itemMeta(specId)?.kind || "material", qty: 1 });
        log.push(`時限回収: ${itemName(specId)}`);
      }
    }

    if (state.floor === floorData.depth && !floorData.holdAdvance) {
      state.floor = Math.min(50, state.floor + 1);
      state.maxFloor = Math.max(state.maxFloor, state.floor);
      log.push(`次の区画が開放: 深度 ${state.floor}`);
    }
  } else {
    log.push("── 探索失敗 ──");
    events.push({ type: "end", win: false, text: log[log.length - 1] });
    log.push("収容体が無力化された。撤退します。");
    events.push({ type: "note", text: log[log.length - 1] });
  }

  for (const item of stolenItems) {
    addInventory(state, item.id);
  }

  const xpByUid = new Map(xpGains.map((g) => [g.unitUid, g]));
  const allyCards = allies.map((c) => {
    const u = c.unit;
    const g = u ? xpByUid.get(u.uid) : null;
    return {
      id: c.id,
      name: c.name,
      catalogId: c.catalogId || null,
      isOperator: !!c.isOperator,
      hp: c.hp,
      maxHp: c.maxHp,
      dmgDealt: c.dmgDealt || 0,
      dmgTaken: c.dmgTaken || 0,
      xpGain: g?.xp || 0,
      xpNow: u ? (u.xp || 0) : 0,
      xpNeed: u ? xpForLevel(u.level) : 0,
      levelBefore: g?.levelBefore ?? u?.level,
      levelAfter: g?.levelAfter ?? u?.level,
    };
  });

  return {
    win, log, loot, events, allies: allySnap, enemies: enemySnap,
    xpGains, budgetGain, discoveries, allyCards,
  };
}

function rollEnemyDrops(floorData) {
  const drops = [];
  if (Math.random() < 0.4) {
    const objId = rollObjectDrop(floorData.depth);
    drops.push({ id: objId, name: itemName(objId), type: "material" });
  }
  if (Math.random() < floorData.artifactChance * 2) {
    const arts = GAME_DATA.artifacts.filter((a) => !a.exclusive);
    if (arts.length) {
      const art = arts[Math.floor(Math.random() * arts.length)];
      drops.push({ id: art.id, name: art.name, type: "artifact" });
    }
  }
  return drops;
}

/** Cross-test synthesis */
function crossTest(state, parentAUid, parentBUid) {
  const a = state.units.find((u) => u.uid === parentAUid);
  const b = state.units.find((u) => u.uid === parentBUid);
  if (!a || !b || a.uid === b.uid) return { ok: false, msg: "親収容体が無効です" };

  const catA = GAME_DATA.catalog[a.catalogId];
  const catB = GAME_DATA.catalog[b.catalogId];

  let childCatalogId = null;
  for (const recipe of GAME_DATA.crossRecipes) {
    const [p1, p2] = recipe.parents;
    if (
      (a.catalogId === p1 && b.catalogId === p2) ||
      (a.catalogId === p2 && b.catalogId === p1)
    ) {
      childCatalogId = recipe.child;
      break;
    }
  }
  if (!childCatalogId) {
    childCatalogId = a.catalogId;
  }

  const expA = xpEarned(a);
  const expB = xpEarned(b);
  const totalExp = expA + expB;
  const revGain = Math.min(5, Math.max(1, Math.floor(totalExp / 500)));

  const parentRev = Math.max(a.rev, b.rev);
  const childRev = parentRev + revGain;

  const bonus = {};
  for (const key of ["hp", "atk", "anm", "def", "spd", "luck"]) {
    bonus[key] = Math.max(a.bonus?.[key] || 0, b.bonus?.[key] || 0);
  }

  const inheritedSkills = mergeSkills(a, b, childCatalogId);

  const child = createUnit(childCatalogId, 1, childRev, bonus);
  child.uid = uid(state);
  child.inheritedSkills = inheritedSkills;

  state.units = state.units.filter((u) => u.uid !== a.uid && u.uid !== b.uid);
  state.squad = state.squad.map((id) => {
    if (id === a.uid || id === b.uid) return child.uid;
    return id;
  }).filter((id, i, arr) => arr.indexOf(id) === i);
  state.chamber = state.chamber.filter((id) => id !== a.uid && id !== b.uid);

  if (!state.discovered.includes(childCatalogId)) {
    state.discovered.push(childCatalogId);
  }

  state.units.push(child);

  const childCat = GAME_DATA.catalog[childCatalogId];
  return {
    ok: true,
    msg: `収容体合成成功: ${childCat.scp} ${childCat.name} (Rev+${revGain} → Rev.${childRev})`,
    child,
    revGain,
  };
}

/** 収容物体合成実験の結果プレビュー。実行はしない。 */
function previewCross(state, parentAUid, parentBUid) {
  const a = state.units.find((u) => u.uid === parentAUid);
  const b = state.units.find((u) => u.uid === parentBUid);
  if (!a || !b || a.uid === b.uid) return null;
  let childCatalogId = a.catalogId;
  let recipe = false;
  for (const rec of GAME_DATA.crossRecipes) {
    const [p1, p2] = rec.parents;
    if (
      (a.catalogId === p1 && b.catalogId === p2) ||
      (a.catalogId === p2 && b.catalogId === p1)
    ) {
      childCatalogId = rec.child;
      recipe = true;
      break;
    }
  }
  const totalExp = xpEarned(a) + xpEarned(b);
  const revGain = Math.min(5, Math.max(1, Math.floor(totalExp / 500)));
  const childRev = Math.max(a.rev, b.rev) + revGain;
  // ゴースト個体。state には載せない。UI のステ／スキル予測専用
  const bonus = {};
  for (const key of ["hp", "atk", "anm", "def", "spd", "luck"]) {
    bonus[key] = Math.max(a.bonus?.[key] || 0, b.bonus?.[key] || 0);
  }
  const ghost = createUnit(childCatalogId, 1, childRev, bonus);
  ghost.inheritedSkills = mergeSkills(a, b, childCatalogId);
  const childStats = calcStats(ghost);
  const skills = getUnitSkills(ghost).map((sk) => ({ id: sk.id, name: sk.name, type: sk.type }));
  return { childCatalogId, recipe, revGain, childRev, childStats, skills };
}

function xpEarned(unit) {
  let total = unit.xp || 0;
  for (let lv = 1; lv < unit.level; lv++) total += xpForLevel(lv);
  return total;
}

function mergeSkills(parentA, parentB, childCatalogId) {
  const childCat = GAME_DATA.catalog[childCatalogId];
  const pool = new Set(childCat.skills);
  for (const p of [parentA, parentB]) {
    const cat = GAME_DATA.catalog[p.catalogId];
    for (const sid of cat.skills) {
      const sk = GAME_DATA.skills[sid];
      if (sk && !sk.unique) pool.add(sid);
    }
  }
  return [...pool].slice(0, 6);
}

/** Catalog new unit from recovery objects */
function catalogUnit(state, catalogId, objects) {
  const cat = GAME_DATA.catalog[catalogId];
  if (!cat) return { ok: false, msg: "不明なカタログID" };
  if (!state.discovered.includes(catalogId)) return { ok: false, msg: "未発見の収容体" };

  const bonus = {};
  const need = {};
  for (const objId of objects) {
    const obj = GAME_DATA.recoveryObjects.find((o) => o.id === objId);
    if (!obj) continue;
    need[objId] = (need[objId] || 0) + 1;
    if (!storageHas(state, objId, need[objId])) return { ok: false, msg: `${obj.name} が不足` };
    for (const [k, v] of Object.entries(obj.bonus)) {
      bonus[k] = (bonus[k] || 0) + v;
    }
  }
  for (const [objId, qty] of Object.entries(need)) {
    storageRemove(state, objId, qty);
  }

  const unit = createUnit(catalogId, 1, 0, bonus);
  unit.uid = uid(state);
  state.units.push(unit);
  return { ok: true, msg: `${cat.scp} ${cat.name} をカタログ化`, unit };
}

/** Reclassify (promote rank) */
function reclassifyUnit(state, unitUid) {
  const unit = state.units.find((u) => u.uid === unitUid);
  if (!unit) return { ok: false, msg: "収容体が見つかりません" };
  const cat = GAME_DATA.catalog[unit.catalogId];
  if (unit.reclass >= cat.rank) return { ok: false, msg: "これ以上再分類できません" };
  const cost = 300 * (unit.reclass + 1);
  if (state.budget < cost) return { ok: false, msg: `予算不足 (要 ${cost})` };
  state.budget -= cost;
  unit.reclass++;
  return { ok: true, msg: `${cat.name} を再分類 (Rank ${unit.reclass})` };
}

/** Training chamber tick */
function chamberTick(state) {
  if (state.chamber.length === 0) return [];
  const logs = [];
  for (const uid of state.chamber) {
    const unit = state.units.find((u) => u.uid === uid);
    if (!unit) continue;
    const xp = 20 + state.siteLevel * 5;
    const prev = unit.level;
    addXp(unit, xp);
    if (unit.level > prev) {
      logs.push(`${GAME_DATA.catalog[unit.catalogId].name} が試験槽で Lv.${unit.level} に`);
    }
  }
  return logs;
}

/** Site upgrade */
function upgradeSite(state) {
  const next = GAME_DATA.siteUpgrades[state.siteLevel];
  if (!next) return { ok: false, msg: "最大レベルです" };
  if (state.budget < next.cost) return { ok: false, msg: `予算不足 (要 ${next.cost})` };
  const lack = materialsLack(state, next.materials);
  if (lack.length) {
    return { ok: false, msg: `${itemName(lack[0].id)} が不足 (要 ${lack[0].need})` };
  }
  state.budget -= next.cost;
  spendMaterials(state, next.materials);
  state.siteLevel++;
  applySiteBonuses(state);
  return { ok: true, msg: `${next.name} に拡張 (作戦司令部Lv.${state.siteLevel})` };
}

/** クラフト可能なもの（部品 T2/T3・収容アイテム・アーティファクト）を一覧化する */
function craftableList() {
  return [...ITEM_INDEX.values()].filter((m) => m.craft);
}

/** 予算・材料・倉庫空きから一度に製作できる最大個数 */
function maxCraftCount(state, outputId) {
  const meta = itemMeta(outputId);
  if (!meta?.craft) return 0;
  let max = Number.MAX_SAFE_INTEGER;
  const unitCost = Math.max(0, Math.floor((meta.craftCost || 0) * (sitePassives(state).craftCost || 1) + 1e-9));
  if (unitCost > 0) max = Math.min(max, Math.floor(state.budget / unitCost));
  for (const [pid, n] of Object.entries(meta.craft)) {
    if (n > 0) max = Math.min(max, Math.floor(storageCount(state, pid) / n));
  }
  if (isPart(outputId)) {
    max = Math.min(max, Math.max(0, state.partStack - storageCount(state, outputId)));
  } else if (meta.kind === "attach" || needsWeaponUid(outputId)) {
    const empty = state.storage.filter((s) => !s).length;
    max = Math.min(max, empty);
  } else {
    const limit = stackLimit(state, outputId);
    let room = 0;
    for (const s of state.storage) {
      if (!s) room += limit;
      else if (s.id === outputId) room += Math.max(0, limit - s.qty);
    }
    max = Math.min(max, room);
  }
  if (!Number.isFinite(max) || max < 1) return 0;
  return max;
}

/**
 * 倉庫の部品・素材からアイテムを製作する。成果物は倉庫へ直接入る。
 * クラフト材料は分解収率より多いので、作って分解するループは常に損になる。
 */
function craftItem(state, outputId, times = 1) {
  const meta = itemMeta(outputId);
  if (!meta?.craft) return { ok: false, msg: "製作できないアイテムです" };
  const cost = Math.max(0, Math.floor((meta.craftCost || 0) * times * (sitePassives(state).craftCost || 1) + 1e-9));
  if (state.budget < cost) return { ok: false, msg: `予算不足 (要 ${cost})` };
  for (const [pid, n] of Object.entries(meta.craft)) {
    if (!storageHas(state, pid, n * times)) {
      return { ok: false, msg: `${itemName(pid)} が不足 (要 ${n * times})` };
    }
  }
  if (isPart(outputId)) {
    if (storageCount(state, outputId) + times > state.partStack) {
      return { ok: false, msg: "基礎部品の所持上限です" };
    }
  } else if (meta.kind === "attach" || needsWeaponUid(outputId)) {
    const empty = state.storage.filter((s) => !s).length;
    if (empty < times) return { ok: false, msg: "倉庫に空きがありません" };
  } else {
    const limit = stackLimit(state, outputId);
    const room = state.storage.reduce((n, s) => {
      if (!s) return n + limit;
      return s.id === outputId ? n + (limit - s.qty) : n;
    }, 0);
    if (room < times) return { ok: false, msg: "倉庫に空きがありません" };
  }

  state.budget -= cost;
  for (const [pid, n] of Object.entries(meta.craft)) {
    storageRemove(state, pid, n * times);
  }
  if (meta.kind === "attach") {
    const made = [];
    for (let i = 0; i < times; i++) {
      const inst = rollAttachInstance(outputId);
      storageAdd(state, outputId, 1, inst);
      made.push(`${rarityStars(inst.rarity)} ${formatAttachStatLine(inst)}`);
    }
    const detail = made.length === 1 ? ` ${made[0]}` : "";
    return { ok: true, msg: `${meta.name} ×${times} を製作${detail}` };
  }
  storageAdd(state, outputId, times);
  return { ok: true, msg: `${meta.name} ×${times} を製作` };
}

/** Equip artifact to unit */
function equipArtifact(state, unitUid, artifactId) {
  const unit = state.units.find((u) => u.uid === unitUid);
  if (!unit) return { ok: false, msg: "収容体が見つかりません" };
  if (!storageHas(state, artifactId)) return { ok: false, msg: "アーティファクトがありません" };
  storageRemove(state, artifactId, 1);
  if (unit.artifact) storageAdd(state, unit.artifact, 1);
  unit.artifact = artifactId;
  return { ok: true, msg: `${itemName(artifactId)} を装備` };
}

/** Sell artifact */
function sellArtifact(state, artifactId) {
  if (!storageHas(state, artifactId)) return { ok: false, msg: "在庫なし" };
  storageRemove(state, artifactId, 1);
  const gain = itemValue(artifactId);
  state.budget += gain;
  return { ok: true, msg: `${itemName(artifactId)} を ${gain} 予算で売却` };
}

function formatStaminaTimer(state) {
  applyStaminaRegen(state);
  if (state.stamina >= state.staminaMax) return "満タン";
  const remain = GAME_DATA.staminaRegenMs - (Date.now() - state.staminaUpdatedAt);
  const sec = Math.ceil(remain / 1000);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")} 後に +1`;
}

/** Total squad combat rating (flavor metric for dashboard) */
function calcSquadPower(state) {
  const op = calcOperatorStats(state);
  let sum = op.hp + op.atk + op.anm + op.def + op.spd;
  for (const u of getSquadUnits(state)) {
    const s = calcStats(u, state);
    sum += s.hp + s.atk + s.anm + s.def + s.spd;
  }
  return sum;
}

function sendChat(state, text, channel = "all") {
  if (!text?.trim()) return false;
  const profile = state.profile || { codename: "Researcher" };
  state.chatLog = state.chatLog || [];
  state.chatLog.push({
    channel,
    user: profile.codename,
    text: text.trim().slice(0, 200),
    ts: Date.now(),
  });
  if (state.chatLog.length > 100) state.chatLog = state.chatLog.slice(-100);
  return true;
}

function migrateState(state) {
  if (!state.profile) {
    state.profile = { codename: newGuestCodename(), clearance: 2, title: "収容担当" };
  }
  // 旧デフォルト名のままの既存セーブは未カスタマイズとみなしてゲスト採番へ（一度きり）
  if (!state.guestCodenameMigrated && state.profile.codename === "D-Class-427") {
    state.profile.codename = newGuestCodename();
    state.guestCodenameMigrated = true;
  }
  // 掃討率制（探索ボタン廃止）への移行
  if (typeof state.clearKills !== "number") state.clearKills = 0;
  if (typeof state.sectorCleared !== "boolean") state.sectorCleared = false;
  if (typeof state.bossActive !== "boolean") state.bossActive = false;
  if (typeof state.boostUntil !== "number") state.boostUntil = 0;
  if (typeof state.breachLosses !== "number") state.breachLosses = 0;
  if (typeof state.breachCooldownUntil !== "number") state.breachCooldownUntil = 0;
  migrateMapSite(state);
  if (!GAME_DATA.mapSites.some((s) => s.id === state.mapSite)) {
    state.mapSite = defaultMapSiteId();
  }
  migrateLimitedRun(state);
  ensureOperatorGear(state);
  if (!Array.isArray(state.battleLog)) state.battleLog = [];
  delete state.lastExplore;
  delete state.equipped;
  delete state.operatorGearLv;
  migrateWeaponUids(state);
  migrateNonGunWeaponStacks(state);
  ensureSiteTree(state);
  normalizeSquad(state);
  if (!Array.isArray(state.sentries)) state.sentries = [];
  else state.sentries = cloneSentries(state.sentries, state);
  if (!Array.isArray(state.revealedRooms)) state.revealedRooms = [];
  if (state.sectorCleared) {
    if (state.floor < 50) {
      state.floor = Math.min(50, state.floor + 1);
      state.maxFloor = Math.max(state.maxFloor, state.floor);
    }
    state.sectorCleared = false;
    state.clearKills = 0;
    state.sentries = [];
    state.revealedRooms = [];
  }
  ensureMapProgress(state);
  snapshotSiteProgress(state);
  migrateStorage(state);
  // 検証用の最大アタッチ配布は migrate では呼ばない（seedMaxAttachmentsForVerify）
  // 旧セーブの全種シードは経済を壊すので呼ばない
  // SYSTEM 通知はチャットに載せない方針のため、旧セーブ分も除去する
  state.chatLog = (state.chatLog || []).filter((m) => m.user !== "SYSTEM" && m.channel !== "alert");
  if (!state.chatLog.length) {
    state.chatLog = [
      { channel: "all", user: "指揮官", text: "異常を戦力化せよ。Thaumiel運用を維持すること。", ts: Date.now() },
    ];
  }
  return state;
}

/**
 * 武器の uid 個体管理への移行（一度きり）。
 * - 装備中・倉庫の武器に uid を採番（スタック済みは1個体ずつへ展開、溢れは未整理へ）
 * - 旧共通ロードアウト（state.weaponLoadout）と旧武器個体アタッチ（.attach）を
 *   装備中武器の uid ロードアウトへ集約し、余剰分は倉庫へ返却する
 */
function migrateWeaponUids(state) {
  ensureWeaponLoadouts(state);
  if (state.migratedWeaponUids) return;
  for (const slot of GAME_DATA.gearSlots) {
    const entry = state.operatorGear?.[slot.id];
    if (entry && typeof entry === "object" && needsWeaponUid(entry.id) && !entry.uid) {
      entry.uid = newGearUid(state);
    }
  }
  // 倉庫の銃を個体へ展開する（配列を組み直すので storageAdd は使わない）
  const expanded = [];
  const overflow = [];
  for (const slot of state.storage || []) {
    if (!slot) continue;
    if (!needsWeaponUid(slot.id)) { expanded.push(slot); continue; }
    if (slot.attach && hasAttachLoadout(slot.attach)) {
      for (const v of Object.values(slot.attach)) {
        if (!v) continue;
        const inst = attachInstOf(v);
        overflow.push({ kind: "attach", id: inst.id, rarity: inst.rarity, rolls: inst.rolls });
      }
      delete slot.attach;
    }
    const n = Math.max(1, slot.qty || 1);
    for (let k = 0; k < n; k++) {
      const one = { id: slot.id, qty: 1, uid: k === 0 && slot.uid ? slot.uid : newGearUid(state) };
      if (slot.lv) one.lv = slot.lv;
      expanded.push(one);
    }
  }
  if (expanded.length <= state.storage.length) {
    state.storage = expanded.concat(new Array(state.storage.length - expanded.length).fill(null));
  } else {
    state.storage = expanded.slice(0, state.storage.length);
    for (const extra of expanded.slice(state.storage.length)) {
      overflow.push({ kind: "gear", id: extra.id, lv: extra.lv || 0, uid: extra.uid });
    }
  }
  // 溢れ分を未整理・倉庫へ退避
  for (const ov of overflow) {
    if (ov.kind === "attach") {
      const inst = { rarity: ov.rarity, rolls: ov.rolls };
      const left = storageAdd(state, ov.id, 1, inst);
      if (left > 0) addInventory(state, ov.id, left);
    } else {
      addInventory(state, ov.id, 1);
    }
  }
  // 装備中武器へ旧設定を集約
  const cur = state.operatorGear?.mainWeapon;
  if (cur && typeof cur === "object" && cur.uid && weaponTypeOf(cur.id) === "gun") {
    const merged = { ...emptyAttachLoadout(), ...(state.weaponLoadouts[cur.uid] || {}) };
    const absorb = (src) => {
      if (!src || typeof src !== "object") return;
      for (const [k, v] of Object.entries(src)) {
        if (!v) continue;
        if (!merged[k]) {
          merged[k] = v;
        } else {
          const inst = attachInstOf(v);
          const left = storageAdd(state, inst.id, 1, inst);
          if (left > 0) addInventory(state, inst.id, left);
        }
      }
    };
    absorb(state.weaponLoadout); // 旧共通ロードアウト
    absorb(cur.attach); // さらに古い武器個体アタッチ
    if (hasAttachLoadout(merged)) state.weaponLoadouts[cur.uid] = merged;
  }
  delete state.weaponLoadout;
  delete state.migratedWeaponLoadout;
  if (cur && typeof cur === "object") delete cur.attach;
  state.migratedWeaponUids = true;
}

/**
 * uid 個体化の対象を銃に限定したことへの修復（一度きり）。
 * 個体化されてしまった刃などを剥がして通常スタックへ再マージし、倉庫の空きを戻す。
 */
function migrateNonGunWeaponStacks(state) {
  if (state.mergedNonGunWeapons) return;
  const out = [];
  for (const slot of state.storage || []) {
    if (!slot) continue;
    if (slot.uid && !needsWeaponUid(slot.id)) {
      dropWeaponLoadout(state, slot.uid);
      delete slot.uid;
    }
    // スタック可能な既存スロットへマージ（uid なし・非アタッチのみ）
    const mergeable = !slot.uid && itemMeta(slot.id)?.kind !== "attach";
    if (mergeable) {
      const limit = stackLimit(state, slot.id);
      const sig = instSignature(slot);
      let left = slot.qty;
      for (const dst of out) {
        if (left <= 0) break;
        if (!dst || dst.id !== slot.id || dst.uid) continue;
        if (dst.qty >= limit || instSignature(dst) !== sig) continue;
        const put = Math.min(limit - dst.qty, left);
        dst.qty += put;
        left -= put;
      }
      if (left <= 0) continue;
      slot.qty = left;
    }
    out.push(slot);
  }
  if (out.length <= state.storage.length) {
    state.storage = out.concat(new Array(state.storage.length - out.length).fill(null));
  } else {
    state.storage = out.slice(0, state.storage.length);
    for (const extra of out.slice(state.storage.length)) {
      addInventory(state, extra.id, extra.qty || 1);
    }
  }
  state.mergedNonGunWeapons = true;
}

/** アイコン確認用。全種が倉庫に 1 個以上あることを保証する */
function seedAllItemsForIconCheck(state) {
  let added = false;
  for (const p of GAME_DATA.parts) {
    if ((state.parts[p.id] || 0) < 1) {
      storageAdd(state, p.id, 1);
      added = true;
    }
  }
  for (const item of [...GAME_DATA.recoveryObjects, ...GAME_DATA.artifacts, ...GAME_DATA.gear]) {
    if (storageCount(state, item.id) < 1) {
      storageAdd(state, item.id, 1);
      added = true;
    }
  }
  if (added) saveGame(state);
}

const SITE_PROGRESS_KEYS = ["floor", "maxFloor", "clearKills", "sectorCleared", "breachLosses", "breachCooldownUntil", "sentries", "revealedRooms"];

function emptySiteProgress() {
  return {
    floor: 1,
    maxFloor: 1,
    clearKills: 0,
    sectorCleared: false,
    breachLosses: 0,
    breachCooldownUntil: 0,
    sentries: [],
    revealedRooms: [],
  };
}

function floorName(n) {
  const d = Math.max(1, Math.min(50, n | 0));
  return GAME_DATA.floors[d - 1].name;
}

const LEGACY_MAP_SITES = {
  hospital: "s8102",
  military: "s8186",
  water: "s8124",
  power: "s8105",
  subway: "s8114",
  harbor: "s8182",
  lab: "s8104",
  comm: "s8181",
  outpost: "s8100",
  sewer: "s8123",
};

function defaultMapSiteId() {
  return GAME_DATA.defaultMapSite || GAME_DATA.mapSites[0].id;
}

/** 旧TOKYO地点IDを日本支部サイトへ移す */
function migrateMapSite(state) {
  const next = LEGACY_MAP_SITES[state.mapSite];
  if (!next) return;
  if (state.mapProgress && state.mapProgress[state.mapSite] && !state.mapProgress[next]) {
    state.mapProgress[next] = state.mapProgress[state.mapSite];
  }
  state.mapSite = next;
}

function enemyPoolForSite(site) {
  const pools = GAME_DATA.siteEnemyPools || {};
  return pools[site?.kind] || pools.mixed || GAME_DATA.floors[0].enemies.map((e) => e.catalogId);
}

/** 現在地点の探索フロア（敵編成は施設 kind 依存） */
function currentFloorData(state) {
  const depth = Math.min(Math.max(1, state.floor | 0), GAME_DATA.floors.length);
  const base = GAME_DATA.floors[depth - 1];
  const site = currentMapSite(state);
  const pool = enemyPoolForSite(site);
  const count = base.enemies.length;
  const lv = base.enemies[0] ? base.enemies[0].level : depth + 2;
  const enemies = [];
  const start = Math.floor((depth - 1) / 3);
  for (let i = 0; i < count; i++) {
    enemies.push({ catalogId: pool[(start + i) % pool.length], level: lv });
  }
  return {
    ...base,
    enemies,
    name: `${site.code}-${depth}/${GAME_DATA.floors.length}`,
  };
}

function ensureMapProgress(state) {
  if (!state.mapProgress || typeof state.mapProgress !== "object") state.mapProgress = {};
  for (const s of GAME_DATA.mapSites) {
    if (!state.mapProgress[s.id] || typeof state.mapProgress[s.id] !== "object") {
      state.mapProgress[s.id] = emptySiteProgress();
      continue;
    }
    const p = state.mapProgress[s.id];
    const d = emptySiteProgress();
    for (const k of SITE_PROGRESS_KEYS) {
      if (k === "sentries") {
        if (!Array.isArray(p.sentries)) p.sentries = [];
        continue;
      }
      if (k === "revealedRooms") {
        if (!Array.isArray(p.revealedRooms)) p.revealedRooms = [];
        continue;
      }
      if (typeof p[k] !== typeof d[k]) p[k] = d[k];
    }
  }
}

function cloneSentries(list, st) {
  const ammoMax = sentryAmmoMaxOf(st);
  return (Array.isArray(list) ? list : []).map((s) => {
    const ammo = typeof s.ammo === "number"
      ? Math.max(0, Math.min(ammoMax, Math.floor(s.ammo)))
      : ammoMax;
    const out = { x: Number(s.x) || 0, y: Number(s.y) || 0, ammo };
    if (ammo <= 0 && typeof s.emptyAtMs === "number") out.emptyAtMs = s.emptyAtMs;
    return out;
  });
}

function cloneRevealedRooms(list) {
  return [...new Set((Array.isArray(list) ? list : []).map(Number).filter((id) => id >= 0))];
}

function copySiteField(key, src, st) {
  if (key === "sentries") return cloneSentries(src.sentries, st);
  if (key === "revealedRooms") return cloneRevealedRooms(src.revealedRooms);
  return src[key];
}

function snapshotSiteProgress(state) {
  ensureMapProgress(state);
  const id = state.mapSite || defaultMapSiteId();
  const snap = {};
  for (const k of SITE_PROGRESS_KEYS) snap[k] = copySiteField(k, state, state);
  state.mapProgress[id] = snap;
}

function applySiteProgress(state, siteId) {
  ensureMapProgress(state);
  const p = state.mapProgress[siteId] || emptySiteProgress();
  for (const k of SITE_PROGRESS_KEYS) state[k] = copySiteField(k, p, state);
  state.mapSite = siteId;
}

function siteProgressOf(state, siteId) {
  ensureMapProgress(state);
  if (siteId === (state.mapSite || defaultMapSiteId())) {
    const live = {};
    for (const k of SITE_PROGRESS_KEYS) live[k] = copySiteField(k, state, state);
    return live;
  }
  return state.mapProgress[siteId] || emptySiteProgress();
}

/** 現在の MAP 展開地点 */
function currentMapSite(state) {
  const id = state.mapSite || defaultMapSiteId();
  return GAME_DATA.mapSites.find((s) => s.id === id) || GAME_DATA.mapSites[0];
}

/** 展開地点を切り替える。各地点の区画進行は独立。時限地点は解放コストを1回消費する */
function selectMapSite(state, siteId, now = Date.now()) {
  const site = GAME_DATA.mapSites.find((s) => s.id === siteId);
  if (!site) return { ok: false, msg: "未知の地点です" };
  if (isLimitedRunActive(state, null, now) && state.limitedRun.siteId !== site.id) {
    return { ok: false, msg: "活動限界まで観測点から離脱できません" };
  }
  if (site.limited && !isLimitedRunActive(state, site.id, now)) {
    const cost = limitedUnlockCost(site);
    const lack = materialsLack(state, cost);
    if (lack.length) {
      return { ok: false, msg: `${itemName(lack[0].id)} が不足しています（要 ${lack[0].need}）` };
    }
    spendMaterials(state, cost);
    beginLimitedRun(state, site, now);
  }
  if ((state.mapSite || defaultMapSiteId()) !== site.id) {
    snapshotSiteProgress(state);
    applySiteProgress(state, site.id);
  }
  state.ospreyAtHq = false;
  saveGame(state);
  return { ok: true, msg: `展開先を ${site.name}（${floorName(state.floor)}）に設定` };
}

function limitedUnlockCost(site) {
  return site?.unlockCost || { p_anomalon: 1, p_cell: 1 };
}

function limitedRunMsOf(site) {
  return site?.limitedRunMs || 600000;
}

/** 活動限界の残り。MM:SS（秒まで） */
function formatRunClock(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

function limitedRunRemainMs(state, now = Date.now()) {
  const run = state?.limitedRun;
  if (!run || typeof run.until !== "number") return 0;
  return Math.max(0, run.until - now);
}

function isLimitedRunActive(state, siteId, now = Date.now()) {
  const run = state?.limitedRun;
  if (!run || limitedRunRemainMs(state, now) <= 0) return false;
  if (siteId && run.siteId !== siteId) return false;
  return true;
}

function limitedRunNeedsExtract(state, now = Date.now()) {
  return !!(state?.limitedRun && limitedRunRemainMs(state, now) <= 0);
}

function isMapSiteOpen(site, state, now = Date.now()) {
  if (!site?.limited) return true;
  return isLimitedRunActive(state, site.id, now);
}

function beginLimitedRun(state, site, now = Date.now()) {
  state.limitedRun = {
    siteId: site.id,
    until: now + limitedRunMsOf(site),
    loot: [],
  };
}

function recordLimitedLoot(state, id, qty = 1) {
  const run = state.limitedRun;
  if (!run || limitedRunRemainMs(state) <= 0) return;
  id = canonicalItemId(id);
  const row = run.loot.find((x) => x.id === id);
  if (row) row.qty += qty;
  else run.loot.push({ id, qty });
}

/** 時限挑戦を閉じ、既定地点へ戻して前線指揮所表示にする */
function concludeLimitedRun(state) {
  const loot = (state.limitedRun?.loot || []).map((x) => ({ id: x.id, qty: x.qty }));
  if (currentMapSite(state)?.limited) {
    snapshotSiteProgress(state);
    applySiteProgress(state, defaultMapSiteId());
  }
  state.limitedRun = null;
  state.ospreyAtHq = true;
  return loot;
}

/** 期限切れの時限地点に居たら既定へ。リザルト用の limitedRun は残す */
function migrateLimitedRun(state, now = Date.now()) {
  if (!state.limitedRun || typeof state.limitedRun !== "object") {
    state.limitedRun = null;
  } else if (!Array.isArray(state.limitedRun.loot)) {
    state.limitedRun.loot = [];
  }
  if (typeof state.ospreyAtHq !== "boolean") state.ospreyAtHq = false;
  const site = currentMapSite(state);
  if (site?.limited && !isLimitedRunActive(state, site.id, now)) {
    snapshotSiteProgress(state);
    applySiteProgress(state, defaultMapSiteId());
  }
}

function rollExclusiveSiteDrop(state) {
  const ids = currentMapSite(state)?.exclusiveDrops;
  if (!ids?.length) return null;
  return ids[Math.floor(Math.random() * ids.length)];
}

/** 次の深度へ進むために必要な撃破数。序盤を軽く、深層をじっくりにする */
function killsNeeded(depth) {
  return 4 + depth * 2;
}

/** 掃討率が満了して収容違反体が出現しうる状態か */
function isBreachReady(state) {
  if (state.sectorCleared) return false;
  if (state.clearKills < killsNeeded(state.floor)) return false;
  return Date.now() >= (state.breachCooldownUntil || 0);
}

/** 連敗時のボス再出現クールダウン。勝てない相手に即リトライを繰り返させない */
function breachCooldownMs(losses) {
  if (losses <= 1) return 0;
  return Math.min(180000, (losses - 1) * 45000);
}

/**
 * 関門で連敗しているときの原因診断。
 * 戦闘は先頭の敵に攻撃が集中するため、数の不利はレベル差では覆せない。
 * @returns {string|null} 連敗していなければ null
 */
function breachAdvice(state) {
  if (!state.breachLosses) return null;
  const squadSize = getSquadUnits(state).length;
  if (squadSize < 5) {
    return `編成が主人公+${squadSize}/5 です。収容個体をカタログ化して5枠を埋めてください。数の不利はレベルでは覆せません。`;
  }
  if (state.units.every((u) => u.rev < 1)) {
    return "拠点の収容体合成で Rev を上げてください。掛け合わせると基礎値が跳ね上がります。";
  }
  if (ownedGearCount(state) < 3) {
    return "主人公の装備が薄いです。拠点の装備制作で装備を作成し、拠点→装備から着用してください。";
  }
  return "拠点強化・再分類・主人公の装備で戦力を底上げしてください。";
}

/**
 * 区画マップ上の接触で発生する小規模戦闘。
 * 通常探索より小さい報酬を展開部隊全体に配り、掃討率を 1 加算する。
 */
function runSkirmish(state, depth) {
  const squad = getSquadUnits(state);
  if (!squad.length) return null;

  const xp = Math.floor((8 + depth * 3) * (0.8 + Math.random() * 0.4));
  for (const u of squad) addXp(u, xp);

  const budget = Math.floor(4 + depth * 2);
  state.budget += budget;

  let item = null;
  const dropB = siteDropBonus(state);
  if (Math.random() < 0.55 + dropB) {
    // 巡回中の交戦では主に基礎部品が拾える
    const partId = rollPartDrop(depth);
    addInventory(state, partId);
    item = itemName(partId);
  } else if (Math.random() < 0.3 + dropB) {
    const objId = rollObjectDrop(depth);
    addInventory(state, objId);
    item = itemName(objId);
  }
  if (currentMapSite(state)?.exclusiveDrops?.length && Math.random() < 0.14 + dropB) {
    const specId = rollExclusiveSiteDrop(state);
    if (specId) {
      addInventory(state, specId);
      item = item ? `${item} / ${itemName(specId)}` : itemName(specId);
    }
  }

  const need = killsNeeded(state.floor);
  if (state.clearKills < need) state.clearKills++;

  return { xp, budget, item, kills: state.clearKills, need };
}

/**
 * フラットな inventory / artifacts をスロット制の倉庫へ移す。
 * 容量が足りない分は未整理領域に残し、プレイヤーに整理させる。
 */
function migrateStorage(state) {
  const defaults = GAME_DATA.storageDefaults;
  if (typeof state.storageSlots !== "number") state.storageSlots = defaults.slots;
  if (typeof state.partStack !== "number") state.partStack = defaults.partStack;
  if (typeof state.itemStack !== "number") state.itemStack = defaults.itemStack;
  if (!Array.isArray(state.pending)) state.pending = [];
  if (!state.parts || typeof state.parts !== "object") state.parts = emptyPartsBag();
  for (const p of GAME_DATA.parts) {
    if (typeof state.parts[p.id] !== "number") state.parts[p.id] = 0;
  }

  if (!Array.isArray(state.storage)) state.storage = [];
  while (state.storage.length < state.storageSlots) state.storage.push(null);
  state.storage.length = Math.max(state.storageSlots, storageUsed(state));

  const legacy = [
    ...Object.entries(state.inventory || {}),
    ...Object.entries(state.artifacts || {}),
  ];
  for (const [id, qty] of legacy) {
    const cid = canonicalItemId(id);
    if (!itemMeta(cid) || qty <= 0) continue;
    const leftover = storageAdd(state, cid, qty);
    if (leftover > 0) addInventory(state, cid, leftover);
  }
  delete state.inventory;
  delete state.artifacts;

  // 倉庫スロットに混ざっている基礎部品・廃止IDを専用袋へ移す
  for (let i = 0; i < state.storage.length; i++) {
    const slot = state.storage[i];
    if (!slot) continue;
    slot.id = canonicalItemId(slot.id);
    if (!isPart(slot.id)) continue;
    storageAdd(state, slot.id, slot.qty);
    state.storage[i] = null;
  }
  for (const p of state.pending) p.id = canonicalItemId(p.id);
  // 廃止キーが parts に残っていれば合算
  for (const [oldId, newId] of Object.entries(GAME_DATA.partAlias)) {
    if (state.parts[oldId]) {
      storageAdd(state, newId, state.parts[oldId]);
      delete state.parts[oldId];
    }
  }
  migrateAttachInstances(state);
  return state;
}

/** 旧スタックのアタッチを個体（レア＋ロール）へバラす */
function migrateAttachInstances(state) {
  const extras = [];
  for (let i = 0; i < state.storage.length; i++) {
    const slot = state.storage[i];
    if (!slot || itemMeta(slot.id)?.kind !== "attach") continue;
    const qty = slot.qty || 1;
    if (slot.rarity && slot.rolls && qty === 1) continue;
    const first = (slot.rarity && slot.rolls) ? { rarity: slot.rarity, rolls: slot.rolls } : rollAttachInstance(slot.id);
    slot.qty = 1;
    slot.rarity = first.rarity;
    slot.rolls = first.rolls;
    for (let n = 1; n < qty; n++) extras.push(rollAttachInstance(slot.id));
  }
  for (const inst of extras) {
    const leftover = storageAdd(state, inst.id, 1, inst);
    if (leftover > 0) addInventory(state, inst.id, leftover);
  }
}

/**
 * 収容違反体（区画ボス）との戦闘。勝利で次の深度へ、敗北で掃討率が後退する。
 * 通常戦より 3 レベル高い編成を相手にする。
 */
function runBreachBattle(state) {
  const floorData = currentFloorData(state);
  const bossFloor = {
    ...floorData,
    name: `${floorData.name} 収容違反`,
    enemies: floorData.enemies.map((e) => ({ ...e, level: e.level + 3 })),
    holdAdvance: true,
  };

  const result = runBattle(state, bossFloor);
  state.battleLog = result.log;
  state.lastExplore = { win: result.win, floor: floorData.depth, time: Date.now() };
  state.bossActive = false;

  if (result.win) {
    state.clearKills = 0;
    state.breachLosses = 0;
    state.breachCooldownUntil = 0;
    state.sectorCleared = false;
    if (state.floor >= 50) {
      result.advancedTo = null;
      result.log.push("最深区画を制圧した。");
    } else {
      state.floor = Math.min(50, state.floor + 1);
      state.maxFloor = Math.max(state.maxFloor, state.floor);
      result.advancedTo = state.floor;
      result.log.push(`${floorName(state.floor)} へ自動進出。`);
      state.sentries = [];
      state.revealedRooms = [];
    }
  } else {
    // 全部溜め直しはだるいが、即リトライだと関門にならないので半分戻す
    state.clearKills = Math.floor(killsNeeded(floorData.depth) * 0.5);
    state.breachLosses = (state.breachLosses || 0) + 1;
    state.breachCooldownUntil = Date.now() + breachCooldownMs(state.breachLosses);
    const advice = breachAdvice(state);
    if (advice) state.battleLog.push(`[診断] ${advice}`);
  }

  const chamberLogs = chamberTick(state);
  if (chamberLogs.length) state.battleLog.push(...chamberLogs.map((l) => `[試験槽] ${l}`));

  saveGame(state);
  return result;
}

/** 許可証で掃討率を即座に満了させる（キル報酬は得られない） */
function forceBreach(state) {
  if (state.sectorCleared) return { ok: false, msg: "すでにこの区画は制圧済みです" };
  if (isBreachReady(state)) return { ok: false, msg: "すでに制圧率は MAX です" };
  if (!spendStamina(state, 5)) return { ok: false, msg: "許可証が不足しています (要5)" };
  state.clearKills = killsNeeded(state.floor);
  saveGame(state);
  return { ok: true, msg: "強行突入: 制圧率 MAX — BOSS挑戦が可能" };
}

/** 許可証で巡回速度を一定時間だけ上げる */
function boostSector(state) {
  if (!spendStamina(state, 1)) return { ok: false, msg: "許可証が不足しています" };
  const base = Math.max(Date.now(), state.boostUntil || 0);
  state.boostUntil = base + SECTOR_BOOST_MS;
  saveGame(state);
  return { ok: true, msg: "緊急展開: 巡回速度 ×2（60秒）" };
}

function sectorSpeedMult(state) {
  const boost = (state.boostUntil || 0) > Date.now() ? 2 : 1;
  return boost * (sitePassives(state).reconSpeed || 1);
}

/** ボス撃破後に次深度へ進む */
function advanceSector(state) {
  if (!state.sectorCleared) return { ok: false, msg: "まだこの区画を制圧していません" };
  if (state.floor >= 50) return { ok: false, msg: "最深区画です" };
  state.floor = Math.min(50, state.floor + 1);
  state.maxFloor = Math.max(state.maxFloor, state.floor);
  state.sectorCleared = false;
  state.clearKills = 0;
  state.bossActive = false;
  state.sentries = [];
  state.revealedRooms = [];
  saveGame(state);
  return { ok: true, msg: `深度 ${state.floor} へ前進` };
}
